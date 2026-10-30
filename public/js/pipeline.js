// Mask post-processing + compositing. Everything draws on a single output canvas.
import { segmentML, segmentChroma } from './engines.js';

const mk = () => document.createElement('canvas');

export class Pipeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.small = mk();
    this.big = mk();
    this.cut = mk();
    this.raw = null;
    this.smooth = null;
    this.cacheKey = '';
    this.bgImage = null;
  }

  resize(w, h) {
    for (const c of [this.canvas, this.big, this.cut]) { c.width = w; c.height = h; }
    this.W = w; this.H = h;
    this.reset();
  }

  reset() { this.smooth = null; this.cacheKey = ''; }

  // Engine step. Cached while paused on same frame so slider drags are cheap.
  getRaw(video, p, force) {
    const key = [video.currentTime, p.engine, p.classes.join(), p.keyColor, p.keySim, p.keySmooth].join('|');
    if (!force && video.paused && key === this.cacheKey && this.smooth) return;
    this.cacheKey = key;
    this.raw = p.engine === 'chroma'
      ? segmentChroma(video, p, this.raw?.w === 480 ? this.raw : null)
      : segmentML(p.engine, video, p.classes, this.raw);
    const { w, h, data } = this.raw;
    if (!this.smooth || this.smooth.length !== data.length) this.smooth = new Float32Array(data);
    else {
      const t = p.temporal, s = this.smooth;
      for (let i = 0; i < data.length; i++) s[i] = s[i] * t + data[i] * (1 - t);
    }
    this.sw = w; this.sh = h;
  }

  buildMask(p) {
    const { sw: w, sh: h, smooth: m } = this;
    if (this.small.width !== w || this.small.height !== h) { this.small.width = w; this.small.height = h; }
    const sctx = this.small.getContext('2d');
    const img = sctx.createImageData(w, h);
    const px = img.data;
    const c = 0.5 - p.edgeShift, half = Math.max(0.005, p.softness / 2);
    const lo = c - half, span = half * 2;
    const k = p.strength;
    // p.region: boxes (0..1) of the objects the user chose to keep; the subject only counts inside them
    let reg = null;
    if (p.region) {
      reg = new Uint8Array(w * h);
      for (const b of p.region) {
        const px = b.w * 0.06, py = b.h * 0.04;
        const x0 = Math.max(0, Math.floor((b.x - px) * w)), x1 = Math.min(w, Math.ceil((b.x + b.w + px) * w));
        const y0 = Math.max(0, Math.floor((b.y - py) * h)), y1 = Math.min(h, Math.ceil((b.y + b.h + py) * h));
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            // inside a removed object's box too? give the pixel to whichever centre it is closer to (box-relative)
            let mine = true;
            if (p.exclude) {
              const dm = (((x + 0.5) / w - cx) / b.w) ** 2 + (((y + 0.5) / h - cy) / b.h) ** 2;
              for (const e of p.exclude) {
                const ex = (x + 0.5) / w, ey = (y + 0.5) / h;
                if (ex < e.x || ex > e.x + e.w || ey < e.y || ey > e.y + e.h) continue;
                const de = ((ex - (e.x + e.w / 2)) / e.w) ** 2 + ((ey - (e.y + e.h / 2)) / e.h) ** 2;
                if (de < dm) { mine = false; break; }
              }
            }
            if (mine) reg[y * w + x] = 1;
          }
        }
      }
    }
    for (let i = 0, j = 0; i < m.length; i++, j += 4) {
      let t = (m[i] - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let v = t * t * (3 - 2 * t);
      if (reg && !reg[i]) v = 0;
      if (p.invert) v = 1 - v;
      px[j] = px[j + 1] = px[j + 2] = 255;
      px[j + 3] = (1 - k * (1 - v)) * 255;
    }
    sctx.putImageData(img, 0, 0);

    const bctx = this.big.getContext('2d');
    bctx.clearRect(0, 0, this.W, this.H);
    const f = p.feather, pad = Math.ceil(f * 3);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.filter = f > 0 ? `blur(${f}px)` : 'none';
    bctx.drawImage(this.small, -pad, -pad, this.W + pad * 2, this.H + pad * 2);
    bctx.filter = 'none';
  }

  drawCover(ctx, src, sw, sh) {
    const s = Math.max(this.W / sw, this.H / sh);
    ctx.drawImage(src, (this.W - sw * s) / 2, (this.H - sh * s) / 2, sw * s, sh * s);
  }

  background(ctx, video, p) {
    const { W, H } = this;
    switch (p.bgType) {
      case 'color': ctx.fillStyle = p.bgColor; ctx.fillRect(0, 0, W, H); break;
      case 'gradient': {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, p.bgColor); g.addColorStop(1, p.bgColor2);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
      }
      case 'blur': {
        const b = p.bgBlur, pad = b * 3;
        ctx.filter = `blur(${b}px) brightness(${p.bgDim})`;
        ctx.drawImage(video, -pad, -pad, W + pad * 2, H + pad * 2);
        ctx.filter = 'none'; break;
      }
      case 'image':
        if (this.bgImage) this.drawCover(ctx, this.bgImage, this.bgImage.naturalWidth, this.bgImage.naturalHeight);
        break;
      default: break; // transparent
    }
  }

  // mode: result | original | mask | split
  render(video, p, mode, force = false) {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'original') { ctx.drawImage(video, 0, 0, W, H); return; }
    this.getRaw(video, p, force);
    this.buildMask(p);
    if (mode === 'mask') {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(this.big, 0, 0);
      return;
    }
    const cc = this.cut.getContext('2d');
    cc.globalCompositeOperation = 'source-over';
    cc.clearRect(0, 0, W, H);
    cc.drawImage(video, 0, 0, W, H);
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(this.big, 0, 0);
    cc.globalCompositeOperation = 'source-over';

    this.background(ctx, video, p);
    const fx = [];
    if (p.outline > 0) {
      const o = p.outline;
      for (const [x, y] of [[o, 0], [-o, 0], [0, o], [0, -o]]) fx.push(`drop-shadow(${x}px ${y}px 0 ${p.outlineColor})`);
    }
    if (p.shadow > 0) fx.push(`drop-shadow(0 ${p.shadow * 0.5}px ${p.shadow}px rgba(0,0,0,.55))`);
    ctx.filter = fx.length ? fx.join(' ') : 'none';
    ctx.drawImage(this.cut, 0, 0);
    ctx.filter = 'none';

    if (mode === 'split') {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W / 2, H); ctx.clip();
      ctx.clearRect(0, 0, W / 2, H);
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();
      ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 - 1, 0, 2, H);
    }
  }
}
