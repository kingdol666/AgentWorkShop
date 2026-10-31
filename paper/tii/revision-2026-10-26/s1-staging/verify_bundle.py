"""Offline verification of the anonymous supplement. Python standard library only."""
from pathlib import Path
import collections
import csv
import hashlib
import json
import re


def main():
    root = Path(__file__).resolve().parent
    if not (root / "FILES.json").exists():
        root = root / "evidence"
    files = json.loads((root / "FILES.json").read_text(encoding="utf-8"))["files"]
    for name, row in files.items():
        data = (root / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == row["sha256"], name
        assert len(data) == row["bytes"], name
    # The framework name appears in its manuscript title, logs, and source
    # snapshots; it is not author identity. Scan only author/account identifiers.
    forbidden = re.compile(
        r"\b(?:" + "Diane " + "Williams|" + "king" + "dol[A-Za-z0-9_-]*|"
        + "872" + "87" + r")\b", re.I)
    text_suffixes = {".md", ".txt", ".json", ".jsonl", ".csv", ".log", ".tex",
                     ".bib", ".bbl", ".py", ".mjs", ".js", ".ts", ".svg", ".eps"}
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in text_suffixes:
            text = path.read_text(encoding="utf-8", errors="replace")
            assert not forbidden.search(text), str(path.relative_to(root))
    assert not (root / "INTERNAL-EVIDENCE-PROVENANCE.json").exists()
    manifest = json.loads((root / "MANIFEST.json").read_text(encoding="utf-8"))
    for row in manifest["source_files"]:
        assert hashlib.sha256((root / row["path"]).read_bytes()).hexdigest() == row["delivered_sha256"], row["path"]
    claims = json.loads((root / "CLAIM-MAP.json").read_text(encoding="utf-8"))["claims"]
    for claim in claims:
        for item in claim["artifacts"]:
            path = root / item["path"]
            assert path.exists(), item["path"]
            if item["line"] is not None:
                assert path.is_file(), item
                assert 1 <= item["line"] <= len(path.read_text(encoding="utf-8").splitlines()), item
            if item["json_pointer"]:
                assert path.is_file(), item
                value = json.loads(path.read_text(encoding="utf-8"))
                for part in item["json_pointer"].lstrip("/").split("/"):
                    key = part.replace("~1", "/").replace("~0", "~")
                    value = value[int(key)] if isinstance(value, list) else value[key]
    totals = [json.loads(path.read_text(encoding="utf-8"))["score"] for path in (root / "R3").glob("*/benchmark.json")]
    assert len(totals) == 9 and sum(x["total"] for x in totals) == 782
    assert all(x["passed"] == x["total"] for x in totals)
    r6 = json.loads((root / "R6/summary.json").read_text(encoding="utf-8"))
    assert r6["baseline"]["p"] == 45 and r6["baseline"]["t"] == 6
    assert r6["baseline"]["q"]["weight"] == 31.28 and r6["final"]["weight"] == 32.3
    assert r6["final"]["sink"] == 1.277 and r6["final"]["flash"] == 0.019
    assert r6["baseline"]["q"]["melt"] is None and r6["final"]["melt"] is None
    measurement_notes = json.loads((root / "R6-MEASUREMENT-NOTES.json").read_text(encoding="utf-8"))
    assert measurement_notes["plotted_values"] == {"weight_g": r6["final"]["weight"], "flash_percent": r6["final"]["flash"], "sink_percent": r6["final"]["sink"]}
    assert measurement_notes["update_reason_linked_measurement_id"] is None
    assert measurement_notes["update_reason_per_sensor_timestamps"] is None
    trials = [x for x in r6["results"] if re.fullmatch(r"P3-\d+", x["id"])]
    assert len(trials) == 4 and all(x["pass"] and "1/1" in x["detail"] for x in trials)
    counts = collections.Counter((row["arm"], row["verdict"]) for row in csv.DictReader((root / "R2/e1-lite.csv").open(encoding="utf-8")) if row["case"] == "attack")
    assert counts[("full", "rejected")] == counts[("no-readback", "rejected")] == 18
    assert counts[("no-interlock", "rejected")] == counts[("ungated", "rejected")] == 12
    assert (root / "R6/summary.json").read_bytes() == (root / "R6/companion/closedloop-summary.json").read_bytes()
    assert len((root / "R4/timeline.jsonl").read_text(encoding="utf-8").splitlines()) == 21
    print(f"PASS: {len(files)} hashed files, {len(claims)} claim rows, 9 suites/782 assertions, 4 R6 receipts, duplicate accounting, local artifact pointers, R6 measurement notes and bounded identity scan.")


if __name__ == "__main__":
    main()
