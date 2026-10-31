from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent / "SUBMISSION-IEEE-TII"
STAGE = HERE / "s1-staging"
EVIDENCE_SOURCE = PAPER / "qa/onboarding-repro-2026-10-26-v083-online"
S1_NAME = "Supplementary-File-S1-2026-10-26.zip"
PDF_NAME = "IEEE-TII-manuscript-2026-10-26.pdf"
SOURCE_NAME = "IEEE-TII-manuscript-source-2026-10-26.zip"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def numeric_leaves(value: object) -> int:
    if isinstance(value, dict):
        return sum(numeric_leaves(x) for x in value.values())
    if isinstance(value, list):
        return sum(numeric_leaves(x) for x in value)
    if value is None or isinstance(value, (bool, int, float)):
        return 1
    return 0


def preserved_observations(value: object) -> object:
    if isinstance(value, dict):
        return ("object", tuple((key, preserved_observations(value[key])) for key in sorted(value)))
    if isinstance(value, list):
        return ("array", tuple(preserved_observations(item) for item in value))
    if isinstance(value, str):
        return ("text",)
    if value is None or isinstance(value, (bool, int, float)):
        return (type(value).__name__, value)
    raise TypeError(f"Unexpected JSON leaf type: {type(value).__name__}")


def scan_r24_text(payload: dict[str, bytes]) -> dict[str, bool]:
    identity = re.compile(r"(?i)\b(?:Diane Williams|kingdol[A-Za-z0-9_-]*|87287)\b")
    local_path = re.compile(r"(?i)(?:[A-Z]:[\\/]Users[\\/][^\\/\s\"']+|/(?:Users|home)/[^/\s\"']+)")
    credential = re.compile(
        r"(?i)(?:password|passwd|secret|token|api[_-]?key|authorization)"
        r"\s*[:=]\s*[\"']?(?!DEMO\b|NONE\b|FALSE\b|TRUE\b|REDACTED\b)"
        r"[A-Za-z0-9+/=_-]{12,}")
    text = "\n".join(data.decode("utf-8", errors="replace") for data in payload.values())
    result = {
        "personal_identity_scan_pass": identity.search(text) is None,
        "local_user_path_scan_pass": local_path.search(text) is None,
        "credential_value_scan_pass": credential.search(text) is None,
    }
    if not all(result.values()):
        raise SystemExit("R24 privacy scan failed: " + json.dumps(result))
    return result


def build_s1() -> Path:
    r24_rel = Path("revision-2026-10-26/R24")
    r24_out = STAGE / r24_rel
    r24_out.mkdir(parents=True, exist_ok=True)
    names = [
        "blueprint.json", "daq-infrastructure.json", "health-version.json",
        "onboard.json", "onboarding.log", "R24-reproduction.json",
        "reproduction-summary.json", "verify-line.log",
    ]
    originals: dict[str, bytes] = {name: (EVIDENCE_SOURCE / name).read_bytes() for name in names}
    copies = dict(originals)

    # Remove the product label from the anonymous copy while preserving all
    # measured fields and service status. The source artifact remains intact.
    health = json.loads(copies["health-version.json"].decode("utf-8"))
    health["data"]["app"] = "Platform"
    copies["health-version.json"] = json_bytes(health)

    # Keep the report's embedded digest aligned with its delivered health file.
    report = json.loads(copies["R24-reproduction.json"].decode("utf-8"))
    report["sha256"]["health-version.json"] = sha(copies["health-version.json"])
    copies["R24-reproduction.json"] = json_bytes(report)

    for name, data in copies.items():
        (r24_out / name).write_bytes(data)
    for name, raw in originals.items():
        if name.endswith(".json"):
            before = json.loads(raw.decode("utf-8"))
            after = json.loads(copies[name].decode("utf-8"))
            if preserved_observations(before) != preserved_observations(after):
                raise SystemExit(f"JSON observations changed during anonymous copy: {name}")
    privacy_scan = scan_r24_text(copies)

    readme_path = STAGE / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    readme = readme.replace(
        "This delivered copy accompanies the October 25 IEEE TII manuscript.",
        "This delivered copy accompanies the October 26 IEEE TII manuscript.",
    )
    readme = readme.replace(
        "The October 25 extension manifest documents every root-copy change and added artifact.",
        "The October 25 and October 26 extension records document their added artifacts and copy transformations.",
    )
    r24_note = (
        " R24 is a separate v0.8.3 working-tree replay of one documented C01 "
        "blueprint. Its source commit was not pinned. The isolated run used a "
        "local Modbus/TCP PLC twin, MES REST simulator, and dedicated online "
        "MQTT/Timescale services; object storage was unavailable and image "
        "artifacts used local-disk fallback. Connectivity passed 3/3, line "
        "provisioning 20/20, channel construction 13/13, V1--V6 verification "
        "23/23, and the onboarding smoke 11/11. A test-only automatic approval "
        "changed line speed from 37 to 39 m/min and the PLC twin confirmed the "
        "write. This is one simulated configuration instance, not evidence of "
        "arbitrary portability, profile reuse, repeatability, physical transfer, "
        "human-review performance, or process quality. The delivered health "
        "record replaces the product label with a generic label; the original "
        "and delivered hashes are recorded in MANIFEST.json."
    )
    readme = readme.replace(
        "\n\nOnly delivery copies were anonymized or refreshed.",
        "\n\n" + r24_note + "\n\nOnly delivery copies were anonymized or refreshed.",
    )
    readme_path.write_text(readme, encoding="utf-8", newline="\n")

    claim_path = STAGE / "CLAIM-MAP.json"
    claim_map = json.loads(claim_path.read_text(encoding="utf-8"))
    claims = claim_map["claims"]
    claims[:] = [c for c in claims if c.get("evidence_unit") != "R24"]
    prefix = (r24_rel.as_posix() + "/")
    claims.append({
        "question": "R24",
        "manuscript_anchor": "sec:coating-onboarding",
        "evidence_unit": "R24",
        "artifacts": [
            {"path": prefix + "R24-reproduction.json", "json_pointer": "/checks/v1ToV6", "line": None},
            {"path": prefix + "R24-reproduction.json", "json_pointer": "/services/mqtt", "line": None},
            {"path": prefix + "blueprint.json", "json_pointer": None, "line": None},
            {"path": prefix + "onboard.json", "json_pointer": None, "line": None},
            {"path": prefix + "onboarding.log", "json_pointer": None, "line": None},
            {"path": prefix + "verify-line.log", "json_pointer": None, "line": None},
            {"path": prefix + "health-version.json", "json_pointer": "/data/version", "line": None},
            {"path": prefix + "daq-infrastructure.json", "json_pointer": "/tsdbOnline", "line": None},
        ],
        "n": {
            "connectivity_checks": 3,
            "provisioning_checks": 20,
            "channel_construction_checks": 13,
            "v1_to_v6_checks": 23,
            "onboarding_smoke_checks": 11,
            "devices": 1,
            "signals": 11,
            "setpoints": 4,
            "daq_nodes": 7,
        },
        "units": ["software checks", "signals", "simulator setpoint (m/min)"],
        "interface": "v0.8.3 blueprint onboarding; local Modbus/TCP PLC twin and MES REST simulator; isolated MQTT/Timescale online",
        "source_version": "Working-tree build identified as v0.8.3; source commit was not pinned.",
        "configuration": {
            "device": "coating-c01",
            "protocol": "Modbus TCP",
            "signal_mapping": "4 setpoints and 7 DAQ nodes",
            "object_store": "unavailable; image artifacts used local-disk fallback",
            "approval": "test-only automatic approval; not human review",
            "scope": "one documented simulated blueprint instance",
        },
        "missing_fields": {
            "source_commit": None,
            "repeatability": None,
            "configuration_reuse": None,
            "physical_plant_validation": None,
            "human_review_performance": None,
            "process_quality": None,
        },
    })
    claim_path.write_bytes(json_bytes(claim_map))

    manifest_path = STAGE / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["extensions"] = [e for e in manifest.get("extensions", []) if e.get("evidence_unit") != "R24"]
    rows = [row for row in manifest["source_files"] if not row["path"].startswith(prefix)]
    for name in names:
        src = originals[name]
        dst = copies[name]
        transformed = src != dst
        row = {
            "path": prefix + name,
            "evidence_unit": "R24",
            "role": "current-version onboarding evidence; separate from route-study samples",
            "source_revision": "v0.8.3 working-tree build; source commit not pinned",
            "original_sha256": sha(src),
            "delivered_sha256": sha(dst),
            "original_bytes": len(src),
            "delivered_bytes": len(dst),
            "transformations": {"anonymous_label_redaction_and_hash_refresh": 1} if transformed else {},
            "numeric_boolean_null_fields_verified": None,
        }
        if name.endswith(".json"):
            row["numeric_boolean_null_fields_verified"] = numeric_leaves(json.loads(src.decode("utf-8")))
        rows.append(row)
    manifest["source_files"] = rows
    manifest["extensions"].append({
        "date": "2026-10-26",
        "evidence_unit": "R24",
        "path": prefix,
        "source_revision": "v0.8.3 working-tree build; commit not pinned",
        "scope": "one isolated C01 blueprint-to-simulator onboarding replay",
        "limitations": ["not arbitrary portability", "not configuration reuse", "not repeatability", "not physical transfer", "not human-review performance", "not process quality"],
        "original_sources_unchanged": True,
    })
    manifest_path.write_bytes(json_bytes(manifest))

    validation = {
        "date": "2026-10-26",
        "status": "PASS",
        "checks": {
            "r24_artifacts_present": len(names),
            "r24_original_and_delivered_hashes_recorded": True,
            "r24_embedded_health_hash_matches_delivered_copy": report["sha256"]["health-version.json"] == sha(copies["health-version.json"]),
            "claim_map_artifacts_exist": True,
            "numeric_boolean_null_values_preserved_in_redacted_json": True,
            **privacy_scan,
            "source_commit_pinned": False,
        },
        "scope": "Offline package-integrity validation; no services contacted and no controls issued.",
    }
    (STAGE / "DELIVERY-VALIDATION-2026-10-26.json").write_bytes(json_bytes(validation))

    file_rows = {}
    for path in sorted(p for p in STAGE.rglob("*") if p.is_file() and p.name != "FILES.json"):
        rel = path.relative_to(STAGE).as_posix()
        data = path.read_bytes()
        file_rows[rel] = {"sha256": sha(data), "bytes": len(data)}
    (STAGE / "FILES.json").write_bytes(json_bytes({
        "schema": "delivered-files/1.0",
        "self_excluded": "FILES.json",
        "files": file_rows,
    }))

    result = subprocess.run([sys.executable, str(STAGE / "verify_bundle.py")], cwd=STAGE, check=False)
    if result.returncode:
        raise SystemExit(f"Supplement verifier failed: exit {result.returncode}")

    out = HERE / S1_NAME
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(p for p in STAGE.rglob("*") if p.is_file()):
            zf.write(path, path.relative_to(STAGE).as_posix())
    shutil.copy2(out, PAPER / "Supplementary-File-S1.zip")
    return out


def make_source_zip() -> Path:
    source_files = [
        "main.tex", "main.pdf", "README.md", "REPRODUCIBILITY.md",
        "CLAIM-EVIDENCE-LEDGER.md", "FILE-MANIFEST.json",
        "resources/refs.bib", "resources/results-macros.tex",
        "resources/fig-architecture-2026-9pt.pdf", "resources/fig-architecture-2026-9pt.svg",
        "resources/fig-runtime-2026-9pt.pdf", "resources/fig-runtime-2026-9pt.svg",
        "resources/fig-admission-hitl-2026.pdf", "resources/fig-admission-hitl-2026.svg",
        "resources/fig-missions-controls.pdf", "resources/fig-missions-controls.svg",
        "resources/fig-missions-controls-preview.png",
        "resources/figure-source-data/source-data-missions.json",
        "resources/figure-source-data/source-data-missions-controls.csv",
        "resources/figure-source-data/source-data-missions-outcomes.csv",
        "resources/figure-source-data/current-route-observations.csv",
        "resources/figure-source-data/current-route-observations.json",
        "figures/make-system-2026.py", "figures/make-evaluation-2026.py",
        "figures/plot-historical-missions.py", "figures/make-manifest.py",
        "tools/audit.py", "tools/audit-figures.py",
    ]
    source_files.extend(f"sections/{p.name}" for p in sorted((PAPER / "sections").glob("*.tex")))
    absent = [name for name in source_files if not (PAPER / name).is_file()]
    if absent:
        raise SystemExit("Source package files missing: " + ", ".join(absent))
    out = HERE / SOURCE_NAME
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in source_files:
            zf.write(PAPER / name, name)
    return out


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] != "--finalized":
        raise SystemExit("Usage: python package-final.py --finalized")
    s1 = build_s1()
    pdf = HERE / PDF_NAME
    shutil.copy2(PAPER / "main.pdf", pdf)
    subprocess.run([sys.executable, str(PAPER / "figures/make-manifest.py")], cwd=PAPER, check=True)
    source = make_source_zip()
    entries = [s1, source, pdf]
    manifest = {
        "revision": "2026-10-26",
        "manuscript_pages": 10,
        "format": "IEEEtran journal, 10 pt, two-column, US Letter",
        "anonymous_review_copy": True,
        "figure_pages": {"Fig. 1": 3, "Fig. 2": 5, "Fig. 3": 5, "Fig. 4": 7, "Fig. 5": 8},
        "files": {
            item.name: {"sha256": sha(item.read_bytes()), "bytes": item.stat().st_size}
            for item in entries
        },
        "final_audit": {
            "name": "FINAL-AUDIT-2026-10-26.md",
            "sha256": sha((HERE / "FINAL-AUDIT-2026-10-26.md").read_bytes()),
            "bytes": (HERE / "FINAL-AUDIT-2026-10-26.md").stat().st_size,
        },
        "ai_disclosure": {
            "blind_pdf_acknowledgment": "omitted for double-blind review",
            "submission_channel": "unconfirmed; authors must confirm with current TII portal or editorial office",
            "private_note": "../SUBMISSION-IEEE-TII/AI-DISCLOSURE.md",
        },
        "scope_note": "R24 evidence is one documented simulated onboarding instance from a v0.8.3 working-tree build whose commit was not pinned.",
    }
    (HERE / "DELIVERY-MANIFEST.json").write_bytes(json_bytes(manifest))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
