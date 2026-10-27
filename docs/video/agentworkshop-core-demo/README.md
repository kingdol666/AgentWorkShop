# AgentWorkShop Core Demo Video

> **Current production (2026-10-26):** the published 3:00 English-UI promo was re-recorded and is documented in
> [`docs/audit/evidence/2026-10-26-demo-video/report.md`](../../audit/evidence/2026-10-26-demo-video/report.md).
> This folder preserves the earlier 1'07" Kokoro cut and its capture scripts; the scene list and voice notes below
> describe that earlier cut, not the current asset.

Recorded walkthrough for the repository, documentation site, and paper supplement.

## Deliverables

- `docs/site/public/demo/agentworkshop-core-demo.mp4` — 16:9 MP4 with English narration, burned-in English captions, and English/Chinese soft subtitle tracks.
- `docs/site/public/demo/agentworkshop-core-demo.en.vtt` and `agentworkshop-core-demo.zh-Hans.vtt` — web captions for the documentation player.
- `docs/site/public/demo/agentworkshop-core-demo-voiceover.mp3` — narration-only audio.
- `stills/` — four full-interface PNG captures plus two close crops of the mock demo-line card.
- `timeline.json` — scene and narration timing, without local paths or credentials.
- `paper-caption.md` — a caption suitable for a paper's supplementary-video reference.

## Scene sequence

1. Dashboard and system scope.
2. Reusable channel templates.
3. Lead, process engineer, and analyst in the agent-team console.
4. Production-line context.
5. The demo line's node, product, recipe, and standby status.
6. The isolated mock configuration and the untouched Start control.

The line is `Demo Line`; its only control node uses the **Mock PLC simulator**. The line was never started, the recipe was never applied, and no physical device was connected. The video explicitly describes this boundary.
Scenes 1–3 contain short live screen recordings. Scenes 4–6 use slow zooms of the authentic line-management capture; the final two are close crops of that same screen.

## Voice and reuse

The English narration was synthesized locally with Kokoro ONNX, voice `af_bella`, at speed `0.96`. The model weights are Apache-2.0; the `kokoro-onnx` inference package is MIT. Neither model weights nor login credentials are included here. The narration text is in `narration-en.md`; its Chinese translation is in `narration-zh-Hans.md`.

## Reproducing the voice

On Windows, install Python 3.10+ and FFmpeg, then create a local environment and download the two Kokoro assets to a temporary directory. The model is about 325 MB; keep it and the voice file outside the Git checkout.

```powershell
Set-Location docs/video/agentworkshop-core-demo
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install kokoro-onnx numpy soundfile

$ModelDir = Join-Path $env:TEMP 'awshop-kokoro'
New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
Invoke-WebRequest 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0.onnx' -OutFile (Join-Path $ModelDir 'kokoro-v1.0.onnx')
Invoke-WebRequest 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices-v1.0.bin' -OutFile (Join-Path $ModelDir 'voices-v1.0.bin')

$env:KOKORO_MODEL = Join-Path $ModelDir 'kokoro-v1.0.onnx'
$env:KOKORO_VOICES = Join-Path $ModelDir 'voices-v1.0.bin'
$env:AW_VIDEO_BUILD = Join-Path $env:TEMP 'awshop-video-build'
```

## Re-recording

The capture script expects an already running isolated AgentWorkShop instance containing a workspace named `Demo Operations` and a line named `Demo Line`. Set `AW_VIDEO_BASE`, `AW_VIDEO_BUILD`, `AW_DEMO_EMAIL`, and `AW_DEMO_PASSWORD` in the local process environment, then run:

```powershell
.\.venv\Scripts\python.exe pipeline/generate_voice.py --model $env:KOKORO_MODEL --voices $env:KOKORO_VOICES --out $env:AW_VIDEO_BUILD
node pipeline/capture-interface.mjs
node pipeline/build-still-scenes.mjs
node pipeline/render-final.mjs
```

The capture script only authenticates to the local instance, reads the workspace and line identifiers, navigates the dashboard, channel-template, team-console, and line-management views, records screenshots, and selects the existing Agent Lanes view. The last two scenes are crops of the captured mock demo-line card. It does not submit a task, start acquisition, apply a recipe, or issue a control write. Generated browser frames and local credentials belong in a temporary build directory and must not be committed.

The open-weight model and ONNX package are documented by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).
