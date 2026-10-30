# Cutout – in-browser video background remover

Remove video backgrounds entirely in the browser. No signup, no server, no upload.

## Features
- Any video format: browser-native playback first, automatic ffmpeg.wasm conversion for MKV/AVI/FLV/WMV/HEVC/etc.
- Engines: person (fast), person (detailed, hair/clothes), objects/animals/vehicles (DeepLab, pick classes), chroma key with eyedropper
- **Strength**: how much background is removed (100% = gone, lower keeps that fraction visible)
- Edge shift, edge softness, feather, temporal smoothing (anti-flicker), invert
- Backgrounds: transparent, solid, gradient, blurred original, custom image
- Outline and drop shadow effects
- Views: result, original, matte, split compare; PNG frame export
- Export transparent WebM (VP9/VP8), MP4, or a black/white matte video; resolution, fps, bitrate, audio options
- Presets, saved settings, keyboard shortcuts (Space, ←/→)

## Stack
Static site, no build step. Segmentation by [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (Apache-2.0, vendored in `public/vendor/mediapipe` with its models in `public/models`). Format fallback by [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (MIT; core loaded from jsDelivr on demand). Compositing and export use Canvas + MediaRecorder.

## Run / deploy
```
npx http-server public
npx wrangler pages deploy public --project-name video-bg-remover
```

Export runs in real time and needs the tab visible. Chromium browsers give the best results (alpha WebM).

MIT licensed.
