// Keeps detections identifiable over time so "Person 2" stays Person 2.
//  - motion: each track predicts where it will be next
//  - appearance: a small colour fingerprint re-identifies someone after occlusion, flicker or a seek
//  - confirmation: a new detection only becomes a listed object after it persists (or is seen on a still frame)
const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const SPAWN_SCORE = 0.4;
const CONFIRM_HITS = 3;
const MAX_TRACKS = 40;

// Appearance fingerprint: colour histograms of three body stripes (head, chest, hips). Separate stripes keep
// "dark hair + white shirt + jeans" distinguishable from "dark hair + dark shirt + jeans".
const BINS = 5, STRIPES = [[0.0, 0.18, 0.25], [0.18, 0.5, 0.4], [0.5, 0.78, 0.35]]; // [from, to, weight] as fractions of box height
let fc, fx;
function fingerprint(video, b) {
  if (!fc) { fc = document.createElement('canvas'); fc.width = 10; fc.height = 10; fx = fc.getContext('2d', { willReadFrequently: true }); }
  const W = video.videoWidth, H = video.videoHeight;
  const out = [];
  for (const [from, to] of STRIPES) {
    const sx = (b.x + b.w * 0.2) * W, sw = b.w * 0.6 * W;
    const sy = (b.y + b.h * from) * H, sh = b.h * (to - from) * H;
    if (sw < 2 || sh < 2) return null;
    fx.drawImage(video, sx, sy, sw, sh, 0, 0, 10, 10);
    const d = fx.getImageData(0, 0, 10, 10).data;
    const h = new Float32Array(BINS ** 3);
    for (let i = 0; i < d.length; i += 4) h[Math.floor(d[i] / 51.2) * 25 + Math.floor(d[i + 1] / 51.2) * 5 + Math.floor(d[i + 2] / 51.2)]++;
    for (let i = 0; i < h.length; i++) h[i] /= 100;
    out.push(h);
  }
  return out;
}
export const similarity = (a, b) => { // 0.5 when unknown; otherwise weighted Bhattacharyya per stripe, sharpened
  if (!a || !b) return 0.5;
  let total = 0;
  STRIPES.forEach(([, , w], k) => {
    let s = 0;
    for (let i = 0; i < a[k].length; i++) s += Math.sqrt(a[k][i] * b[k][i]);
    total += w * s;
  });
  return total ** 3;
};
const blend = (old, f, r) => old.map((h, k) => h.map((v, i) => v * (1 - r) + f[k][i] * r));

export const _fingerprint = fingerprint;
export class Tracker {
  constructor() { this.reset(); }
  reset() { this.tracks = []; this.pending = []; this.counts = {}; this.nextId = 1; this.keepNew = true; }
  get(id) { return this.tracks.find((t) => t.id === id); }

  // dets: [{label, score, box}] normalised. instant: confirm new objects at once (paused / seeked frame).
  update(dets, time, video, instant = false) {
    const feats = dets.map(() => undefined);
    const featOf = (di) => (feats[di] === undefined ? (feats[di] = fingerprint(video, dets[di].box)) : feats[di]);

    const all = [...this.tracks, ...this.pending];
    const pairs = [];
    all.forEach((t, ti) => dets.forEach((d, di) => {
      if (t.label !== d.label) return;
      const dt = Math.abs(time - t.seen);
      const [dx0, dy0] = center(d.box);
      const pb = dt < 0.5 && dt > 0 ? { ...t.box, x: t.box.x + t.vx * (time - t.seen), y: t.box.y + t.vy * (time - t.seen) } : t.box;
      const [px, py] = center(pb);
      const dist = Math.hypot(px - dx0, py - dy0) / Math.max(t.box.w, t.box.h, 0.05);
      const ov = iou(pb, d.box);
      let s;
      if (dt < 0.6) {
        if (ov < 0.05 && dist > 1.2) return;
        s = 0.55 * ov + 0.25 * Math.max(0, 1 - dist / 1.5) + 0.2 * similarity(t.feat, featOf(di));
      } else {
        // seen long ago, or the video was seeked: rely on looks, loosely on place
        const a = similarity(t.feat, featOf(di));
        if (a < 0.45) return;
        s = 0.75 * a + 0.25 * Math.max(0, 1 - dist / 4);
      }
      if (s > 0.33) pairs.push([s, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);

    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      const t = all[ti], d = dets[di], b = d.box, dt = time - t.seen;
      const [ox, oy] = center(t.box);
      const sm = Math.abs(dt) < 0.6 ? 0.6 : 1; // snap after a long gap
      const nb = { x: t.box.x * (1 - sm) + b.x * sm, y: t.box.y * (1 - sm) + b.y * sm, w: t.box.w * (1 - sm) + b.w * sm, h: t.box.h * (1 - sm) + b.h * sm };
      if (dt > 0.02 && dt < 0.5) {
        const [nx, ny] = center(nb);
        t.vx = t.vx * 0.5 + ((nx - ox) / dt) * 0.5; t.vy = t.vy * 0.5 + ((ny - oy) / dt) * 0.5;
      } else { t.vx = 0; t.vy = 0; }
      t.box = nb; t.score = d.score;
      const f = featOf(di);
      if (f) t.feat = t.feat ? blend(t.feat, f, 0.1) : f;
      if (Math.abs(dt) > 0.01) t.hits++;
      t.seen = time;
    }

    // tentative objects that were not matched are noise
    this.pending = this.pending.filter((t) => usedT.has(all.indexOf(t)));
    // new objects
    dets.forEach((d, di) => {
      if (usedD.has(di) || d.score < SPAWN_SCORE) return;
      this.pending.push({ label: d.label, box: d.box, score: d.score, seen: time, hits: 1, vx: 0, vy: 0, feat: featOf(di), keep: this.keepNew, decided: false });
    });
    // confirm
    const ready = this.pending.filter((t) => instant || t.hits >= CONFIRM_HITS).sort((a, b) => a.box.x - b.box.x);
    for (const t of ready) {
      const n = (this.counts[t.label] = (this.counts[t.label] || 0) + 1);
      t.id = this.nextId++;
      t.name = `${t.label[0].toUpperCase()}${t.label.slice(1)} ${n}`;
      this.tracks.push(t);
    }
    this.pending = this.pending.filter((t) => !ready.includes(t));

    // the same person under two ids: when two tracks sit on top of each other right now, fold the newer into the older
    for (let i = 0; i < this.tracks.length; i++) {
      for (let j = this.tracks.length - 1; j > i; j--) {
        const a = this.tracks[i], b = this.tracks[j];
        if (a.label !== b.label || Math.abs(time - a.seen) > 0.05 || Math.abs(time - b.seen) > 0.05 || iou(a.box, b.box) < 0.5) continue;
        const [old, dup] = a.id < b.id ? [a, b] : [b, a];
        if (dup.decided && !old.decided) { old.keep = dup.keep; old.decided = true; }
        this.tracks.splice(this.tracks.indexOf(dup), 1);
        if (dup === a) { i--; break; }
      }
    }

    // keep memory of everyone (so identity survives), but cap it: forget the oldest undecided ones
    if (this.tracks.length > MAX_TRACKS) {
      this.tracks.sort((a, b) => (b.decided - a.decided) || (Math.abs(time - b.seen) - Math.abs(time - a.seen)));
      this.tracks.length = MAX_TRACKS;
    }
  }

  visible(time) { return this.tracks.filter((t) => Math.abs(time - t.seen) < 0.5); }
  // the person closest to the horizontal centre of the frame
  middle(time, label = 'person') {
    return this.visible(time).filter((t) => t.label === label)
      .sort((a, b) => Math.abs(center(a.box)[0] - 0.5) - Math.abs(center(b.box)[0] - 0.5))[0];
  }
}
