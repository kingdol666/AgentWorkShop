"""Verify every packaged byte against manifest.json and detect unlisted files."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest.json"
data = json.loads(MANIFEST.read_text(encoding="utf-8"))
listed = data.get("files", {})
errors: list[str] = []

for name, expected in listed.items():
    path = ROOT / Path(name)
    if not path.is_file():
        errors.append(f"missing: {name}")
        continue
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        errors.append(f"hash mismatch: {name}")

actual_files = set()
for path in ROOT.rglob("*"):
    if not path.is_file() or path == MANIFEST:
        continue
    relative = path.relative_to(ROOT)
    if relative.parts[0] == "build" or "__pycache__" in relative.parts or path.suffix == ".pyc":
        continue
    actual_files.add(relative.as_posix())

for name in sorted(actual_files - set(listed)):
    errors.append(f"unlisted: {name}")
for name in sorted(set(listed) - actual_files):
    if not (ROOT / Path(name)).is_file():
        continue
    errors.append(f"stale: {name}")

if data.get("fileCount") != len(listed):
    errors.append("fileCount does not match files map")

if errors:
    print("MANIFEST FAIL")
    for error in errors:
        print(error)
    sys.exit(1)

print(f"MANIFEST PASS: {len(listed)} files, 0 missing/hash/unlisted errors")
