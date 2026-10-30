import { Pipeline } from './pipeline.js';
import { ensureEngine, isEngineReady, DEEPLAB_CLASSES, ensureDetector, detectObjects, LABEL_TO_DEEPLAB } from './engines.js';
import { Tracker } from './tracker.js';
import { transcode } from './convert.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const DEFAULTS = {
  engine: 'selfie', classes: [15], strength: 1, edgeShift: 0, softness: 0.2, feather: 1.5, temporal: 0.4, invert: false,
  keyColor: '#00ff00', keySim: 0.3, keySmooth: 0.12,
  bgType: 'transparent', bgColor: '#ffffff', bgColor2: '#c33764', bgBlur: 20, bgDim: 0.85,
  outline: 0, outlineColor: '#ffffff', shadow: 0,
  outMode: 'result', container: 'mp4', scale: 1, fps: 30, bitrate: 8, audio: true,
};
// Quick looks shown to everyone. Each patch fully describes the look so switching never leaves leftovers.
const BASE_LOOK = { engine: 'selfie', strength: 1, invert: false, outline: 0, shadow: 0, outMode: 'result' };
const PRESETS = {
  transparent: { ...BASE_LOOK, bgType: 'transparent', alpha: true },
  blur: { ...BASE_LOOK, bgType: 'blur', bgBlur: 20, alpha: false },
  white: { ...BASE_LOOK, bgType: 'color', bgColor: '#ffffff', alpha: false },
  green: { ...BASE_LOOK, bgType: 'color', bgColor: '#00b140', alpha: false },
  sticker: { ...BASE_LOOK, bgType: 'transparent', outline: 5, outlineColor: '#ffffff', shadow: 12, alpha: true },
};

const STORE = 'cutout-state-3';
let state = { ...DEFAULTS };
try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} };

const video = $('#video');
const canvas = $('#out');
const pipe = new Pipeline(canvas);
let view = 'result';
let exporting = false;
let engineReady = null;
let fileName = 'video';

// ---------- UI binding ----------
function fmtOut(el, v) {
  const k = el.dataset.k;
  if (['strength', 'temporal'].includes(k)) return Math.round(v * 100) + '%';
  if (k === 'edgeShift') return v === 0 ? 'normal' : (v > 0 ? 'wider ' : 'tighter ') + Math.abs(Math.round(v * 100));
  if (['feather', 'bgBlur', 'outline', 'shadow'].includes(k)) return v === 0 ? 'off' : v + 'px';
  return v;
}
function presetActive(name) {
  const p = PRESETS[name];
  return Object.entries(p).every(([k, v]) => k === 'alpha' || state[k] === v);
}
function syncUI() {
  for (const el of $$('[data-k]')) {
    const k = el.dataset.k;
    if (!(k in state)) continue;
    if (el.type === 'checkbox') el.checked = !!state[k];
    else el.value = state[k];
    const out = el.parentElement.querySelector('output');
    if (out && el.type === 'range') out.textContent = fmtOut(el, +state[k]);
  }
  for (const b of $$('[data-set]')) b.classList.toggle('on', String(state[b.dataset.set]) === b.dataset.val);
  for (const b of $$('[data-preset]')) b.classList.toggle('on', presetActive(b.dataset.preset));
  for (const el of $$('[data-show]')) {
    const [k, vals] = el.dataset.show.split(':');
    el.classList.toggle('hidden', !vals.split('|').includes(String(state[k])));
  }
  $('#maskOnly').checked = state.outMode === 'mask';
  $('#canvasWrap').classList.toggle('checker', state.bgType === 'transparent' && view !== 'mask');
  $$('#classes input').forEach((c) => (c.checked = state.classes.includes(+c.value)));
}
const NUM = new Set(['strength', 'edgeShift', 'softness', 'feather', 'temporal', 'keySim', 'keySmooth', 'bgBlur', 'bgDim', 'outline', 'shadow', 'scale', 'fps', 'bitrate']);
async function setKey(k, v) {
  state[k] = NUM.has(k) ? +v : v;
  if (k === 'engine') { if (!state.classes.length) state.classes = [15]; await loadEngine(); }
  if (k === 'scale') applySize();
  syncUI(); save(); requestRender(k === 'engine');
}
for (const el of $$('[data-k]')) {
  el.addEventListener('input', () => setKey(el.dataset.k, el.type === 'checkbox' ? el.checked : el.value));
}
$('#maskOnly').onchange = (e) => setKey('outMode', e.target.checked ? 'mask' : 'result');
$('#advToggle').onclick = () => {
  const open = $('#adv').classList.toggle('hidden') === false;
  $('#advToggle').setAttribute('aria-expanded', open);
  $('#advToggle span').textContent = open ? '▴' : '▾';
};
for (const b of $$('[data-set]')) b.addEventListener('click', () => setKey(b.dataset.set, b.dataset.val));

function applyPreset(name) {
  const { alpha, ...patch } = PRESETS[name];
  Object.assign(state, patch);
  syncUI(); save();
  loadEngine().then(() => requestRender(true));
}
for (const b of $$('[data-preset]')) b.addEventListener('click', () => applyPreset(b.dataset.preset));
$('#classes').append(...DEEPLAB_CLASSES.slice(1).map((name, i) => {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" value="${i + 1}">${name}`;
  l.querySelector('input').onchange = () => {
    state.classes = $$('#classes input:checked').map((c) => +c.value); save(); requestRender(true);
  };
  return l;
}));
$$('[data-bg]').forEach((b) => (b.onclick = () => setKey('bgColor', b.dataset.bg)));
$('#reset').onclick = () => { for (const x of tracker.tracks) x.keep = true; tracker.keepNew = true; whoSig = ''; state = { ...DEFAULTS }; syncUI(); save(); loadEngine().then(() => requestRender(true)); };
$('#bgFile').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => { pipe.bgImage = img; state.bgType = 'image'; syncUI(); save(); requestRender(); };
  img.src = URL.createObjectURL(f);
};
$$('#views button').forEach((b) => (b.onclick = () => {
  view = b.dataset.view;
  $$('#views button').forEach((x) => x.classList.toggle('on', x === b));
  syncUI(); requestRender();
}));

// ---------- engine ----------
function loadEngine() {
  const eng = state.engine;
  busy(true, eng === 'chroma' ? '' : 'Loading model…');
  engineReady = ensureEngine(eng).then(() => busy(false)).catch((e) => { busy(true, 'Model failed: ' + e.message); throw e; });
  return engineReady;
}

// ---------- busy overlay ----------
function busy(on, text = '', progress = null) {
  $('#busy').classList.toggle('hidden', !on || (!text && progress == null));
  $('#busyText').textContent = text;
  $('#busyBar').parentElement.style.display = progress == null ? 'none' : '';
  if (progress != null) $('#busyBar').style.width = Math.round(progress * 100) + '%';
}

// ---------- loading a file ----------
const fileInput = $('#file'), drop = $('#drop');
fileInput.onchange = () => fileInput.files[0] && openFile(fileInput.files[0]);
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => e.dataTransfer.files[0] && openFile(e.dataTransfer.files[0]));
document.addEventListener('paste', (e) => { const f = e.clipboardData?.files?.[0]; if (f) openFile(f); });
$('#newFile').onclick = () => { tracker.reset(); whoSig = ''; $('#who').classList.add('hidden'); $('#fab').hidden = true; $('#panel').classList.add('hidden'); $('.layout').classList.add('empty'); video.pause(); $('#player').classList.add('hidden'); $('#exportCard').classList.add('hidden'); drop.classList.remove('hidden'); fileInput.value = ''; };

function waitVideo(url) {
  return new Promise((resolve, reject) => {
    const done = (ok, err) => { video.onloadeddata = video.onerror = null; clearTimeout(t); ok ? resolve() : reject(err); };
    const t = setTimeout(() => done(false, new Error('timeout')), 15000);
    video.onloadeddata = () => (video.videoWidth ? done(true) : done(false, new Error('no video track')));
    video.onerror = () => done(false, new Error('unsupported'));
    video.src = url;
    video.load();
  });
}

async function openFile(file) {
  fileName = file.name.replace(/\.[^.]+$/, '');
  drop.classList.add('hidden');
  tracker.reset(); whoSig = ''; $('#who').classList.add('hidden');
  $('#fab').hidden = false;
  $('#panel').classList.remove('hidden');
  $('.layout').classList.remove('empty');
  $('#player').classList.remove('hidden');
  $('#exportCard').classList.add('hidden');
  busy(true, 'Opening video…');
  try {
    try {
      await waitVideo(URL.createObjectURL(file));
    } catch {
      const mp4 = await transcode(file, (t) => busy(true, t, 0), (p) => busy(true, 'Converting to MP4…', p));
      await waitVideo(URL.createObjectURL(mp4));
    }
  } catch (e) {
    busy(true, 'Could not read this file: ' + e.message);
    setTimeout(() => $('#newFile').click(), 3000);
    return;
  }
  applySize();
  await loadEngine();
  video.currentTime = 0;
  requestRender(true);
  ensureDetector().then(() => { detectorReady = true; requestRender(true); }).catch((e) => console.warn('detector unavailable', e));
}

function applySize() {
  if (!video.videoWidth) return;
  const s = state.scale;
  pipe.resize(Math.max(2, Math.round(video.videoWidth * s / 2) * 2), Math.max(2, Math.round(video.videoHeight * s / 2) * 2));
}

// ---------- rendering ----------
let rafQueued = false;

// ---------- who / what to keep ----------
const tracker = new Tracker();
const ov = $('#ov');
let detectorReady = false, lastDetAt = 0, lastDetTime = -1, whoSig = '', showBoxes = true;
const usesRegion = () => tracker.tracks.some((t) => !t.keep);

// Which engine the kept objects need: people use the chosen person engine, other objects need DeepLab.
function wantedEngine(base) {
  const kept = tracker.tracks.filter((t) => t.keep);
  return usesRegion() && base.engine !== 'chroma' && kept.some((t) => t.label !== 'person') ? 'deeplab' : base.engine;
}
// UI settings plus the object filter, as the pipeline should see them right now.
function effState(base) {
  if (!usesRegion()) return base;
  const kept = tracker.tracks.filter((t) => t.keep);
  const near = (t) => Math.abs(video.currentTime - t.seen) < 1.5;
  const s = {
    ...base,
    region: kept.filter(near).map((t) => t.box),
    exclude: tracker.tracks.filter((t) => !t.keep && near(t)).map((t) => t.box), // where boxes overlap, the nearer centre wins
  };
  if (wantedEngine(base) === 'deeplab' && base.engine !== 'deeplab' && isEngineReady('deeplab')) {
    s.engine = 'deeplab';
    s.classes = [...new Set(kept.map((t) => LABEL_TO_DEEPLAB[t.label]))];
  }
  return s;
}
async function applySelection() {
  await ensureEngine(wantedEngine(state));
  pipe.reset(); refreshWho(); requestRender(true);
}
function detectStep(force) {
  if (!detectorReady) return;
  const now = performance.now();
  if (!force && (now - lastDetAt < 70 || (video.paused && video.currentTime === lastDetTime))) return;
  lastDetAt = now; lastDetTime = video.currentTime;
  try {
    tracker.update(detectObjects(video).filter((d) => d.label in LABEL_TO_DEEPLAB), video.currentTime, video, video.paused);
    refreshWho();
  } catch (e) { console.warn('detect', e); }
}
function refreshWho() {
  const t = video.currentTime;
  // list what is on screen now (plus anything the user already made a decision about)
  const list = tracker.tracks.filter((x) => x.decided || Math.abs(t - x.seen) < 1.5);
  const sig = JSON.stringify(list.map((x) => [x.id, x.keep, Math.abs(t - x.seen) < 0.4]));
  if (sig === whoSig) return;
  whoSig = sig;
  $('#who').classList.toggle('hidden', !list.length);
  $('#whoChips').replaceChildren(...list.map((x) => {
    const b = document.createElement('button');
    b.className = 'who-chip ' + (x.keep ? 'is-keep' : 'is-removed') + (Math.abs(t - x.seen) < 0.4 ? '' : ' away');
    b.textContent = (x.keep ? '✓ ' : '✕ ') + x.name;
    b.title = x.keep ? 'Kept. Tap to remove' : 'Removed. Tap to keep';
    b.onclick = () => toggleTrack(x);
    return b;
  }));
  const people = list.filter((x) => x.label === 'person').length;
  const others = list.length - people;
  const parts = [];
  if (people) parts.push(people + (people === 1 ? ' person' : ' people'));
  if (others) parts.push(others + (others === 1 ? ' other object' : ' other objects'));
  $('#whoHint').textContent = `Found ${parts.join(' and ')}. Tap one to keep or remove it.`;
}
function toggleTrack(x) { x.keep = !x.keep; x.decided = true; whoSig = ''; applySelection(); }
$('#midBtn').onclick = () => {
  const mid = tracker.middle(video.currentTime);
  if (!mid) { $('#whoHint').textContent = 'No person visible in this frame. Move the video to a frame with people.'; return; }
  for (const x of tracker.tracks) if (x.label === 'person') { x.keep = x === mid; if (Math.abs(video.currentTime - x.seen) < 1.5) x.decided = true; }
  tracker.keepNew = false; // people who walk in later are removed too
  whoSig = ''; applySelection();
};
$('#allBtn').onclick = () => { for (const x of tracker.tracks) x.keep = true; tracker.keepNew = true; whoSig = ''; applySelection(); };
$('#showBoxes').onchange = (e) => { showBoxes = e.target.checked; requestRender(); };

function drawOverlay() {
  const W = pipe.W, H = pipe.H;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const c = ov.getContext('2d');
  c.clearRect(0, 0, W, H);
  if (!showBoxes || exporting || view === 'mask') return;
  const lw = Math.max(2, W / 320);
  c.font = `600 ${Math.round(lw * 5.5)}px system-ui, sans-serif`;
  c.textBaseline = 'top';
  for (const t of tracker.visible(video.currentTime)) {
    const x = t.box.x * W, y = t.box.y * H, w = t.box.w * W, h = t.box.h * H;
    const color = t.keep ? '#16a34a' : '#dc2626';
    c.lineWidth = lw; c.strokeStyle = color; c.setLineDash(t.keep ? [] : [lw * 3, lw * 2]);
    c.strokeRect(x, y, w, h);
    c.setLineDash([]);
    const label = (t.keep ? '✓ ' : '✕ ') + t.name;
    const tw = c.measureText(label).width + lw * 4, th = lw * 8;
    const ly = y - th < 0 ? y : y - th;
    c.fillStyle = color; c.fillRect(x - lw / 2, ly, tw, th);
    c.fillStyle = '#fff'; c.fillText(label, x + lw, ly + lw * 1.2);
  }
}
canvas.addEventListener('click', (e) => {
  if (picking || !showBoxes || exporting) return;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  const hit = tracker.visible(video.currentTime)
    .filter((t) => px >= t.box.x && px <= t.box.x + t.box.w && py >= t.box.y && py <= t.box.y + t.box.h)
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
  if (hit) toggleTrack(hit);
});

let exportState = null; // settings used while exporting (may differ from the UI, e.g. MP4 background fill)
function renderNow(force = false) {
  if (!video.videoWidth || !pipe.W) return;
  try {
    if (showBoxes || usesRegion()) detectStep(force);
    pipe.render(video, effState(exporting && exportState ? exportState : state), exporting ? (state.outMode === 'mask' ? 'mask' : 'result') : view, force);
    drawOverlay();
  } catch (e) { console.error(e); }
}
function requestRender(force = false) {
  if (exporting || !video.paused || rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(async () => { rafQueued = false; await engineReady; renderNow(force); });
}
// rAF, not requestVideoFrameCallback: rVFC barely fires for an offscreen element, which starved the export of frames.
let lastDrawn = -1;
// The recorded picture trails the sound by the time spent processing a frame (+ waiting for the next paint). Delay the audio by that.
const RECORDER_LAG = 0.02;
let renderEma = 0.05, gapEma = 0.04, lastRenderAt = 0;
function trackLatency(t0) {
  const now = performance.now();
  renderEma = renderEma * 0.9 + ((now - t0) / 1000) * 0.1;
  if (lastRenderAt) gapEma = gapEma * 0.9 + ((now - lastRenderAt) / 1000) * 0.1;
  lastRenderAt = now;
  if (audioGraph?.delay) audioGraph.delay.delayTime.setTargetAtTime(Math.min(0.6, RECORDER_LAG + renderEma + gapEma / 2), audioGraph.ac.currentTime, 0.3);
}
function tick() {
  if (video.currentTime !== lastDrawn) {
    lastDrawn = video.currentTime;
    const t0 = performance.now();
    renderNow();
    if (exporting) trackLatency(t0);
    updateTime();
  }
  if (!video.paused && !video.ended) schedule();
}
// timer fallback keeps frames flowing when the browser throttles rAF (partly covered window)
const schedule = () => {
  let fired = false;
  const go = () => { if (!fired) { fired = true; tick(); } };
  requestAnimationFrame(go);
  setTimeout(go, 24);
};

video.addEventListener('play', async () => { $('#play').textContent = '❚❚'; await engineReady; schedule(); });
video.addEventListener('pause', () => { $('#play').textContent = '▶'; requestRender(); });
video.addEventListener('ended', () => { $('#play').textContent = '▶'; });
video.addEventListener('seeked', () => { lastDrawn = -1; pipe.reset(); updateTime(); requestRender(true); });
$('#play').onclick = () => (video.paused ? video.play() : video.pause());
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  if (e.code === 'ArrowRight') video.currentTime += 1 / 30 * (e.shiftKey ? 10 : 1);
  if (e.code === 'ArrowLeft') video.currentTime -= 1 / 30 * (e.shiftKey ? 10 : 1);
});
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTime() {
  const d = video.duration || 0;
  $('#time').textContent = `${mmss(video.currentTime)} / ${mmss(d)}`;
  if (d) $('#seek').value = (video.currentTime / d) * 1000;
}
$('#seek').oninput = (e) => { video.currentTime = (e.target.value / 1000) * video.duration; };
$('#snap').onclick = () => canvas.toBlob((b) => download(b, `${fileName}-frame.png`), 'image/png');

// eyedropper for chroma key
$('#pick').onclick = () => { picking = true; canvas.style.cursor = 'crosshair'; };
let picking = false;
canvas.addEventListener('click', (e) => {
  if (!picking) return;
  picking = false; canvas.style.cursor = '';
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * 8), y = Math.floor((e.clientY - r.top) / r.height * 8);
  const t = document.createElement('canvas'); t.width = t.height = 8;
  const c = t.getContext('2d'); c.drawImage(video, 0, 0, 8, 8);
  const [R, G, B] = c.getImageData(x, y, 1, 1).data;
  state.keyColor = '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('');
  state.engine = 'chroma'; syncUI(); save(); requestRender(true);
});

// ---------- export ----------
const FORMATS = [
  ['video/webm;codecs=vp9,opus', 'WebM VP9 (supports transparency)', 'webm'],
  ['video/webm;codecs=vp8,opus', 'WebM VP8 (supports transparency)', 'webm'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'MP4 H.264 (no transparency)', 'mp4'],
  ['video/webm', 'WebM (default codec)', 'webm'],
].filter(([m]) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));

let audioGraph;
// A suspended AudioContext would stall the element once it is routed through it, so bail out unless it runs.
// The element stays routed to the speakers except while exporting; each export gets a fresh delay + capture node.
async function getAudioStream() {
  if (!audioGraph) {
    const ac = new AudioContext();
    await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 500))]);
    if (ac.state !== 'running') { ac.close(); throw new Error('audio context blocked'); }
    audioGraph = { ac, src: ac.createMediaElementSource(video) };
    audioGraph.src.connect(ac.destination);
  }
  const g = audioGraph;
  await Promise.race([g.ac.resume(), new Promise((r) => setTimeout(r, 500))]);
  g.src.disconnect();
  g.dest = g.ac.createMediaStreamDestination();
  g.delay = g.ac.createDelay(1);
  g.delay.delayTime.value = RECORDER_LAG + renderEma + gapEma / 2;
  g.src.connect(g.delay).connect(g.dest);
  return g.dest.stream;
}
function releaseAudio() {
  const g = audioGraph;
  if (!g || !g.dest) return;
  g.src.disconnect();
  g.delay.disconnect();
  g.dest = g.delay = null;
  g.src.connect(g.ac.destination);
}

let cancelExport = null;
$('#fab').onclick = () => $('#download').click();
const dlg = $('#dlg');
const containerMime = (c) => (c === 'mp4'
  ? FORMATS.find(([m]) => m.includes('mp4'))?.[0]
  : (FORMATS.find(([m]) => m.includes('vp9')) || FORMATS.find(([m]) => m.includes('webm')))?.[0]);
function syncDialog() {
  const c = $('input[name=cont]:checked', dlg).value;
  $('#fillRow').classList.toggle('hidden', !(c === 'mp4' && state.bgType === 'transparent' && state.outMode !== 'mask'));
}
$('#download').onclick = () => {
  if (exporting) { cancelExport?.(); return; }
  if (!video.videoWidth) return;
  $(`input[name=cont][value=${state.container}]`, dlg).checked = true;
  syncDialog();
  dlg.showModal();
};
$$('input[name=cont]', dlg).forEach((r) => (r.onchange = syncDialog));
$('#dlgCancel').onclick = () => dlg.close();
$('#dlgGo').onclick = () => {
  const container = $('input[name=cont]:checked', dlg).value;
  const fill = $('input[name=fill]:checked', dlg).value;
  dlg.close();
  setKey('container', container);
  runExport(container, fill);
};
async function runExport(container, fill) {
  const btn = $('#download');
  await engineReady;
  const nativeMp4 = containerMime('mp4');
  const needTranscode = container === 'mp4' && !nativeMp4; // e.g. Firefox: record WebM, convert to MP4 after
  const mime = (container === 'mp4' && nativeMp4) || containerMime('webm');
  const ext = container === 'mp4' ? 'mp4' : 'webm';
  exportState = { ...state };
  if (container === 'mp4' && state.bgType === 'transparent') { exportState.bgType = 'color'; exportState.bgColor = fill; }
  video.pause();
  video.currentTime = 0;
  await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
  exporting = true;
  pipe.reset();
  btn.textContent = $('#fab').textContent = 'Stop';
  const stream = canvas.captureStream(state.fps);
  if (state.audio) { try { (await getAudioStream()).getAudioTracks().forEach((t) => stream.addTrack(t)); } catch (e) { console.warn(e); } }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: state.bitrate * 1e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let cancelled = false;
  cancelExport = () => { cancelled = true; video.pause(); finish(); };
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    exporting = false; cancelExport = null; btn.textContent = 'Download video'; $('#fab').textContent = 'Download video';
    busy(false);
    releaseAudio();
    rec.state !== 'inactive' && rec.stop();
  };
  rec.onstop = () => {
    if (cancelled) return;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (!needTranscode) return showResult(blob, ext);
    transcode(new File([blob], 'cutout.webm', { type: blob.type }), (t) => busy(true, t, 0), (p) => busy(true, 'Converting to MP4…', p))
      .then((f) => { busy(false); showResult(f, 'mp4'); })
      .catch(() => { busy(false); showResult(blob, 'webm'); });
  };
  let guard = setInterval(() => {
    busy(true, `Processing ${mmss(video.currentTime)} / ${mmss(video.duration)} — keep this tab open`, video.currentTime / video.duration);
  }, 250);
  video.onended = () => { setTimeout(() => { clearInterval(guard); finish(); }, 200); };
  lastRenderAt = 0;
  video.muted = false;
  try { await video.play(); } catch {
    video.muted = true; // autoplay policy: record silently rather than fail
    await video.play();
  }
  // Start recording only once playback runs, so the file has no leading static/silent gap.
  rec.start(500);
  renderNow(true); // paint immediately so the video track gets a frame at t=0, same as the audio
};

function showResult(blob, ext) {
  const url = URL.createObjectURL(blob);
  const card = $('#exportCard');
  const name = `${fileName}-cutout.${ext}`;
  card.classList.remove('hidden');
  card.innerHTML = `<b>Your video is ready</b> <span class="muted">${(blob.size / 1e6).toFixed(1)} MB</span>
    <video controls loop src="${url}"></video>
    <a class="dl" href="${url}" download="${name}">Download ${ext.toUpperCase()}</a>`;
  card.scrollIntoView({ behavior: 'smooth' });
  video.onended = null;
  video.currentTime = 0;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
}

$('#fab').hidden = true;
$('#panel').classList.add('hidden');
$('.layout').classList.add('empty');
syncUI();
