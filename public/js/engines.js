// Segmentation engines. All run in-browser (MediaPipe WASM/WebGL, or pure canvas math for chroma key).
const ROOT = new URL('../', import.meta.url);

export const DEEPLAB_CLASSES = [
  'background', 'aeroplane', 'bicycle', 'bird', 'boat', 'bottle', 'bus', 'car', 'cat', 'chair', 'cow',
  'dining table', 'dog', 'horse', 'motorbike', 'person', 'potted plant', 'sheep', 'sofa', 'train', 'tv',
];

const MODEL_FILES = {
  selfie: 'models/selfie_segmenter.tflite',
  multiclass: 'models/selfie_multiclass_256x256.tflite',
  deeplab: 'models/deeplab_v3.tflite',
};

let visionPromise;
function loadVision() {
  visionPromise ??= (async () => {
    const mod = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await mod.FilesetResolver.forVisionTasks(new URL('vendor/mediapipe', ROOT).href);
    return { mod, fileset };
  })();
  return visionPromise;
}

const segmenters = {};
export async function ensureEngine(id) {
  if (id === 'chroma' || segmenters[id]) return;
  const { mod, fileset } = await loadVision();
  const make = (delegate) => mod.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL(MODEL_FILES[id], ROOT).href, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  try {
    segmenters[id] = await make('GPU');
  } catch (e) {
    console.warn('GPU delegate failed, using CPU', e);
    segmenters[id] = await make('CPU');
  }
}

let lastTs = 0;
function nextTs() {
  lastTs = Math.max(lastTs + 1, performance.now());
  return lastTs;
}

function ensureOut(out, w, h) {
  if (!out || out.w !== w || out.h !== h) return { w, h, data: new Float32Array(w * h) };
  return out;
}

// Returns {w,h,data} where data[i] in 0..1 = "subject" probability.
export function segmentML(id, video, classes, out) {
  const seg = segmenters[id];
  let result = out;
  seg.segmentForVideo(video, nextTs(), (r) => {
    const masks = r.confidenceMasks;
    const w = masks[0].width, h = masks[0].height;
    result = ensureOut(out, w, h);
    const d = result.data;
    if (id === 'selfie') {
      // single mask: confidence of "background" is the model output, invert to get subject
      const a = masks[0].getAsFloat32Array();
      const sub = masks.length > 1 ? masks[1].getAsFloat32Array() : null;
      if (sub) d.set(sub); else for (let i = 0; i < d.length; i++) d[i] = 1 - a[i];
    } else if (id === 'multiclass') {
      const bg = masks[0].getAsFloat32Array();
      for (let i = 0; i < d.length; i++) d[i] = 1 - bg[i];
    } else {
      const list = classes.length ? classes : [15];
      d.fill(0);
      for (const c of list) {
        const m = masks[c].getAsFloat32Array();
        for (let i = 0; i < d.length; i++) d[i] += m[i];
      }
      for (let i = 0; i < d.length; i++) if (d[i] > 1) d[i] = 1;
    }
  });
  return result;
}

// Chroma key in YCbCr space on a downscaled frame.
let keyCanvas, keyCtx;
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function cbcr(r, g, b) {
  return [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
}
export function segmentChroma(video, p, out) {
  const w = 480, h = Math.max(2, Math.round(480 * video.videoHeight / video.videoWidth));
  if (!keyCanvas) {
    keyCanvas = document.createElement('canvas');
    keyCtx = keyCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (keyCanvas.width !== w || keyCanvas.height !== h) { keyCanvas.width = w; keyCanvas.height = h; }
  keyCtx.drawImage(video, 0, 0, w, h);
  const px = keyCtx.getImageData(0, 0, w, h).data;
  const res = ensureOut(out, w, h);
  const [kr, kg, kb] = hexToRgb(p.keyColor);
  const [kcb, kcr] = cbcr(kr, kg, kb);
  const lo = p.keySim * 128, hi = lo + Math.max(0.5, p.keySmooth * 128);
  const d = res.data;
  for (let i = 0, j = 0; i < d.length; i++, j += 4) {
    const [cb, cr] = cbcr(px[j], px[j + 1], px[j + 2]);
    const dist = Math.hypot(cb - kcb, cr - kcr);
    const t = Math.min(1, Math.max(0, (dist - lo) / (hi - lo)));
    d[i] = t * t * (3 - 2 * t);
  }
  return res;
}
