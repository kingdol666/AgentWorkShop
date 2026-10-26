"""Generate the English narration locally with Kokoro ONNX.

The model and voice files are supplied separately via --model and --voices;
they are intentionally not copied into this repository.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--voices", required=True, type=Path)
    parser.add_argument("--script", type=Path, default=Path(__file__).parents[1] / "narration.json")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    data = json.loads(args.script.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)
    clips_dir = args.out / "clips"
    clips_dir.mkdir(exist_ok=True)
    tts = Kokoro(str(args.model), str(args.voices))
    sample_rate = None
    pause_seconds = float(data.get("pauseSeconds", 0.24))
    pause: np.ndarray | None = None
    segments: list[np.ndarray] = []
    cursor = 0
    scenes_out = []

    for scene in data["scenes"]:
        scene_start = 0.0 if sample_rate is None else cursor / sample_rate
        sentences_out = []
        for index, (text, zh, caption) in enumerate(zip(scene["en"], scene["zh"], scene["enCaption"], strict=True)):
            samples, rate = tts.create(
                text,
                voice=data.get("voice", "af_bella"),
                speed=float(data.get("speed", 0.96)),
                lang="en-us",
            )
            samples = np.asarray(samples, dtype=np.float32).reshape(-1)
            if sample_rate is None:
                sample_rate = int(rate)
                pause = np.zeros(int(sample_rate * pause_seconds), dtype=np.float32)
            if int(rate) != sample_rate:
                raise RuntimeError(f"Inconsistent sample rates: {rate} != {sample_rate}")

            clip_path = clips_dir / f"{scene['id']}-{index + 1:02}.wav"
            sf.write(clip_path, samples, sample_rate, subtype="PCM_16")
            start = cursor / sample_rate
            end = start + (len(samples) / sample_rate)
            segments.append(samples)
            sentences_out.append({
                "en": text,
                "zh": zh,
                "enCaption": caption,
                "start": start,
                "end": end,
                "duration": end - start,
                "audio": str(clip_path),
            })
            cursor += len(samples)

            is_last = index == len(scene["en"]) - 1
            is_last_scene = scene is data["scenes"][-1]
            if not (is_last and is_last_scene):
                assert pause is not None
                segments.append(pause)
                cursor += len(pause)

        rendered_scene = {
            "id": scene["id"],
            "route": scene["route"],
            "start": scene_start,
            "end": cursor / sample_rate,
            "sentences": sentences_out,
        }
        if "sourceStill" in scene:
            rendered_scene["sourceStill"] = scene["sourceStill"]
        scenes_out.append(rendered_scene)

    assert sample_rate is not None
    master = np.concatenate(segments)
    master_path = args.out / "voiceover.wav"
    sf.write(master_path, master, sample_rate, subtype="PCM_16")
    manifest = {
        "title": data["title"],
        "voice": data.get("voice", "af_bella"),
        "sampleRate": sample_rate,
        "duration": len(master) / sample_rate,
        "pauseSeconds": pause_seconds,
        "transitionSeconds": float(data.get("transitionSeconds", 0.38)),
        "voiceover": str(master_path),
        "scenes": scenes_out,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"voice": manifest["voice"], "sampleRate": sample_rate, "duration": manifest["duration"], "scenes": len(scenes_out), "sentences": sum(len(s["sentences"]) for s in scenes_out)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
