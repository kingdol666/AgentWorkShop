"""Package the finalized anonymous manuscript and a historical-evidence extension.

Run --self-test while editing. Run --finalized only after the final PDF has
been compiled and checked. Original evidence and the October 20 ZIP are
read-only inputs; only delivery copies receive identity/path redaction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent / "SUBMISSION-IEEE-TII"
REPO = HERE.parents[2]
PRIOR_DATA = HERE.parent / "revision-2026-10-20"
BASE_ZIP = HERE.parent / "final-revision-2026-10-20" / "IEEE-TII-anonymous-evidence.zip"
SOURCE_NAME = "IEEE-TII-manuscript-source-2026-10-24.zip"
EVIDENCE_NAME = "IEEE-TII-anonymous-evidence-2026-10-24.zip"
PDF_NAME = "IEEE-TII-manuscript-2026-10-24.pdf"
REVISION = "2026-10-24"
TEXT_SUFFIXES = {".md", ".txt", ".json", ".jsonl", ".csv", ".log", ".tex",
                 ".bib", ".bbl", ".py", ".mjs", ".js", ".ts", ".svg", ".eps"}
# A drive letter must start a word and have exactly one path separator after
# its colon. In particular, neither the p:/ in http:// nor the s:/ in https://
# is a Windows path. JSON strings are decoded before this rule is applied.
DRIVE_PATH = re.compile(r"(?i)(?<![A-Za-z0-9_])\b[A-Z]:[\\/](?![\\/])[^\s\"<>`]+")
LOCAL_USER = re.compile(r"(?<![:/])/(?:Users|home)/[^/\s\"<>`]+(?:/[^\s\"<>`]+)?")
IDENTITIES = re.compile(r"\b(?:87287|AgentWorkShop|Diane Williams|kingdol666|kingdol)\b", re.I)
REPOSITORY = re.compile(r"https?://github\.com/(?:ABO(?:/[^\s)\"<>]*)?|[A-Za-z0-9_-]+/AgentWorkShop[^\s)\"<>]*)", re.I)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def anonymous_text(value: str) -> str:
    value = DRIVE_PATH.sub("[local-path]", value)
    value = LOCAL_USER.sub("[local-path]", value)
    value = REPOSITORY.sub("[repository-withheld]", value)
    return IDENTITIES.sub("[redacted-identity]", value)


def anonymous_json(value):
    if isinstance(value, str):
        return anonymous_text(value)
    if isinstance(value, list):
        return [anonymous_json(item) for item in value]
    if isinstance(value, dict):
        cleaned = {anonymous_text(key): anonymous_json(item) for key, item in value.items()}
        if len(cleaned) != len(value):
            raise ValueError("Redaction would collapse JSON object keys")
        return cleaned
    return value


def observations(value):
    """Retain numeric/boolean/null leaves and structure, excluding text identity."""
    if isinstance(value, dict):
        return ("object", tuple(observations(item) for item in value.values()))
    if isinstance(value, list):
        return ("array", tuple(observations(item) for item in value))
    if isinstance(value, str):
        return ("text",)
    return (type(value).__name__, value)


def cleaned_copy(path: Path) -> tuple[bytes, dict]:
    raw = path.read_bytes()
    data = raw
    if path.suffix.lower() == ".json":
        original = json.loads(raw.decode("utf-8-sig"))
        cleaned = anonymous_json(original)
        if observations(original) != observations(cleaned):
            raise ValueError("Quantitative/boolean/null JSON observations changed")
        data = json_bytes(cleaned)
    elif path.suffix.lower() in TEXT_SUFFIXES:
        data = anonymous_text(raw.decode("utf-8-sig")).encode("utf-8")
    return data, {
        "original_sha256": sha(raw), "delivered_sha256": sha(data),
        "bytes_original": len(raw), "bytes_delivered": len(data),
        "transformed": raw != data,
        "rule": "identity/local-path redaction in copy; JSON UTF-8 normalization; observations retained",
    }


def privacy_scan(payload: dict[str, bytes]) -> dict:
    failures = []
    for name, data in payload.items():
        if anonymous_text(name) != name:
            failures.append({"entry": name, "surface": "entry name"})
        suffix = Path(name).suffix.lower()
        if suffix in TEXT_SUFFIXES:
            value = data.decode("utf-8", errors="replace")
            # Decode JSON escapes too, rather than missing doubled slashes.
            if suffix == ".json":
                value = json.dumps(json.loads(value), ensure_ascii=False)
                strings = []

                def collect(item):
                    if isinstance(item, str):
                        strings.append(item)
                    elif isinstance(item, dict):
                        for key, val in item.items():
                            strings.append(key)
                            collect(val)
                    elif isinstance(item, list):
                        for val in item:
                            collect(val)
                collect(json.loads(value))
                value = "\n".join(strings)
            if anonymous_text(value) != value:
                failures.append({"entry": name, "surface": "text"})
        elif suffix == ".pdf":
            import pymupdf
            with pymupdf.open(stream=data, filetype="pdf") as doc:
                value = "\n".join(page.get_text() for page in doc)
                value += json.dumps(doc.metadata, ensure_ascii=False)
            if anonymous_text(value) != value:
                failures.append({"entry": name, "surface": "PDF text/metadata"})
        elif suffix == ".png":
            import io
            from PIL import Image
            with Image.open(io.BytesIO(data)) as image:
                value = json.dumps({key: str(val) for key, val in image.info.items()})
            if anonymous_text(value) != value:
                failures.append({"entry": name, "surface": "PNG metadata"})
    if failures:
        raise ValueError("Bounded identity/path scan failed: " + json.dumps(failures))
    return {"passed": True, "entries": len(payload),
            "scope": "explicit identities, local drive/user paths, identifying repository URLs; PDF text/metadata and PNG metadata"}


def self_test() -> None:
    urls = ["http://example.org/a", "https://example.org/a", "https://github.com/IEEE/example"]
    for url in urls:
        assert anonymous_text(url) == url, url
    for path in ["D:/codes/private/file.tex", "C:\\Users\\87287\\file.tex"]:
        assert anonymous_text(path) == "[local-path]", path
    sample = {"url": urls[1], "path": "D:\\codes\\private\\run.json",
              "weight": 31.46, "pass": False, "update": None, "timestamp": 1792787287000}
    result = anonymous_json(sample)
    assert result["url"] == sample["url"]
    assert result["path"] == "[local-path]"
    assert observations(sample) == observations(result)
    assert anonymous_text("timestamp=1792787287000") == "timestamp=1792787287000"
    print("PASS sanitizer: HTTP(S) preserved; Windows paths removed; JSON observations preserved")


def zip_payload(path: Path, payload: dict[str, bytes]) -> None:
    temp = path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 24, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    with zipfile.ZipFile(temp) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(payload)
        assert all(sha(archive.read(name)) == sha(data) for name, data in payload.items())
    temp.replace(path)


def extract_clean_source(source_zip: Path, destination: Path) -> None:
    if destination.exists():
        raise FileExistsError("Clean rebuild destination must not already exist")
    destination.mkdir(parents=True)
    with zipfile.ZipFile(source_zip) as archive:
        for name in archive.namelist():
            member = PurePosixPath(name)
            if member.is_absolute() or ".." in member.parts:
                raise ValueError("Unsafe ZIP path")
            target = destination.joinpath(*member.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))


def active_source_files() -> tuple[dict[str, Path], list[Path]]:
    tex = [PAPER / "main.tex", *sorted((PAPER / "sections").glob("*.tex"))]
    assert len(tex) == 7, "Expected main and six section sources"
    joined = "\n".join(path.read_text(encoding="utf-8") for path in tex)
    figures = [PAPER / item for item in re.findall(r"\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}", joined)]
    assert len(figures) == 5 and len(set(figures)) == 5, "Expected five active figures"
    local = [*tex, PAPER / "main.pdf", PAPER / "main.bbl", *figures,
             *(path.with_suffix(".svg") for path in figures),
             PAPER / "resources/fig-architecture-2026.eps", PAPER / "resources/fig-runtime-2026.eps",
             PAPER / "resources/refs.bib", PAPER / "resources/results-macros.tex",
             PAPER / "figures/make-system-2026.py", PAPER / "figures/make-evaluation-2026.py",
             PAPER / "README.md", PAPER / "REPRODUCIBILITY.md", PAPER / "CLAIM-EVIDENCE-LEDGER.md"]
    files = {path.relative_to(PAPER).as_posix(): path for path in local}
    files.update({"figure-source-data/" + path.name: path
                  for pattern in ("source-data-*.json", "source-data-*.csv")
                  for path in sorted(PRIOR_DATA.glob(pattern))})
    assert any(name.startswith("figure-source-data/") for name in files), "Missing figure source data"
    files["requirements/IEEE-TII-REQUIREMENTS.md"] = HERE / "requirements/IEEE-TII-REQUIREMENTS.md"
    for name in ("fig1-prompt.txt", "fig2-prompt.txt", "fig1-generated-concept.png", "fig2-generated-concept.png"):
        files["figure-design/" + name] = HERE / "figures" / name
    missing = [name for name, path in files.items() if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing source-package inputs: " + repr(missing))
    return files, figures


def source_package() -> tuple[dict[str, bytes], dict, int]:
    import pymupdf
    files, figures = active_source_files()
    pdf_path = PAPER / "main.pdf"
    dependencies = [path for name, path in files.items()
                    if name.endswith(".tex") or name in {"resources/refs.bib"} or path in figures]
    stale = [path.relative_to(PAPER).as_posix() for path in dependencies
             if path.stat().st_mtime_ns > pdf_path.stat().st_mtime_ns]
    if stale:
        raise ValueError("PDF predates manuscript/figure inputs; compile before packaging: " + repr(stale))
    with pymupdf.open(pdf_path) as doc:
        pages = len(doc)
    assert 1 <= pages <= 10, f"Expected at most 10 pages, got {pages}"
    payload, origins = {}, {}
    for name, path in files.items():
        payload[name], origins[name] = cleaned_copy(path)
    assert payload["resources/refs.bib"] == (PAPER / "resources/refs.bib").read_bytes(), "Citation metadata must be byte-identical"
    assert payload["main.bbl"] == (PAPER / "main.bbl").read_bytes(), "Rendered references must be byte-identical"
    payload["figure-design/README.md"] = (
        "# Figure design provenance\n\nThe two PNGs are AI-generated composition drafts, not final manuscript figures. "
        "Their prompts are retained for provenance. Final Figures 1 and 2 are the editable vector PDF/SVG/EPS "
        "artwork in resources/, redrawn with the Python source in figures/. "
        "Scientific labels and route semantics were checked against the implementation. "
        "Quantitative experimental figures use archived observations rather than image generation.\n"
    ).encode("utf-8")
    payload["EVIDENCE-PACKAGE.txt"] = (
        f"Experimental evidence is separately delivered in {EVIDENCE_NAME}. It preserves the "
        "October 20 anonymous bundle and adds October 23 failed boundary checks plus the October 24 "
        "isolated software rerun under revision-2026-10-24/. No new plant experiment was performed "
        "during this manuscript revision.\n"
    ).encode("utf-8")
    manifest = {"entrypoint": "main.tex", "output": "main.pdf", "pages": pages,
                "recorded_on": REVISION, "files": {name: sha(data) for name, data in sorted(payload.items())}}
    payload["FILE-MANIFEST.json"] = json_bytes(manifest)
    privacy_scan(payload)
    return payload, origins, pages


def boundary_checks(r11: dict, r12: dict) -> dict:
    mission = next(item["mission"] for item in r11["results"] if item["id"] == "injection")
    assert mission["rounds"] == 8 and mission["writes"] == 0 and mission["attained"] is False
    assert mission["final"] == 31.25
    attempts = sum(bool(re.match(r"iter\d+:", event)) for event in mission["ev"])
    assert attempts == 8
    checks = {item["id"]: item for item in r12["results"]}
    assert r12["finalOk"] is False and r12["update"] is None
    assert checks["P3-1"]["pass"] is True and "1/1" in checks["P3-1"]["detail"]
    assert all(checks[key]["pass"] is False for key in ("P3-2", "P4", "P5", "P6"))
    assert r12["final"]["weight"] == 31.46 and r12["final"]["sink"] == 1.837
    assert sum(item["pass"] for item in r12["results"]) == 4
    return {"R11": {"attempts": attempts, "writes": mission["writes"], "attained": mission["attained"], "final_weight_g": mission["final"]},
            "R12": {"verified_pressure_trials": 1, "finalOk": r12["finalOk"], "update": r12["update"],
                    "restoration_assertion_passed": checks["P6"]["pass"], "passing_assertions": 4,
                    "total_assertions": len(r12["results"]), "final_weight_g": r12["final"]["weight"],
                    "final_sink_percent": r12["final"]["sink"]}}


def evidence_package() -> tuple[dict[str, bytes], dict, dict]:
    with zipfile.ZipFile(BASE_ZIP) as base:
        assert base.testzip() is None
        payload = {name: base.read(name) for name in base.namelist()}
    base_hashes = {name: sha(data) for name, data in payload.items()}
    # The historical ZIP is untouched. Its delivered copy needs one narrowly
    # scoped metadata privacy repair and the corresponding chained hashes.
    changed_base = {}
    manifest_name = "derived-figures/source-data-manifest.json"
    raw_manifest = payload[manifest_name]
    derived_manifest = json.loads(raw_manifest)
    assert "D:/anaconda3/python.exe" in derived_manifest["execution"]
    derived_manifest["execution"] = derived_manifest["execution"].replace("D:/anaconda3/python.exe", "[local-runtime]")
    payload[manifest_name] = json_bytes(derived_manifest)
    assert observations(json.loads(raw_manifest)) == observations(derived_manifest)
    metadata_manifest = json.loads(payload["MANIFEST.json"])
    records = [item for item in metadata_manifest["source_files"] if item["path"] == manifest_name]
    assert len(records) == 1
    records[0]["delivered_sha256"] = sha(payload[manifest_name])
    records[0]["delivered_bytes"] = len(payload[manifest_name])
    records[0].setdefault("transformations", {})["revision_2026_10_24_local_runtime_redaction"] = 1
    payload["MANIFEST.json"] = json_bytes(metadata_manifest)
    delivered_files = json.loads(payload["FILES.json"])
    for name, record in delivered_files["files"].items():
        record["sha256"] = sha(payload[name])
        record["bytes"] = len(payload[name])
    payload["FILES.json"] = json_bytes(delivered_files)
    for name in (manifest_name, "MANIFEST.json", "FILES.json"):
        changed_base[name] = {
            "original_sha256": base_hashes[name], "delivered_sha256": sha(payload[name]),
            "reason": "Generic local runtime path replaced by [local-runtime] in execution metadata; dependent delivered hashes/byte counts updated" if name == manifest_name else "Dependent delivered hash/byte-count chain updated for the documented metadata privacy repair",
        }
    assert {name for name, data in payload.items() if sha(data) != base_hashes[name]} == set(changed_base)
    suites = [json.loads(data) for name, data in payload.items()
              if name.startswith("R3/") and name.endswith("/benchmark.json")]
    assert len(suites) == 9
    assertion_count = sum(len(suite["checks"]) for suite in suites)
    assert assertion_count == 782
    assert all(check["pass"] for suite in suites for check in suite["checks"])
    additions = {
        "R11/scenarios.json": REPO / "bench/results/20261023151709-1pjk/scenarios.json",
        "R11/scenarios-benchmark.md": REPO / "bench/results/20261023151709-1pjk/scenarios-benchmark.md",
        "R11/scenarios-mission-injection.log": REPO / "bench/results/20261023151709-1pjk/scenarios-mission-injection.log",
        "R12/summary.json": REPO / "bench/results/injection-pressure-loop-2026-10-23T15-25-20-318Z/summary.json",
        "software/current-software-tests.log": HERE / "qa/current-software-tests.log",
        "REPRODUCIBILITY.md": PAPER / "REPRODUCIBILITY.md",
        "CLAIM-EVIDENCE-LEDGER.md": PAPER / "CLAIM-EVIDENCE-LEDGER.md",
    }
    test_names = ("high-risk-tool-scope", "tool-profile-observer", "recipe-propose",
                  "manual-approval-optimization", "recipe-approval-snapshot", "manual-approval",
                  "tool-approvals-choice", "recipe-op-interval")
    selected_sources = ["tests/" + name + ".test.ts" for name in test_names]
    selected_sources += [
        "server/services/workshop/agents/industrial/optimization-tools.ts",
        "server/services/workshop/agents/industrial/optimizer-tools.ts",
        "server/services/workshop/agents/host-tool-bridge/optimizer-gate.ts",
        "server/services/workshop/aml/twin/channel-profile.ts",
        "server/services/workshop/dcw/dcw-controller/write.ts",
        "server/services/workshop/dcw/dcw-controller/recipes.ts",
        "server/services/workshop/dcw/dcw-controller/actuation.ts",
        "server/services/workshop/dcw/dcw-controller/write-verify.ts",
        "server/services/workshop/dcw/param-limits.ts",
    ]
    for name in selected_sources:
        path = REPO / name
        if not path.is_file():
            raise FileNotFoundError("Selected source snapshot is unavailable: " + name)
        additions["source-snapshot/" + name] = path
    prefix = "revision-2026-10-24/"
    origins = {}
    for name, path in additions.items():
        key = prefix + name
        if key in payload:
            raise ValueError("Extension would overwrite historical entry: " + key)
        payload[key], origins[key] = cleaned_copy(path)
    r11_original = json.loads(additions["R11/scenarios.json"].read_text(encoding="utf-8-sig"))
    r12_original = json.loads(additions["R12/summary.json"].read_text(encoding="utf-8-sig"))
    results = boundary_checks(r11_original, r12_original)
    assert results == boundary_checks(json.loads(payload[prefix + "R11/scenarios.json"]),
                                      json.loads(payload[prefix + "R12/summary.json"]))
    test_log = payload[prefix + "software/current-software-tests.log"].decode("utf-8")
    assert re.search(r"\btests\s+65\b", test_log) and re.search(r"\bpass\s+65\b", test_log) and re.search(r"\bfail\s+0\b", test_log)
    extension = {"revision": REVISION, "base_package": BASE_ZIP.name,
                 "base_package_sha256": sha(BASE_ZIP.read_bytes()),
                 "base_entries_copied": len(base_hashes), "byte_identical_base_entries": len(base_hashes) - len(changed_base),
                 "historical_metadata_privacy_changes": changed_base, "historical_R3_assertions": assertion_count,
                 "files": origins, "boundary_checks": results,
                 "selected_source_snapshot": {"files": ["source-snapshot/" + name for name in selected_sources],
                                              "test_sources": 8, "core_contract_sources": 9,
                                              "scope": "Selected current working-tree source copies captured at packaging; the working tree has uncommitted edits. This is neither a complete independent runtime nor an exact historical runtime version. The October 24 log reports execution on this current working tree; source hashes do not prove a historical commit reproduces it."},
                 "redaction": "Copies only: explicit identity/local-path strings and identifying repository URLs; JSON quantitative, boolean and null leaves unchanged. HTTP(S) URLs retained except identified private repositories.",
                 "scope": "Historical numerical evidence entries are byte-identical. One generic runtime-path metadata field and its dependent delivered hash/byte-count chain are repaired in copies only; all repairs and dated additions are documented here."}
    payload[prefix + "EXTENSION-MANIFEST.json"] = json_bytes(extension)
    payload[prefix + "README.md"] = (
        "# October 24 evidence extension\n\nThe historical numerical evidence is copied byte-identically from the "
        "October 20 anonymous bundle. One generic local-runtime path in figure metadata is redacted, and "
        "the dependent delivered manifest hashes/byte counts are updated. The original ZIP is unchanged; "
        "EXTENSION-MANIFEST.json records these precise copy-only changes. Past checks retain their historical scope. "
        "EXTENSION-MANIFEST.json records the original/delivered hashes and redaction of each added file, "
        "without private source locations. R11 is a failed historical direct-node replay: eight refused candidates, "
        "zero writes, target not attained. R12 has one verified recipe trial, then default-cadence refusals; "
        "its target and restoration assertions failed and no recipe update was saved. Neither is an independent "
        "successful replicate of R6. The software log records the same 65 isolated checks rerun on October 24 "
        "with temporary/mock state, not process-response observations. The source-snapshot directory contains "
        "eight test sources and nine selected core contract sources from the current uncommitted working tree, "
        "with original/delivered hashes. It is not a full independent runtime or exact historical version; no "
        "claim is made that the old recorded commit fully reproduces the new log. Raw observations and failed outcomes "
        "were not altered to make results favorable. The original files and historical ZIP were not edited.\n"
    ).encode("utf-8")
    assert all(sha(payload[name]) == digest for name, digest in base_hashes.items() if name not in changed_base)
    assert all(sha(payload[name]) == digest for name, digest in base_hashes.items() if re.match(r"R\d+/", name))
    for name, record in delivered_files["files"].items():
        assert sha(payload[name]) == record["sha256"] and len(payload[name]) == record["bytes"]
    privacy_scan(payload)
    return payload, origins, {"base_entries": len(base_hashes),
                              "byte_identical_base_entries": len(base_hashes) - len(changed_base),
                              "historical_metadata_privacy_changes": changed_base,
                              "historical_experimental_entries_byte_identical": True,
                              "selected_test_sources": 8, "selected_core_sources": 9,
                              "historical_R3_assertions": assertion_count, "boundary_checks": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Test redaction without packaging or refreshing manifests")
    parser.add_argument("--finalized", action="store_true", help="Confirm that the final PDF was compiled and checked")
    parser.add_argument("--extract-source-to", type=Path, help="Extract source ZIP to a new clean rebuild directory")
    args = parser.parse_args()
    self_test()
    if args.self_test:
        return
    if not args.finalized:
        parser.error("Use --finalized only after the final compile and visual checks")
    source_payload, source_origins, pages = source_package()
    evidence_payload, evidence_origins, evidence_checks = evidence_package()
    source_zip, evidence_zip = HERE / SOURCE_NAME, HERE / EVIDENCE_NAME
    zip_payload(source_zip, source_payload)
    zip_payload(evidence_zip, evidence_payload)
    final_pdf = HERE / PDF_NAME
    shutil.copyfile(PAPER / "main.pdf", final_pdf)
    # This copy now describes precisely the final delivered source assets.
    (PAPER / "FILE-MANIFEST.json").write_bytes(source_payload["FILE-MANIFEST.json"])
    delivery = {"revision": REVISION, "pages": pages,
                "manuscript_pdf": {"name": PDF_NAME, "sha256": sha(final_pdf.read_bytes()),
                                   "bytes": final_pdf.stat().st_size},
                "base_evidence_package": {"name": BASE_ZIP.name, "sha256": sha(BASE_ZIP.read_bytes()), "bytes": BASE_ZIP.stat().st_size},
                "source": {"name": SOURCE_NAME, "sha256": sha(source_zip.read_bytes()), "bytes": source_zip.stat().st_size,
                           "entries": len(source_payload), "files": {name: sha(data) for name, data in sorted(source_payload.items())},
                           "original_and_delivered": source_origins, "privacy_scan": privacy_scan(source_payload)},
                "evidence": {"name": EVIDENCE_NAME, "sha256": sha(evidence_zip.read_bytes()), "bytes": evidence_zip.stat().st_size,
                             "entries": len(evidence_payload), "extension_original_and_delivered": evidence_origins,
                             "preservation_checks": evidence_checks, "privacy_scan": privacy_scan(evidence_payload)},
                "zip_integrity": "PASS: testzip and exact entry/hash comparison for both archives",
                "scope": "Technical packaging and bounded anonymity checks; not scientific approval or journal acceptance"}
    (HERE / "DELIVERY-MANIFEST.json").write_bytes(json_bytes(delivery))
    if args.extract_source_to:
        extract_clean_source(source_zip, args.extract_source_to.resolve())
    print(json.dumps({"pdf": PDF_NAME, "source": SOURCE_NAME, "evidence": EVIDENCE_NAME, "pages": pages,
                      "source_entries": len(source_payload), "evidence_entries": len(evidence_payload),
                      "evidence_checks": evidence_checks}, indent=2))


if __name__ == "__main__":
    main()
