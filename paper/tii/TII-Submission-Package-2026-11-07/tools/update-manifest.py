"""Hash the curated IEEE TII package, excluding generated build intermediates."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest.json"


def included_files() -> list[Path]:
    paths = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path == MANIFEST:
            continue
        relative = path.relative_to(ROOT)
        if relative.parts[0] == "build" or "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(ROOT).as_posix())


files = {
    path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in included_files()
}
manifest = {
    "schema": "ieee-tii-curated-package/1.0",
    "revision": "2026-11-07-evidence-reconciled-package",
    "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "packageStatus": "curated_package_snapshot",
    "mainPdfPages": 10,
    "supplementaryPdfPages": 7,
    "fileCount": len(files),
    "hashBasis": "SHA-256 of curated package file bytes; manifest.json and generated build/ files are excluded.",
    "files": files,
}
MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {MANIFEST.name}: {len(files)} files at {manifest['generatedAt']}")
