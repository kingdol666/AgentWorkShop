from __future__ import annotations

import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PAPER = ROOT / "paper" / "tii" / "SUBMISSION-IEEE-TII"
SOURCE = PAPER / "Supplementary-File-S5-Evidence.zip"
BACKUP = Path(__file__).resolve().parent / "historical-S5-evidence-before-filter.zip"
OUTPUT = SOURCE
PREFIX = "Supplementary-File-S5-Evidence/"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def include(name: str) -> bool:
    relative = name.removeprefix(PREFIX).replace("\\", "/")
    if relative.startswith("agent-runs/"):
        return False
    if relative.startswith("route-fixture/") or relative.startswith("doc-driven/logs/"):
        return False
    if relative in {
        "doc-driven/full-acceptance-report.md",
        "doc-driven/t4-plugin-tools.json",
        "README.md",
        "SOURCE-MANIFEST.json",
        "SHA256SUMS",
    }:
        return False
    return True


def main() -> None:
    if not BACKUP.exists():
        shutil.copy2(SOURCE, BACKUP)

    with zipfile.ZipFile(SOURCE, "r") as archive:
        source_contents = {
            name: archive.read(name)
            for name in archive.namelist()
            if name.startswith(PREFIX) and include(name)
        }

    contents: dict[str, bytes] = {}
    transformations: dict[str, str] = {}
    for name, raw in source_contents.items():
        delivered = raw
        relative = name.removeprefix(PREFIX).replace("\\", "/")
        if relative == "doc-driven/export-stats.json":
            doc = json.loads(raw.decode("utf-8"))
            doc["dir"] = "[redacted temporary export path]"
            delivered = (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            transformations[name] = sha256(raw)
        contents[name] = delivered

    readme = b"""Supplementary File S5 evidence bundle

This archive contains the selected records used for the document-driven
virtual-line acceptance, deterministic protocol checks, and four scripted
simulator missions summarized in Supplementary File S5. The records
are separate evidence units and are not pooled as repeated trials. All process
observations are from local simulations; no physical-plant data are included.

The local temporary path in the export-statistics record is redacted. The file
manifest lists delivered paths, sizes, and SHA-256 hashes, together with the
source hash for the transformed record.
"""
    contents[PREFIX + "README.md"] = readme

    records = []
    for name, data in sorted(contents.items()):
        record = {"path": name, "bytes": len(data), "sha256": sha256(data)}
        if name in transformations:
            record["source_sha256_before_redaction"] = transformations[name]
            record["redaction"] = "local temporary export path"
        records.append(record)
    manifest = {
        "schema": "tii-supplement-evidence/2",
        "scope": "selected qualified evidence summarized in Supplementary File S5",
        "files": records,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    manifest_name = PREFIX + "S5-EVIDENCE-MANIFEST.json"
    contents[manifest_name] = manifest_bytes

    checksums = "".join(
        f"{sha256(data)}  {name.removeprefix(PREFIX)}\n"
        for name, data in sorted(contents.items())
    ).encode("utf-8")
    contents[PREFIX + "SHA256SUMS"] = checksums

    temporary = OUTPUT.with_name(OUTPUT.stem + ".tmp.zip")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(contents.items()):
            archive.writestr(name, data)
    temporary.replace(OUTPUT)
    print(json.dumps({"output": str(OUTPUT), "entries": len(contents), "sha256": sha256(OUTPUT.read_bytes())}, indent=2))


if __name__ == "__main__":
    main()
