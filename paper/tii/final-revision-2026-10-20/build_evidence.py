"""Build an anonymous, bounded evidence release without changing source archives.

This package is an inspection/analysis supplement, not a complete runtime release.
Run with Python 3.11+ from any directory. No service or device is contacted.
"""
from __future__ import annotations

import collections
import csv
import hashlib
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / "evidence"
ZIP = HERE / "IEEE-TII-anonymous-evidence.zip"
SOURCE_REVISION = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
HISTORICAL = "e692df1439127a6db6859b51d92d9376bf486de2"
SIM_HISTORICAL = "5c65e9342f1ed21a6221afb35cefdb22c5283208"
R1 = "bench/results/20260921184204-10lc"
R2 = "bench/results/20260921181234-e1lite"
R6 = "bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z"
R7 = "bench/results/injection-recipe-closedloop-2026-10-18T11-23-30-084Z"
R8 = "bench/results/injection-pressure-loop-2026-10-18T17-32-16-585Z"
ROWS: list[dict] = []
PRIVATE_ROWS: list[dict] = []
SECRETS: set[str] = set()
KNOWN_IDENTITIES = ("kingdol666", "kingdol", "87287")
SENSITIVE_KEYS = {"password", "passwd", "passwordhash", "token", "accesstoken", "refreshtoken", "apikey", "api_key", "secret", "authorization"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def git_bytes(path: str, revision=HISTORICAL, repository=ROOT) -> bytes:
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=repository)


def pseudo(value: str, kind: str) -> str:
    return f"ANON_{kind}_{sha(value.casefold().encode())[:10]}"


def clean_text(value: str, changes: collections.Counter) -> str:
    original = value
    # Only credential values, never measurement values or protocol names.
    for secret in sorted(SECRETS, key=len, reverse=True):
        if len(secret) >= 5 and secret in value:
            value = value.replace(secret, "REDACTED_LOCAL_CREDENTIAL")
            changes["credential_value"] += 1
    value, n = re.subn(r"\bBearer\s+(?!\$|\{|\+|<)([A-Za-z0-9_.\-]{12,})", "Bearer REDACTED_CREDENTIAL", value, flags=re.I)
    changes["credential_bearer"] += n
    value, n = re.subn(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "REDACTED_JWT", value)
    changes["credential_jwt"] += n
    value, n = re.subn(r"\but-[A-Za-z0-9]{20,}\b", "REDACTED_LOCAL_ACCESS_TOKEN", value)
    changes["credential_local_token"] += n
    value, n = re.subn(r"(?i)((?:password|passwd)\s*[:=]\s*)(['\"])([^'\"]+)\2", lambda m: m[1] + m[2] + "REDACTED_LOCAL_CREDENTIAL" + m[2], value)
    changes["credential_literal"] += n
    value, n = re.subn(r"(NUXT_SESSION_PASSWORD=)[^\s\"'`]+", r"\1REDACTED_LOCAL_CREDENTIAL", value)
    changes["credential_session_setting"] += n
    value, n = re.subn(r"[A-Za-z0-9_.+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", lambda m: pseudo(m[0], "ACCOUNT") + "@example.invalid", value)
    changes["account_pseudonym"] += n
    # Covers single and multiply JSON-escaped Windows path separators.
    value, n = re.subn(r"[A-Za-z]:(?:\\+|/)Users(?:\\+|/)[^\\/\s\"'<>`]+", "[ANONYMOUS_HOME]", value, flags=re.I)
    changes["private_home_prefix"] += n
    value, n = re.subn(r"[A-Za-z]:(?:\\+|/)codes(?:\\+|/)(?:ABO(?:\\+|/))?(?:AgentWorkShop|plc-node-simulator-bench)", "[ANONYMOUS_WORKSPACE]", value, flags=re.I)
    changes["private_workspace_prefix"] += n
    value, n = re.subn(r"[A-Za-z]:(?:\\+|/)codes(?:\\+|/)(?:ABO(?:\\+|/))?", "[ANONYMOUS_WORKSPACE]/", value, flags=re.I)
    changes["private_workspace_prefix"] += n
    value, n = re.subn(r"https?://(?:www\.)?(?:github\.com|gitlab\.com|gitee\.com)/[^\s\"'<>`)]+", "https://example.invalid/anonymous-source", value, flags=re.I)
    changes["identity_repository_url"] += n
    for identity in KNOWN_IDENTITIES:
        value, n = re.subn(r"(?<![A-Za-z0-9])" + re.escape(identity) + r"(?![A-Za-z0-9])", "ANONYMOUS_AUTHOR", value, flags=re.I)
        changes["identity_name"] += n
    value, n = re.subn(r"agentworkshop", lambda m: "PLATFORM" if m[0].isupper() else ("platform" if m[0].islower() else "Platform"), value, flags=re.I)
    changes["project_identity"] += n
    if value == original:
        changes["unchanged_text"] += 1
    return value


def sanitize(obj, changes: collections.Counter, key=""):
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            delivered_key = clean_text(k, changes) if re.fullmatch(r"agentworkshop", k, flags=re.I) else k
            assert delivered_key not in result, "Anonymized dictionary-key collision"
            result[delivered_key] = sanitize(v, changes, k)
        return result
    if isinstance(obj, list):
        return [sanitize(v, changes, key) for v in obj]
    if isinstance(obj, str):
        if key.lower().replace("-", "") in SENSITIVE_KEYS and obj:
            changes["credential_field"] += 1
            return "REDACTED_CREDENTIAL"
        # Several archives embed JSON objects inside the string-valued detail.
        if obj.lstrip().startswith(("{", "[")):
            try:
                nested = json.loads(obj)
            except json.JSONDecodeError:
                pass
            else:
                cleaned = sanitize(nested, changes)
                if cleaned != nested:
                    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
        return clean_text(obj, changes)
    return obj


def primitives(obj, path=""):
    """Retain numeric/boolean/null shape including values in embedded JSON strings."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from primitives(v, path + "/" + k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from primitives(v, path + "/" + str(i))
    elif obj is None or isinstance(obj, (int, float, bool)):
        yield path, obj
    elif isinstance(obj, str) and obj.lstrip().startswith(("{", "[")):
        try:
            nested = json.loads(obj)
        except json.JSONDecodeError:
            return
        yield from primitives(nested, path + "/@embedded-json")


def add(source: str, dest: str, unit: str, *, data=None, revision=None, role="archived evidence"):
    raw = (ROOT / source).read_bytes() if data is None else data
    original = raw.decode("utf-8-sig")
    counts: collections.Counter = collections.Counter()
    ext = Path(dest).suffix
    numeric_count = None
    if ext == ".json":
        a = json.loads(original)
        b = sanitize(a, counts)
        assert list(primitives(a)) == list(primitives(b)), dest
        numeric_count = len(list(primitives(a)))
        delivered = json_bytes(b)
    elif ext == ".jsonl":
        aa = [json.loads(line) for line in original.splitlines() if line.strip()]
        bb = [sanitize(item, counts) for item in aa]
        assert list(primitives(aa)) == list(primitives(bb)), dest
        numeric_count = len(list(primitives(aa)))
        delivered = ("\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in bb) + "\n").encode()
    else:
        text = clean_text(original, counts)
        delivered = text.encode("utf-8")
        if ext == ".csv":
            aa, bb = list(csv.reader(io.StringIO(original))), list(csv.reader(io.StringIO(text)))
            assert len(aa) == len(bb)
            assert all(len(a) == len(b) for a, b in zip(aa, bb))
            numeric_count = 0
            for a, b in zip(aa, bb):
                for x, y in zip(a, b):
                    if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", x):
                        assert x == y, dest
                        numeric_count += 1
    target = OUT / dest
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(delivered)
    transformations = {k: v for k, v in counts.items() if v and k != "unchanged_text"}
    if delivered != raw:
        transformations.setdefault("utf8_serialization_or_newline", 1)
    row = {"path": dest, "evidence_unit": unit, "role": role, "source_revision": revision,
           "original_sha256": sha(raw), "delivered_sha256": sha(delivered), "original_bytes": len(raw),
           "delivered_bytes": len(delivered), "transformations": transformations,
           "numeric_boolean_null_fields_verified": numeric_count}
    ROWS.append(row)
    PRIVATE_ROWS.append({"public_path": dest, "source_path": source, "source_absolute": str(ROOT / source), "source_revision": revision, "original_sha256": sha(raw)})


def write(name: str, text_or_obj):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json_bytes(text_or_obj) if not isinstance(text_or_obj, str) else text_or_obj.encode())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    account = json.loads((ROOT / "scripts/testing/benchmark.config.json").read_text(encoding="utf-8"))["account"]
    SECRETS.add(account["password"])
    SECRETS.update({"admin123", "Admin123!", "Ops2026!", "Visual2026"})
    for name in ("run.json", "scenarios.json", "metrics.csv", "report.md", "summary.json", "line-profile.json", "scenarios-benchmark.md", "ARTIFACT-NOTES.md", "agent-loop-omp.log", "agent-goal-loop-omp.log", "agentteam-biax.log", "agentteam-mission.log", "scenarios-mission-anneal.log", "scenarios-mission-biax.log", "scenarios-mission-injection.log", "scenarios-mission-wwtp.log"):
        add(f"{R1}/{name}", f"R1/{name}", "R1", revision="archive records e692df1; working-tree harness differs from commit")
    for name in ("run.json", "e1-lite.csv", "report.md"):
        add(f"{R2}/{name}", f"R2/{name}", "R2", revision="archive records e692df1")
    benchmark_dirs = sorted(p for p in (ROOT / "docs/benchmarks").glob("benchmark-2026100[789]*") if p.is_dir())
    assert len(benchmark_dirs) == 9
    for folder in benchmark_dirs:
        for name in ("benchmark.json", "report.md", "timeline.jsonl"):
            add(str((folder / name).relative_to(ROOT)).replace("\\", "/"), f"R3/{folder.name}/{name}", "R3", revision=None)
    add("docs/benchmarks/benchmark-20261009033810/timeline.jsonl", "R4/timeline.jsonl", "R4", revision=None, role="same event stream as R3 final execution, not another run")
    for name in ("2026-10-08-production-hardening-report.md", "2026-10-17-ack-baseline.md", "2026-10-17-ack-baseline.log"):
        add("docs/audit/" + name, "R5/" + name, "R5")
    for unit, folder in (("R6", R6), ("R7", R7), ("R8", R8)):
        add(folder + "/summary.json", unit + "/summary.json", unit)
    for name in ("closedloop-summary.json", "goal1-evidence.json", "goal1-flash-evidence.json", "report.md"):
        add("bench/results/real-harness-injection-20261018/" + name, "R6/companion/" + name, "R6", role="companion capture; closedloop-summary duplicates primary R6 byte-for-byte")
    for i, folder in enumerate(sorted((ROOT / "bench/results").glob("2026-10-18T*-real-injection-closed-loop")), 1):
        for path in sorted(folder.glob("*.jsonl")):
            add(str(path.relative_to(ROOT)).replace("\\", "/"), f"R7/failed-attempt-{i}/{path.name}", "R7", role="earlier failed attempt; not a successful replicate")
    test_names = ("high-risk-tool-scope", "tool-profile-observer", "recipe-propose", "manual-approval-optimization", "recipe-approval-snapshot", "manual-approval", "tool-approvals-choice", "recipe-op-interval")
    for name in test_names:
        unit = "R9" if name in test_names[:3] else "R10"
        add(f"tests/{name}.test.ts", f"{unit}/tests/{name}.test.ts", unit, revision=SOURCE_REVISION, role="current test-source inspection snapshot; runtime imports not bundled")
    for name in ("approval-status-tests-before.log", "approval-status-tests.log", "recipe-approval-snapshot-tests.log", "final-independent-tests.log"):
        add("paper/tii/revision-2026-10-20/qa/" + name, "R10/logs/" + name, "R10", role="existing test output; before log includes pre-repair failure")
    bench_current = [p for p in (ROOT / "bench").rglob("*.mjs") if "results" not in p.parts and "baselines" not in p.parts and "latest" not in p.parts]
    for path in sorted(bench_current):
        rel = str(path.relative_to(ROOT)).replace("\\", "/")
        add(rel, "code/current/" + rel, "CODE", revision=SOURCE_REVISION, role="current working-tree inspection snapshot; exact historical harness not established")
    historic_paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", HISTORICAL, "bench"], cwd=ROOT, text=True).splitlines()
    for path in historic_paths:
        if path.endswith(".mjs") and not any(s in path for s in ("/results/", "/baselines/", "/latest/")):
            add(path, "code/recorded-commit/" + path, "CODE", data=git_bytes(path), revision=HISTORICAL, role="recorded commit snapshot; pipeline file-count/hash differs from run fingerprint")
    other_current = ("scripts/e2e-injection-recipe-closedloop.mjs", "scripts/real-injection-closed-loop.mjs", "scripts/_run-real-injection-fifo-goals.mjs", "scripts/_provision-injection-line.mjs", "scripts/testing/run-benchmark.mjs", "scripts/testing/api-full-loop.mjs", "scripts/testing/aggregate-benchmarks.mjs", "scripts/testing/benchmark.config.json", "tmp-e2e/hardening-ack-gate.mjs", "plc-node-simulator/src/server/engine/plant-model.ts", "plc-node-simulator/src/server/engine/biax-model.ts", "plc-node-simulator/src/server/engine/signals.ts", "plc-node-simulator/src/shared/types.ts", "paper/tii/SUBMISSION-IEEE-TII/figures/make-evaluation-2026.py")
    for rel in other_current:
        dest = "code/current/" + ("figures/make-evaluation-2026.py" if "/figures/" in rel else rel)
        add(rel, dest, "CODE", revision=SOURCE_REVISION, role="current inspection snapshot; no assertion of exact run-time source match")
    for path in ("src/server/engine/plant-model.ts", "src/server/engine/biax-model.ts", "src/server/engine/signals.ts", "src/shared/types.ts"):
        add("plc-node-simulator/" + path, "code/recorded-simulator/" + path, "CODE", data=git_bytes(path, SIM_HISTORICAL, ROOT / "plc-node-simulator"), revision=SIM_HISTORICAL, role="simulator gitlink at recorded main commit; run-time dirty state unknown")
    for rel in ("package.json", "plc-node-simulator/package.json"):
        add(rel, "code/dependencies/" + rel, "CODE", revision=SOURCE_REVISION, role="current dependency declaration; historical lockfile/environment not reconstructed")
    for path in sorted((ROOT / "paper/tii/revision-2026-10-20").glob("source-data-*")):
        if path.suffix in (".json", ".csv"):
            add(str(path.relative_to(ROOT)).replace("\\", "/"), "derived-figures/" + path.name, "FIGURES", role="derived data; archived units are not increased")
    make_claim_map()
    make_notes()
    write("R6-MEASUREMENT-NOTES.json", {
        "source": "R6/summary.json",
        "plotted_observation_pointer": "/final",
        "plotted_values": {"weight_g": 32.30, "flash_percent": 0.019, "sink_percent": 1.277},
        "plotted_sensor_timestamp_ms": 1792327040027,
        "later_update_reason_pointer": "/update",
        "update_reason_text_values": {"weight_g": 32.34, "flash_percent": 0.012, "sink_percent": 1.276},
        "update_reason_linked_measurement_id": None,
        "update_reason_per_sensor_timestamps": None,
        "interpretation": "The later recipe-update reason contains different text values. No linked raw measurement is archived for that rationale; it is not assigned a new sample or substituted for /final in the paper/plots. Both original fields are retained."
    })
    verification = validate()
    write("VALIDATION.json", verification)
    public = {"schema": "anonymous-evidence-manifest/1.0", "created_on": "2026-10-20", "scope": "Bounded archived evidence, source inspection snapshots, and offline analysis. Not a complete runtime release.", "source_files": ROWS,
              "original_log_origin": {"classification": "Original contemporaneous output, explicitly author-confirmed on 2026-10-20", "independent_capture_origin_verified": False, "applies_to": ["R1/agent-loop-omp.log", "R1/agent-goal-loop-omp.log"], "supersedes": "R1/ARTIFACT-NOTES.md absence statement only"}}
    write("MANIFEST.json", public)
    public_files = sorted(p for p in OUT.rglob("*") if p.is_file() and p.name != "FILES.json")
    index = {str(p.relative_to(OUT)).replace("\\", "/"): {"sha256": sha(p.read_bytes()), "bytes": p.stat().st_size} for p in public_files}
    write("FILES.json", {"schema": "delivered-files/1.0", "self_excluded": "FILES.json", "files": index})
    with zipfile.ZipFile(ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in sorted(p for p in OUT.rglob("*") if p.is_file()):
            bundle.write(path, str(path.relative_to(OUT)).replace("\\", "/"))
    with zipfile.ZipFile(ZIP) as bundle:
        assert bundle.testzip() is None
        for name, metadata in index.items():
            assert sha(bundle.read(name)) == metadata["sha256"]
    internal = {"date": "2026-10-20", "private_not_in_public_zip": True, "sources": PRIVATE_ROWS}
    (HERE / "INTERNAL-EVIDENCE-PROVENANCE.json").write_bytes(json_bytes(internal))
    receipt = {"date": "2026-10-20", "package": ZIP.name, "files": len(index) + 1, "source_artifacts": len(ROWS), "bytes": ZIP.stat().st_size, "sha256": sha(ZIP.read_bytes()), "zip_crc_and_manifest": "PASS", "validation": verification}
    (HERE / "EVIDENCE-DELIVERY.json").write_bytes(json_bytes(receipt))
    print(json.dumps({k: v for k, v in receipt.items() if k != "validation"}, indent=2))


def make_claim_map():
    def claim(q, anchor, unit, files, n, units, interface, version=None, config=None, missing=None):
        return {"question": q, "manuscript_anchor": anchor, "evidence_unit": unit, "artifacts": files, "n": n, "units": units, "interface": interface, "source_version": version, "configuration": config, "missing_fields": missing or {}}
    def ref(path, pointer=None, line=None):
        return {"path": path, "json_pointer": pointer, "line": line}
    rows = [
        claim("Q1", "sec:protocol; protocol acquisition/writes and latency", "R1", [ref("R1/run.json", "/lines"), ref("R1/metrics.csv", line=2), ref("R1/report.md", line=18)], {"acquired_families": 5, "writable_families": 4, "acquired_samples": 55}, ["ms", "samples", "refused probes"], "historical direct-node REST + real protocol simulators", HISTORICAL, {"seed": 42, "preset": "cast-film-physics", "RTU-over-TCP": "acquisition only"}),
        claim("Q1", "tab:ablation; admission versus confirmation", "R2", [ref("R2/e1-lite.csv", line=2), ref("R2/run.json", "/rows")], {"attack_classes_per_arm": 6, "deterministic_repetitions": 3, "attacks_per_arm": 18}, ["refusal count", "ms"], "historical mock-driver direct-node API fixture", HISTORICAL, {"seed": 42, "arms": ["full", "no-interlock", "no-readback", "ungated"]}),
        claim("Q2", "sec:agentteam; live engine proposal and goal workflow", "R1", [ref("R1/run.json", "/env"), ref("R1/agent-loop-omp.log", line=1), ref("R1/agent-goal-loop-omp.log", line=1)], {"live_engine_tasks": 2}, ["degrees C", "micrometers"], "historical omp agent / direct-node tools", HISTORICAL, {"provider": "zhipu-coding-plan", "model": "glm-5.3-flash"}, {"independent_log_capture_origin": None}),
        claim("Q3", "eq:objective; three-seed controller handling", "R1", [ref("R1/run.json", "/env/closedloop"), ref("R1/metrics.csv", line=1), ref("code/current/bench/lib/closedloop.mjs", line=34)], {"seeds": 3, "writes_per_seed": 2}, ["dimensionless J", "J/Jstar"], "historical governed direct-node controller", HISTORICAL, {"seeds": [42, 43, 44], "Jstar": 89.894, "reference": "restricted admissible steady-state grid"}, {"exact_runtime_harness_snapshot": None}),
        claim("Q4", "sec:scenarios; fig:missions; controls and outputs", "R1", [ref("R1/scenarios.json", "/results"), ref("R1/run.json", "/env/biax"), ref("derived-figures/source-data-missions.json", "/controls")], {"trajectories_per_process": 1, "processes": 4}, ["bar", "s", "g", "mg/L", "HV", "micrometers", "m/min", "mm"], "historical scripted direct-node missions", HISTORICAL, {"seed": 42}, {"first_annealing_optimization_record_id": None, "physical_device_waveform": None}),
        claim("Q5", "sec:hardening; nine sequential regressions", "R3", [ref("R3/" + p.name + "/benchmark.json", "/checks") for p in sorted((ROOT / "docs/benchmarks").glob("benchmark-2026100[789]*"))], {"suite_executions": 9, "assertions": 782}, ["software assertions", "ms"], "deployment regression suite; recipe composition with simulator I/O", None, {"days": ["2026-10-07", "2026-10-08", "2026-10-09"]}, {"per_run_exact_source_commit": None}),
        claim("Q5", "fig:loop; S4/S5 timestamp spans and nonconvergence", "R4", [ref("R4/timeline.jsonl", line=3), ref("derived-figures/source-data-governance.json", "/events")], {"events": 21, "sequential_execution": 1}, ["s", "bar", "g"], "same final R3 suite execution, not additional data", "0.7.57", {"S4_span_s": 96.105, "cadence_wait_s": 69.014, "converged": False}),
        claim("Q5", "sec:hardening; ACK grades and success-flag baseline", "R5", [ref("R5/2026-10-08-production-hardening-report.md", line=20), ref("R5/2026-10-17-ack-baseline.md", line=1), ref("R5/2026-10-17-ack-baseline.log", line=1)], {"baseline_checks": 22}, ["verified/unverified/failed counts"], "fault injection with mock/MQTT receipts; same receipt for both reporting rules", None, {"AW_ONLY_ACK": 1}, {"original_October8_console_log": None}),
        claim("Q6", "sec:recipeexperiment; fig:injection; primary trajectory", "R6", [ref("R6/summary.json", "/baseline"), ref("R6/summary.json", "/results"), ref("R6/summary.json", "/final"), ref("derived-figures/source-data-injection.json", "/snapshots")], {"sequential_trajectories": 1, "quality_snapshots": 5, "pressure_trials": 4}, ["bar", "s", "g", "%"], "recipe_trial -> graded receipt -> DAQ; recipe_update separately", None, {"hold_time_s": 6, "pressure_bar": [45, 50, 55, 60, 65], "weight_g": [31.28, 31.49, 31.74, 32.05, 32.3], "wait_s": 65, "AW_TRIAL_INTERVAL_MS": 0, "emergency_trials": True, "approval": "scripted"}, {"seed": None, "exact_commit": None, "per_sensor_timestamps": None, "melt_temperature": None, "physical_PLC_waveform": None}),
        claim("Q6", "sec:recipeexperiment; earlier cadence boundary", "R7", [ref("R7/summary.json", "/trial2"), ref("R7/summary.json", "/results"), ref("R7/failed-attempt-1/execution.jsonl", line=1), ref("R7/failed-attempt-2/execution.jsonl", line=1), ref("R7/failed-attempt-3/execution.jsonl", line=1)], {"summarized_attempt": 1, "other_earlier_failed_attempt_logs": 3}, ["s", "bar", "g"], "recipe trial and failed historical harness attempts", None, {"default_trial_interval_s": 300}, {"exact_commit": None}),
        claim("Q6", "sec:recipeexperiment; separate later check", "R8", [ref("R8/summary.json", "/baseline"), ref("R8/summary.json", "/final")], {"separate_check": 1}, ["bar", "g", "s"], "same recipe interface; different initial state", None, {"pressure_bar": [65, 70], "weight_g": [32.29, 32.55], "hold_time_s": 6}, {"seed": None, "exact_commit": None}),
        claim("CURRENT", "sec:testbed; current profile/scope tests", "R9", [ref("R9/tests/high-risk-tool-scope.test.ts", line=1), ref("R9/tests/tool-profile-observer.test.ts", line=1), ref("R9/tests/recipe-propose.test.ts", line=1), ref("R10/logs/final-independent-tests.log", line=1)], {"tests": 26, "subset_of_R10": True}, ["isolated software tests"], "current profile/tool authorization in temporary/mock state", SOURCE_REVISION, None, {"standalone_26_test_console_log": None}),
        claim("CURRENT", "sec:testbed; current composition checks", "R10", [ref("R10/tests/manual-approval-optimization.test.ts", line=1), ref("R10/tests/recipe-approval-snapshot.test.ts", line=1), ref("R10/logs/final-independent-tests.log", line=1)], {"combined_tests": 65}, ["isolated software tests"], "current approval/profile/recipe composition; no process-response E2E", SOURCE_REVISION, {"temporary_storage": True, "mock_IO": True}, {"complete_current_optimization_explore_process_trial": None}),
    ]
    write("CLAIM-MAP.json", {"schema": "claim-evidence-map/1.0", "missing_value_semantics": "null means not archived or not established; it is never an estimated value", "claims": rows})


def make_notes():
    # Compare original text, with Node readFileSync UTF-8 semantics (no newline translation).
    current_names = ["pipeline.mjs", "lib/util.mjs", "lib/sim.mjs", "lib/provision.mjs", "lib/metrics.mjs", "lib/dashboard.mjs", "lib/governance.mjs", "lib/closedloop.mjs", "lib/biax.mjs", "lib/scenarios.mjs", "lib/scenario-report.mjs"]
    current_hash = sha("\n%%\n".join((ROOT / "bench" / p).read_bytes().decode("utf-8") for p in current_names).encode())[:16]
    old_hash = sha("\n%%\n".join(git_bytes("bench/" + p).decode("utf-8") for p in current_names[:9]).encode())[:16]
    fingerprint = {"archive_harness_hash": "9f2756dce4a4cbb3", "archive_harness_files": 11, "recorded_commit": HISTORICAL, "committed_harness_files": 9, "committed_harness_hash": old_hash, "current_inspection_harness_files": 11, "current_inspection_harness_hash": current_hash, "exact_runtime_source_verified": current_hash == "9f2756dce4a4cbb3", "interpretation": "Committed source and current working source are different snapshots. File count and hash differences are explicit; recorded commit alone does not establish the exact dirty worktree used by a run."}
    write("SOURCE-SNAPSHOT-STATUS.json", fingerprint)
    original_r6 = (ROOT / R6 / "summary.json").read_bytes()
    duplicate = (ROOT / "bench/results/real-harness-injection-20261018/closedloop-summary.json").read_bytes()
    assert original_r6 == duplicate
    write("DUPLICATES.json", {"duplicate_pairs": [{"primary": "R6/summary.json", "duplicate": "R6/companion/closedloop-summary.json", "original_sha256": sha(original_r6), "adds_replication": False}, {"primary": "R3/benchmark-20261009033810/timeline.jsonl", "duplicate": "R4/timeline.jsonl", "adds_replication": False}], "R9_tests_are_subset_of_R10": True, "R8_is_distinct_initial_state_not_matched_replicate": True})
    write("MISSING-EVIDENCE.json", {"missing": [
        {"evidence_unit": "R1/R2", "field": "proven exact runtime working-tree harness", "value": None, "reason": "Run records 11-file hash; recorded commit contains a 9-file harness. Inspection copies are supplied separately."},
        {"evidence_unit": "R1", "field": "independent verification of original log capture origin", "value": None, "reason": "Origin is explicitly author-confirmed; hashes attest the observed files only."},
        {"evidence_unit": "R3/R5", "field": "exact run-time source commits and complete historical lockfiles", "value": None, "reason": "Version labels/configuration are archived but do not identify a complete source tree."},
        {"evidence_unit": "R5", "field": "October 8 full 34-check console log", "value": None, "reason": "Not located; dated report, October 17 original 22-check baseline console log, and current suite source supplied."},
        {"evidence_unit": "R6/R8", "field": "exact commit, simulator seed, per-sensor timestamp series", "value": None, "reason": "Summary does not record these fields; maximum aggregate timestamp is not a per-sensor freshness trace."},
        {"evidence_unit": "R6", "field": "melt temperature, raw physical PLC waveform", "value": None, "reason": "Melt temperature is null; controls are platform snapshots/receipts and all plants are simulators."},
        {"evidence_unit": "R9", "field": "standalone 26-test original console output", "value": None, "reason": "Not located; test sources and encompassing 65-test output are supplied, not counted as another test execution."},
        {"evidence_unit": "R10", "field": "current optimization_explore request-to-control-to-response process trial", "value": None, "reason": "Only isolated composition regressions are archived."},
        {"evidence_unit": "ALL", "field": "self-contained executable runtime/source installation", "value": None, "reason": "This anonymous supplement intentionally contains bounded source snapshots and data, not the full application, model assets, provider account or deployment database."}]})
    write("README.md", """# Anonymous experimental evidence supplement

This supplement accompanies the ten-page manuscript dated 2026-10-20. It
contains archived evidence R1–R10, original-output log copies, source inspection
snapshots, a claim map and validation receipts. All process experiments use
software simulators. No process run was rerun to prepare this package.

Use `CLAIM-MAP.json` to locate each claim by manuscript label, evidence unit,
relative file and JSON Pointer or 1-based line. `MANIFEST.json` lists each
source artifact's original and delivered SHA-256, byte counts, source-version
status and transformations. `FILES.json` hashes every delivered file except
itself. `VALIDATION.json` records structural, numeric, privacy and key-result
checks. Missing fields remain null in `MISSING-EVIDENCE.json`.

R1 is the integrated September archive; R2 is its mock admission ablation.
R3 contains all nine dated suite outputs with their timelines and reports;
R4 is an explicit copy of the final R3 timeline. R5 supplies dated ACK
reports and the original baseline console output. R6 is one successful
sequential recipe trajectory plus companion read-only agent evidence. R7
retains the earlier cadence-bound summary and all three archived failed
real-injection harness attempts. R8 is the separate later check from another
starting state. R9/R10 contain current isolated test sources and existing
outputs, including the pre-repair failure. Failed/boundary records are not
removed or converted into successful replicates.

`DUPLICATES.json` identifies repeated copies and overlapping software tests.
782 means software assertions across nine sequential suites; four pressure
commands and five quality snapshots in R6 are not five independent trials.
R6's companion summary is byte-identical in the original archive and does
not add replication. R8 is not appended to R6. The engine log terminal
51.7 micrometers and the logged 52.02-micrometer window mean are distinct
statistics, as are annealing 99.84-HV write-after and 100.08-HV terminal values.

Only copied files were anonymized: local account identifiers, credentials,
private path prefixes, project identity and identity-bearing repository URLs.
Stable generated task/node/recipe/run IDs, protocol names, measured values,
units, times, seeds, verification grades, success/failure results and their
join relations remain unchanged. Public manifests reveal no original local
source paths. Archive prose is historical evidence: its wording (including
claims of real execution) does not establish physical-plant validation.

Two original omp logs were explicitly confirmed by the author as outputs
saved when the experiment ran. That confirmation supersedes only the old
absence statement in R1/ARTIFACT-NOTES.md. File hashes are not independent
verification of capture origin. See DEPENDENCIES-AND-REPLAY.md before using
the inspection code; this package is not a standalone executable platform.
""")
    write("DEPENDENCIES-AND-REPLAY.md", """# Dependencies, analysis and replay boundaries

## Offline inspection (self-contained)

Python 3.11 or later is sufficient for `python verify_bundle.py`. This reads
only local files and reproduces the integrity checks. JSON/JSONL/CSV files
are standard UTF-8. No credentials or running service are needed.

The plotting source is in `code/current/figures/`. It requires Python,
Matplotlib and PyMuPDF, Arial or an explicitly chosen compatible font, and
the project's figure-QA helpers. Those external QA helpers and the whole
original directory layout are not redistributed here. Derived figure
tables are supplied for direct offline replotting; the original plotting
entry point expects its documented repository-relative layout. Its archived
source-path references locate evidence conceptually; copies in this package
are located through CLAIM-MAP.json. The manuscript source package contains
the publication artwork and editable SVG files.

## Source snapshots (inspection, not a complete deployment)

`code/recorded-commit/` is exported from the commit recorded by R1/R2.
That commit's harness contains nine fingerprinted files, whereas R1 records
eleven. `code/current/` is the current working-tree snapshot with source
hashes in MANIFEST.json. SOURCE-SNAPSHOT-STATUS.json compares fingerprints.
Neither the recorded commit label nor this inspection code should be
silently presented as the exact complete runtime source of the old run.
`code/recorded-simulator/` is the simulator gitlink associated with the
recorded main commit; the run's simulator dirty-tree state was not archived.
Current package.json declarations are included as dependency references;
no historical lockfile, full runtime, database, model or provider account
is reconstructed or asserted to be present.

## Historical entry points (require an isolated matching full repository)

- R1/Q1–Q4: `node bench/pipeline.mjs --profile integrated --seed 42
  --cl-seeds 3 --agent omp` is the run report's recorded invocation. A matching
  platform/simulator installation and engine-provider setup are needed.
- R2: `node bench/e1-lite.mjs --base <isolated-base> --seed 42 --repeats 3`;
  the server requires `AW_BENCH_MODE=1`. Mock fixtures are used.
- R3/R4: `node scripts/testing/run-benchmark.mjs --config <local-config>`.
  Replace account credentials and all selected line/node/recipe IDs with
  fixtures in the isolated installation. The bundled config preserves
  numerical settings but has intentionally unusable credential placeholders.
- R5: `AW_TOKEN=<local-token> AW_ONLY_ACK=1 node tmp-e2e/hardening-ack-gate.mjs`
  is the archived baseline invocation. A reachable isolated MQTT broker is
  necessary for D5; a skip must remain a skip.
- R6/R8: `node scripts/e2e-injection-recipe-closedloop.mjs` with a local
  `AW_BASE`/`AW_TOKEN`, provisioned injection nodes/recipe/context and the
  compatible tool interface. It performs writes and scripted approvals.
  The successful archive used emergency recipe trials and
  `AW_TRIAL_INTERVAL_MS=0`, with a 65-s wait before each quality query.
  The default 300-s cadence was exercised by the separate R7 boundary.
- R9/R10: in a compatible full application checkout, use its Node/tsx/TypeScript
  test runner and generated server tsconfig for the eight bundled test files.
  The original encompassing execution log records 65 passing isolated tests;
  the three R9 files form a 26-test subset, not another execution.

The historical integrated run records Node v24.19.0 on win32 x64. Current
dependency declarations require Node >=23.4.0 (platform), >=22.0.0 (simulator),
and pnpm 11.9.0; these are current declarations, not reconstructed historical
environment guarantees. Inspect the package.json dependency lists for the
real protocol libraries. Copied project identifiers use case-preserving
anonymous aliases: Platform in prose, platform for the CLI/package identity,
and PLATFORM_TEST for the test environment switch. The bin dictionary key is
also aliased. These copied inspection snippets require consistent identifier
restoration or matching aliases in a compatible full checkout before execution.
Embedded test passwords and local account names are redacted. Replaying
against a shared active service was not part of preparing this supplement.

The cast-film objective and finite-grid reference are inspectable in
`code/current/bench/lib/closedloop.mjs` and simulator `plant-model.ts`.
Energy/throughput terms are proxies. No unrestricted global optimum,
physical-plant efficacy, new optimizer superiority, human-subject benefit,
or hard real-time guarantee follows from these archives.
""")
    verifier = Path(__file__).with_name("verify_evidence.py")
    write("verify_bundle.py", verifier.read_text(encoding="utf-8"))


def validate():
    # All originals are checked again after copying; none are modified.
    for row in PRIVATE_ROWS:
        if row["source_revision"] in (HISTORICAL, SIM_HISTORICAL) and row["public_path"].startswith("code/recorded"):
            continue
        assert sha((ROOT / row["source_path"]).read_bytes()) == row["original_sha256"]
    paths = {row["path"] for row in ROWS}
    assert len(paths) == len(ROWS)
    mapping = json.loads((OUT / "CLAIM-MAP.json").read_text(encoding="utf-8"))
    for item in mapping["claims"]:
        item["manuscript_anchor"] = item["manuscript_anchor"].replace("sec:recipeexperiment", "sec:recipeexperiment")
        for artifact in item["artifacts"]:
            assert (OUT / artifact["path"]).is_file(), artifact
    write("CLAIM-MAP.json", mapping)
    privacy_hits = []
    for path in OUT.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in (r"[A-Za-z]:[\\/]+(?:Users|codes)[\\/]", r"agentworkshop|kingdol[A-Za-z0-9_-]*|\b87287\b", r"https?://(?:github|gitlab|gitee)\.com/", r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.", r"\but-[A-Za-z0-9]{20,}\b"):
            if re.search(pattern, text, re.I):
                privacy_hits.append({"path": str(path.relative_to(OUT)), "pattern": pattern})
        for secret in SECRETS:
            if secret and secret in text:
                privacy_hits.append({"path": str(path.relative_to(OUT)), "pattern": "credential_value"})
    assert not privacy_hits, [(x["path"], x["pattern"]) for x in privacy_hits]
    test_total = sum(json.loads(p.read_text(encoding="utf-8"))["score"]["total"] for p in (OUT / "R3").glob("*/benchmark.json"))
    assert test_total == 782
    r6 = json.loads((OUT / "R6/summary.json").read_text(encoding="utf-8"))
    assert (r6["baseline"]["p"], r6["baseline"]["t"], r6["baseline"]["q"]["weight"], r6["final"]["weight"], r6["final"]["sink"], r6["final"]["flash"]) == (45, 6, 31.28, 32.3, 1.277, 0.019)
    assert r6["baseline"]["q"]["melt"] is None and r6["final"]["melt"] is None
    counts = collections.Counter((row["arm"], row["verdict"]) for row in csv.DictReader((OUT / "R2/e1-lite.csv").open(encoding="utf-8")) if row["case"] == "attack")
    assert counts[("full", "rejected")] == 18 and counts[("no-readback", "rejected")] == 18
    assert counts[("no-interlock", "rejected")] == 12 and counts[("ungated", "rejected")] == 12
    return {"status": "PASS", "original_archives_unchanged": True, "json_jsonl_numeric_boolean_null_shape_preserved": True, "csv_numeric_cells_preserved": True, "claim_artifact_paths_resolve": True, "private_identity_path_credentials_scan": "PASS", "software_assertions": test_total, "R6_key_values_and_missing_melt": "PASS", "R2_attack_counts": "PASS", "source_artifacts": len(ROWS), "independent_process_replays_executed": 0}


if __name__ == "__main__":
    main()
