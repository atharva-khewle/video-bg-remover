import { Pipeline } from './pipeline.js';
import { ensureEngine, DEEPLAB_CLASSES } from './engines.js';
import { transcode } from './convert.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const DEFAULTS = {
  engine: 'selfie', classes: [15], strength: 1, edgeShift: 0, softness: 0.2, feather: 1.5, temporal: 0.4, invert: false,
  keyColor: '#00ff00', keySim: 0.3, keySmooth: 0.12,
  bgType: 'transparent', bgColor: '#101820', bgColor2: '#7c5cff', bgBlur: 20, bgDim: 0.8,
  outline: 0, outlineColor: '#ffffff', shadow: 0,
  outMode: 'result', format: '', scale: 1, fps: 30, bitrate: 8, audio: true, checker: true,
};
const PRESETS = {
  'Portrait': { engine: 'selfie', strength: 1, softness: 0.2, feather: 1.5, temporal: 0.4 },
  'Hair detail': { engine: 'multiclass', strength: 1, softness: 0.3, feather: 1, temporal: 0.3 },
  'Soft 60%': { strength: 0.6, feather: 3 },
  'Blur bg': { bgType: 'blur', strength: 1 },
  'Green screen out': { engine: 'chroma', bgType: 'transparent', keyColor: '#00ff00' },
  'Sticker outline': { outline: 4, outlineColor: '#ffffff', shadow: 10 },
  'Studio gradient': { bgType: 'gradient', bgColor: '#1d2671', bgColor2: '#c33764' },
};

let state = { ...DEFAULTS };
try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cutout-state') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('cutout-state', JSON.stringify(state)); } catch {} };

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
  if (['strength', 'temporal', 'softness'].includes(k)) return Math.round(v * 100) + '%';
  if (k === 'edgeShift') return (v > 0 ? '+' : '') + Math.round(v * 100);
  if (['feather', 'bgBlur', 'outline', 'shadow'].includes(k)) return v + 'px';
  return v;
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
  $('#deeplabBox').classList.toggle('hidden', state.engine !== 'deeplab');
  $('#chromaBox').classList.toggle('hidden', state.engine !== 'chroma');
  $('#canvasWrap').classList.toggle('checker', state.checker && view !== 'mask');
  $$('#classes input').forEach((c) => (c.checked = state.classes.includes(+c.value)));
}
const NUM = new Set(['strength', 'edgeShift', 'softness', 'feather', 'temporal', 'keySim', 'keySmooth', 'bgBlur', 'bgDim', 'outline', 'shadow', 'scale', 'fps', 'bitrate']);
for (const el of $$('[data-k]')) {
  el.addEventListener('input', async () => {
    const k = el.dataset.k;
    state[k] = el.type === 'checkbox' ? el.checked : NUM.has(k) ? +el.value : el.value;
    if (k === 'engine') { state.classes = state.classes.length ? state.classes : [15]; await loadEngine(); }
    if (k === 'scale') applySize();
    syncUI(); save(); requestRender(k === 'engine');
  });
}
function applyPatch(patch) {
  Object.assign(state, patch); syncUI(); save();
  loadEngine().then(() => requestRender(true));
}
$('#presets').append(...Object.entries(PRESETS).map(([name, patch]) => {
  const b = document.createElement('button'); b.textContent = name; b.onclick = () => applyPatch(patch); return b;
}));
$('#classes').append(...DEEPLAB_CLASSES.slice(1).map((name, i) => {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" value="${i + 1}">${name}`;
  l.querySelector('input').onchange = () => {
    state.classes = $$('#classes input:checked').map((c) => +c.value); save(); requestRender(true);
  };
  return l;
}));
$$('[data-bg]').forEach((b) => (b.onclick = () => { state.bgType = 'color'; state.bgColor = b.dataset.bg; syncUI(); save(); requestRender(); }));
$('#reset').onclick = () => { state = { ...DEFAULTS }; syncUI(); save(); loadEngine().then(() => requestRender(true)); };
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
$('#newFile').onclick = () => { $('#fab').hidden = true; video.pause(); $('#player').classList.add('hidden'); $('#exportCard').classList.add('hidden'); drop.classList.remove('hidden'); fileInput.value = ''; };

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
  $('#fab').hidden = false;
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
}

function applySize() {
  if (!video.videoWidth) return;
  const s = state.scale;
  pipe.resize(Math.max(2, Math.round(video.videoWidth * s / 2) * 2), Math.max(2, Math.round(video.videoHeight * s / 2) * 2));
}

// ---------- rendering ----------
let rafQueued = false;
function renderNow(force = false) {
  if (!video.videoWidth || !pipe.W) return;
  try { pipe.render(video, state, exporting ? (state.outMode === 'mask' ? 'mask' : 'result') : view, force); }
  catch (e) { console.error(e); }
}
function requestRender(force = false) {
  if (exporting || !video.paused || rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(async () => { rafQueued = false; await engineReady; renderNow(force); });
}
function tick() {
  renderNow();
  updateTime();
  if (!video.paused && !video.ended) schedule();
}
const schedule = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick));

video.addEventListener('play', async () => { $('#play').textContent = '❚❚'; await engineReady; schedule(); });
video.addEventListener('pause', () => { $('#play').textContent = '▶'; requestRender(); });
video.addEventListener('ended', () => { $('#play').textContent = '▶'; });
video.addEventListener('seeked', () => { pipe.reset(); updateTime(); requestRender(true); });
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
const fmtSel = $('#fmt');
fmtSel.innerHTML = FORMATS.map(([m, l]) => `<option value="${m}">${l}</option>`).join('');
if (!FORMATS.some(([m]) => m === state.format)) state.format = FORMATS[0]?.[0] || '';

let audioGraph;
// A suspended AudioContext would stall the element once it is routed through it, so bail out unless it runs.
async function getAudioStream() {
  if (!audioGraph) {
    const ac = new AudioContext();
    await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 500))]);
    if (ac.state !== 'running') { ac.close(); throw new Error('audio context blocked'); }
    const src = ac.createMediaElementSource(video);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    audioGraph = { ac, src, dest };
  }
  await Promise.race([audioGraph.ac.resume(), new Promise((r) => setTimeout(r, 500))]);
  return audioGraph.dest.stream;
}

let cancelExport = null;
$('#fab').onclick = () => $('#exportBtn').click();
$('#exportBtn').onclick = async () => {
  if (exporting) { cancelExport?.(); return; }
  if (!video.videoWidth) return;
  const btn = $('#exportBtn');
  await engineReady;
  const [mime, , ext] = FORMATS.find(([m]) => m === state.format) || FORMATS[0];
  video.pause();
  video.currentTime = 0;
  await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
  exporting = true;
  pipe.reset();
  btn.textContent = $('#fab').textContent = 'Cancel export';
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
    exporting = false; cancelExport = null; btn.textContent = 'Remove background & export'; $('#fab').textContent = 'Export cutout';
    busy(false);
    rec.state !== 'inactive' && rec.stop();
  };
  rec.onstop = () => {
    if (cancelled) return;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    showResult(blob, ext);
  };
  let guard = setInterval(() => {
    busy(true, `Processing ${mmss(video.currentTime)} / ${mmss(video.duration)} — keep this tab open`, video.currentTime / video.duration);
  }, 250);
  video.onended = () => { setTimeout(() => { clearInterval(guard); finish(); }, 200); };
  rec.start(500);
  video.muted = false;
  try { await video.play(); } catch {
    video.muted = true; // autoplay policy: record silently rather than fail
    await video.play();
  }
};

function showResult(blob, ext) {
  const url = URL.createObjectURL(blob);
  const card = $('#exportCard');
  const name = `${fileName}-cutout.${ext}`;
  card.classList.remove('hidden');
  card.innerHTML = `<b>Done</b> <span class="muted">${(blob.size / 1e6).toFixed(1)} MB</span><br><br><video controls loop src="${url}"></video>
    <div class="row"><a href="${url}" download="${name}"><button class="primary" style="width:auto;padding:9px 18px">Download ${name}</button></a></div>`;
  card.scrollIntoView({ behavior: 'smooth' });
  video.onended = null;
  video.currentTime = 0;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
}

$('#fab').hidden = true;
syncUI();
