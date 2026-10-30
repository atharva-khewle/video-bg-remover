// Keeps detections identifiable across frames so "Person 2" stays Person 2 while the video plays.
const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];

export class Tracker {
  constructor() { this.reset(); }
  reset() { this.tracks = []; this.counts = {}; this.nextId = 1; this.keepNew = true; }
  get(id) { return this.tracks.find((t) => t.id === id); }

  // time: media seconds. Tracks unseen for >2s are dropped unless the user decided on them.
  update(dets, time) {
    const pairs = [];
    this.tracks.forEach((t, ti) => dets.forEach((d, di) => {
      if (t.label !== d.label) return;
      const [tx, ty] = center(t.box), [dx, dy] = center(d.box);
      const dist = Math.hypot(tx - dx, ty - dy);
      const score = iou(t.box, d.box) + Math.max(0, 0.25 - dist);
      if (score > 0.05) pairs.push([score, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      const t = this.tracks[ti], b = dets[di].box;
      t.box = { x: t.box.x * 0.4 + b.x * 0.6, y: t.box.y * 0.4 + b.y * 0.6, w: t.box.w * 0.4 + b.w * 0.6, h: t.box.h * 0.4 + b.h * 0.6 };
      t.seen = time; t.score = dets[di].score;
    }
    // new tracks, numbered left to right
    dets.map((d, di) => [d, di]).filter(([, di]) => !usedD.has(di))
      .sort((a, b) => a[0].box.x - b[0].box.x)
      .forEach(([d]) => {
        const n = (this.counts[d.label] = (this.counts[d.label] || 0) + 1);
        this.tracks.push({ id: this.nextId++, label: d.label, name: `${d.label[0].toUpperCase()}${d.label.slice(1)} ${n}`, box: d.box, seen: time, score: d.score, keep: this.keepNew });
      });
    this.tracks = this.tracks.filter((t) => Math.abs(time - t.seen) < 2 || !t.keep);
  }

  visible(time) { return this.tracks.filter((t) => Math.abs(time - t.seen) < 0.4); }
  // the person closest to the horizontal centre of the frame
  middle(time, label = 'person') {
    return this.visible(time).filter((t) => t.label === label)
      .sort((a, b) => Math.abs(center(a.box)[0] - 0.5) - Math.abs(center(b.box)[0] - 0.5))[0];
  }
}
