from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PAPER = ROOT / "paper" / "tii" / "SUBMISSION-IEEE-TII"
RESULTS = ROOT / "bench" / "results"
OUT = PAPER / "Supplementary-File-S6-Evidence.zip"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main():
    entries: list[tuple[Path, str]] = []
    integrated = RESULTS / "20261031034253-1dbo"
    for name in ["report.md", "run.json", "summary.json", "metrics.csv", "agentteam-mission.log", "agentteam-biax.log"]:
        entries.append((integrated / name, f"integrated/{name}"))
    source_data = HERE / "source-data"
    for name in ["integrated-p6-seeds.csv", "biax-single-mission-trajectory.csv"]:
        entries.append((source_data / name, f"analysis/{name}"))
    manuscript = PAPER
    for name in ["p6-seeds.csv", "bopet-trace.csv"]:
        entries.append((manuscript / "resources" / "current-run-data" / name,
                        f"manuscript-source/current-run-data/{name}"))
    entries.append((manuscript / "figures" / "build_current_run_figures.py",
                    "manuscript-source/build_current_run_figures.py"))
    for stem in ["fig-objective-ratios-current-run", "fig-bopet-integration-trace"]:
        for ext in ["pdf", "svg", "png"]:
            name = f"{stem}.{ext}"
            entries.append((manuscript / "resources" / name, f"figures/{name}"))

    missing = [str(path) for path, _ in entries if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing S6 evidence inputs: " + ", ".join(missing))

    output_bytes: list[tuple[str, bytes]] = []
    originals = []
    for path, archive_name in entries:
        raw = path.read_bytes()
        delivered = raw
        if archive_name == "integrated/run.json":
            doc = json.loads(raw.decode("utf-8"))
            originals.append({"archive_path": archive_name, "original_sha256": digest(raw)})
            env = doc.get("env", {})
            if "simDir" in env:
                env["simDir"] = "[redacted local filesystem path]"
            if "awHome" in env:
                env["awHome"] = "[redacted local filesystem path]"
            delivered = (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        output_bytes.append((archive_name, delivered))

    readme = """Supplementary File S6 evidence bundle

Scope: the single integrated deterministic simulator run reported in the
manuscript, with its source data, plotting script, and two separate figures.
The archive contains selected records from the original run directory and
does not include a runtime image.
No physical PLC data are present. The integrated run did not use an LLM harness.

Local absolute paths are redacted from integrated/run.json. Original
SHA-256 values are recorded in S6-EVIDENCE-MANIFEST.json. The
delivered-copy SHA-256 values are listed in SHA256SUMS. This post-hoc manifest
does not establish a run-time signature or freeze for the original integrated
run, whose original directory did not include a SHA256SUMS file.

Reproduction entry point:
  Integrated: node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3

The original records remain in the project under bench/results. The reported
ratios are descriptive fixed-seed simulation outputs. The platform and
simulator were already running, and the execution reused shared platform data.
The BOPET task retained an open optimization record and is presented in the
manuscript as an integration observation.
"""
    manifest = {
        "schema": "supplementary-evidence-delivery/1.0",
        "bundle": "Supplementary-File-S6-Evidence.zip",
        "redactions": originals,
        "files": [{"path": name, "bytes": len(data), "sha256": digest(data)} for name, data in output_bytes],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    output_bytes.extend([
        ("README.txt", readme.encode("utf-8")),
        ("S6-EVIDENCE-MANIFEST.json", manifest_bytes),
    ])
    checksums = "".join(f"{digest(data)}  {name}\n" for name, data in sorted(output_bytes))
    output_bytes.append(("SHA256SUMS", checksums.encode("utf-8")))

    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in output_bytes:
            archive.writestr(name, data)
    print(json.dumps({"zip": str(OUT), "files": len(output_bytes), "bytes": OUT.stat().st_size, "sha256": digest(OUT.read_bytes())}, indent=2))


if __name__ == "__main__":
    main()
