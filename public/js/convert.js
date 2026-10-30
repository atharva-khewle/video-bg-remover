// Fallback for containers/codecs the browser can't play (mkv, avi, flv, wmv, hevc, ...): transcode with ffmpeg.wasm.
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

export async function transcode(file, onStatus, onProgress) {
  onStatus('Loading converter (~30 MB, one time)…');
  const { FFmpeg } = await import('../vendor/ffmpeg/ffmpeg/index.js');
  const { toBlobURL, fetchFile } = await import('../vendor/ffmpeg/util/index.js');
  const ff = new FFmpeg();
  ff.on('progress', ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))));
  await ff.load({
    coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  onStatus('Converting to MP4…');
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
  await ff.writeFile('in' + ext, await fetchFile(file));
  const code = await ff.exec([
    '-i', 'in' + ext,
    '-vf', "scale='min(1280,iw)':-2,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
    '-c:a', 'aac', '-movflags', '+faststart', 'out.mp4',
  ]);
  if (code !== 0) throw new Error('ffmpeg could not read this file');
  const data = await ff.readFile('out.mp4');
  ff.terminate();
  return new File([data.buffer], file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
}
