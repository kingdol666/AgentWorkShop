"""Package the finalized anonymous manuscript and a historical-evidence extension.

Run --self-test while editing. Run --finalized only after the final PDF has
been compiled and checked. Original evidence and the October 20 ZIP are
read-only inputs; only delivery copies receive identity/path redaction.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent / "SUBMISSION-IEEE-TII"
REPO = HERE.parents[2]
R22_ROOT = (REPO / "docs/audit/evidence/2026-10-25-current-cross-scene/"
            "direct-rest-trial-2026-10-25/run-EycMP7")
R23_ROOT = (REPO / "docs/audit/evidence/2026-10-25-current-cross-scene/"
            "r23-pi-registered-harness-20261025-031055-5cfe66")
PRIOR_DATA = HERE.parent / "revision-2026-10-20"
BASE_ZIP = HERE.parent / "final-revision-2026-10-20" / "IEEE-TII-anonymous-evidence.zip"
SOURCE_NAME = "IEEE-TII-manuscript-source-2026-10-25.zip"
EVIDENCE_NAME = "IEEE-TII-anonymous-evidence-2026-10-25.zip"
PDF_NAME = "IEEE-TII-manuscript-2026-10-25.pdf"
REVISION = "2026-10-25"
TEXT_SUFFIXES = {".md", ".txt", ".json", ".jsonl", ".csv", ".log", ".tex",
                 ".bib", ".bbl", ".py", ".mjs", ".js", ".ts", ".svg", ".eps"}
# A drive letter must start a word and have exactly one path separator after
# its colon. In particular, neither the p:/ in http:// nor the s:/ in https://
# is a Windows path. JSON strings are decoded before this rule is applied.
DRIVE_PATH = re.compile(r"(?i)(?<![A-Za-z0-9_])\b[A-Z]:[\\/](?![\\/])[^\s\"<>`]+")
LOCAL_USER = re.compile(r"(?<![:/])/(?:Users|home)/[^/\s\"<>`]+(?:/[^\s\"<>`]+)?")
# AgentWorkShop is the framework studied in the manuscript, not an author identity.
# Keep the bounded scan focused on author/account identifiers and private repository URLs.
IDENTITIES = re.compile(r"\b(?:87287|Diane Williams|kingdol666|kingdol)\b", re.I)
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

    evidence_path = HERE / "qa/current-registered-harness/R20/evidence.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8-sig"))
    matrix, rows = build_r20_trace_matrix(evidence)
    assert len(rows) == 6
    assert len(matrix.decode("utf-8").splitlines()) == 7
    assert {row["execution_key"] for row in rows} == {
        "cast-film-r1", "cast-film-r2", "cast-film-r3",
        "annealing-r1", "annealing-r2", "annealing-r3",
    }
    assert all(row["task_state_after_sample_query"] == "COMPLETED" for row in rows)
    print("PASS R20 trace matrix: six unique task/run/approval/receipt/sample joins validated")

    r21_path = HERE / "qa/current-registered-harness/R21/evidence.json"
    r21 = json.loads(r21_path.read_text(encoding="utf-8-sig"))
    r21_matrix, r21_rows = build_r21_trace_matrix(r21)
    assert len(r21_rows) == 2
    assert len(r21_matrix.decode("utf-8").splitlines()) == 3
    assert {row["scene"] for row in r21_rows} == {"cast-film", "annealing"}
    assert all(row["verified_count"] == "1" for row in r21_rows)
    assert all(row["returned_sample_run_id"] == row["active_run_id"] for row in r21_rows)
    print("PASS R21 fixture trace matrix: two task/approval/receipt/run/sample joins validated")

    r22_path = R22_ROOT / "evidence.json"
    r22 = json.loads(r22_path.read_text(encoding="utf-8-sig"))
    summary = validate_r22(r22, REPO / "scripts/e2e-direct-rest-simulator-paper.mjs")
    assert summary["scenes"] == ["cast-film", "annealing"]
    print("PASS R22 direct-operation evidence: two calls, receipt/readback/sample joins, 19 checks, source hash")

    r23_runner = R23_ROOT / "e2e-pi-simulator-paper.mjs"
    r23 = json.loads((R23_ROOT / "evidence.json").read_text(encoding="utf-8-sig"))
    r23_trace, r23_rows, r23_summary = validate_r23(r23, r23_runner)
    assert len(r23_rows) == 2 and len(r23_trace.decode("utf-8").splitlines()) == 3
    assert r23_summary["sample_values"] == {"cast-film": 46.38, "annealing": 674.4000244140625}
    print("PASS R23 Pi fixture evidence: two completed tasks, approval/receipt/sample links, 37+28 checks, source hash")


def build_r21_trace_matrix(evidence: dict) -> tuple[bytes, list[dict]]:
    """Validate the deterministic R21 task fixture joins without asserting task completion."""
    experiment = evidence["experiment"]
    assert evidence["status"] == "passed"
    assert experiment["projectVersion"] == "0.8.0"
    assert "no LLM" in experiment["fixture"]
    assert not experiment.get("runOutcomes")
    assert len(evidence["checks"]) == 31
    assert all(check["status"] == "pass" for check in evidence["checks"])
    assert evidence["cleanup"]["status"] == "passed"
    assert evidence["isolation"]["result"] == "passed"
    isolation_checks = evidence["isolation"]["checks"]
    assert len(isolation_checks) == 25
    assert all(check["status"] == "pass" for check in isolation_checks)

    scenes = experiment["scenes"]
    assert [scene["id"] for scene in scenes] == ["cast-film", "annealing"]
    rows = []
    for scene in scenes:
        scene_id = scene["id"]
        task_id = scene["taskId"]
        assert scene["status"] == "verified" and task_id
        fixture_trace = scene["fixtureTrace"]
        assert fixture_trace["hostToolCallCount"] == 1
        assert fixture_trace["toolName"] == "recipe_trial"
        assert fixture_trace["resultReceived"] is True

        approvals = scene["approvals"]
        assert len(approvals) == 1
        approval = approvals[0]
        assert approval["decision"] == "approve"
        assert approval["statusAfterDecision"] == "approved"

        active_run_id = scene["activeRun"]["id"]
        trial = scene["trial"]
        assert trial["approvalId"] == approval["id"]
        ack = trial["ackSummary"]
        assert ack == {"verified": 1, "unverified": 0, "failed": 0, "total": 1}
        readback = scene["readback"]
        assert readback["resultMatchesCandidate"] is True
        assert readback["response"]["ok"] is True

        daq = scene["daq"]
        assert daq["sampleCount"] == 1
        assert daq["expectedActiveRunId"] == active_run_id
        assert daq["runTags"] == [active_run_id]
        query = daq["taggedQuery"]
        assert query["requestedRunId"] == active_run_id
        assert query["returnedRunId"] == active_run_id
        assert query["probeValueMatched"] is True
        point = query["matchingProbePoint"]
        sample_value = daq["probe"]["sampleValue"]
        assert math.isclose(float(point["v"]), float(sample_value), rel_tol=1e-6, abs_tol=1e-6)
        assert daq["ingest"]["accepted"] is True

        rows.append({
            "scene": scene_id,
            "task_id": task_id,
            "approval_id": approval["id"],
            "active_run_id": active_run_id,
            "trial_run_id": trial["runId"],
            "verified_count": str(ack["verified"]),
            "unverified_count": str(ack["unverified"]),
            "failed_count": str(ack["failed"]),
            "expected_sample_run_id": daq["expectedActiveRunId"],
            "returned_sample_run_id": query["returnedRunId"],
            "sample_value": sample_value,
            "fixture_tool_calls": str(fixture_trace["hostToolCallCount"]),
        })

    for field in ("task_id", "approval_id", "active_run_id", "trial_run_id"):
        assert len({row[field] for row in rows}) == len(rows)
    output = io.StringIO(newline="")
    fieldnames = [
        "scene", "task_id", "approval_id", "active_run_id", "trial_run_id",
        "verified_count", "unverified_count", "failed_count",
        "expected_sample_run_id", "returned_sample_run_id", "sample_value",
        "fixture_tool_calls",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8"), rows


def validate_r22(evidence: dict, runner: Path) -> dict:
    """Validate direct-operation receipts, run-tagged snapshots, checks, and runner identity."""
    experiment = evidence["experiment"]
    assert evidence["status"] == "passed"
    assert experiment["projectVersion"] == "0.8.0"
    assert experiment["route"] == "POST /api/workshop/agent-tools/invoke"
    assert "no harness transport or LLM decision" in experiment["executionMode"]
    assert runner.is_file()
    assert experiment["sourceIdentity"]["scriptSha256"] == sha(runner.read_bytes())
    assert len(evidence["checks"]) == 19
    assert all(check["status"] == "pass" for check in evidence["checks"])
    assert evidence["isolation"]["result"] == "passed"
    assert evidence["cleanup"]["status"] == "passed"
    scenes = experiment["scenes"]
    assert [scene["id"] for scene in scenes] == ["cast-film", "annealing"]
    for scene in scenes:
        assert scene["status"] == "verified"
        assert scene["invocation"]["httpStatus"] == 200
        assert scene["invocation"]["toolResult"]["isError"] is False
        assert scene["approval"]["statusAfterDecision"] == "approved"
        assert scene["trial"]["ackSummary"] == {
            "verified": 1, "unverified": 0, "failed": 0, "total": 1}
        assert scene["readback"]["matches"] is True
        observation = scene["observation"]
        assert observation["queryRunId"] == scene["activeRun"]["id"]
        assert observation["acceptedIngest"] is True
        assert observation["withinTargetBand"] is False
        assert observation["value"] < observation["targetBand"]["min"] or observation["value"] > observation["targetBand"]["max"]
    return {"scenes": [scene["id"] for scene in scenes],
            "direct_calls": len(scenes), "verified_receipts": len(scenes),
            "run_tagged_snapshots": len(scenes), "runner_checks_passed": len(evidence["checks"]),
            "target_attainment": False, "cross_harness_portability": False}


def validate_r23(evidence: dict, runner: Path) -> tuple[bytes, list[dict], dict]:
    """Validate Pi fixture task-to-operation evidence and produce its trace matrix."""
    experiment = evidence["experiment"]
    assert evidence["status"] == "passed" and evidence["schemaVersion"] == 1
    assert experiment["projectVersion"] == "0.8.0"
    assert experiment["harnessMode"] == "pi-local-fixture"
    assert experiment["provider"] == "agentworkshop-local"
    assert experiment["trialsPerScene"] == 1
    assert experiment["postTrialSnapshotDelaySeconds"] == 20
    assert "deterministic" in experiment["modelFixture"] and "no LLM" in experiment["modelFixture"]
    assert runner.is_file()
    harness = experiment["sourceIdentity"]["registeredHarness"]
    assert harness["harness"] == "pi" and harness["externalCredentialsUsed"] is False
    assert experiment["sourceIdentity"]["experimentScriptSha256"] == sha(runner.read_bytes())
    assert len(evidence["checks"]) == 37
    assert all(check["status"] == "pass" for check in evidence["checks"])
    isolation_checks = evidence["isolation"]["checks"]
    assert len(isolation_checks) == 28 and all(check["status"] == "pass" for check in isolation_checks)
    assert evidence["isolation"]["result"] == "passed"
    assert evidence["cleanup"]["status"] == "passed"

    scenes = experiment["scenes"]
    assert [scene["id"] for scene in scenes] == ["cast-film", "annealing"]
    rows = []
    for scene in scenes:
        scene_id = scene["id"]
        task_id = scene["taskId"]
        approval = scene["approvals"][0]
        active_run_id = scene["activeRun"]["id"]
        trial = scene["trial"]
        readback = scene["readback"]
        daq = scene["daq"]
        assert scene["status"] == "verified" and task_id
        assert approval["taskId"] == task_id
        assert approval["decision"] == "approve" and approval["statusAfterDecision"] == "approved"
        assert trial["taskId"] == task_id and trial["approvalId"] == approval["id"]
        assert trial["ackSummary"] == {"verified": 1, "unverified": 0, "failed": 0, "total": 1}
        assert readback["resultMatchesCandidate"] is True and readback["response"]["ok"] is True
        assert scene["modelExecution"]["harness"] == "registered Pi CLI adapter"
        assert scene["modelExecution"]["taskCompleted"] is True
        assert scene["modelExecution"]["taskAssigneeMatchesRegisteredPi"] is True
        assert len(scene["modelExecution"]["modelApiRequests"]) == 3
        assert all(request["loopbackPeer"] for request in scene["modelExecution"]["modelApiRequests"])
        assert daq["sampleCount"] == 1 and daq["expectedActiveRunId"] == active_run_id
        assert daq["taggedQuery"]["requestedRunId"] == active_run_id
        assert daq["taggedQuery"]["returnedRunId"] == active_run_id
        assert daq["taggedQuery"]["probeValueMatched"] is True
        assert daq["ingest"]["accepted"] is True
        stimulus = scene["decisionStimulus"]
        sample_value = daq["probe"]["sampleValue"]
        assert sample_value < stimulus["targetMin"] or sample_value > stimulus["targetMax"]
        rows.append({
            "scene": scene_id,
            "task_id": task_id,
            "approval_id": approval["id"],
            "recipe_id": scene["entities"]["recipeId"],
            "trial_run_id": trial["runId"],
            "active_run_id": active_run_id,
            "daq_node_id": daq["nodeId"],
            "returned_sample_run_id": daq["taggedQuery"]["returnedRunId"],
            "candidate": str(readback["expectedCandidate"]),
            "readback_verified": str(trial["ackSummary"]["verified"]),
            "sample_value": sample_value,
            "target_min": stimulus["targetMin"],
            "target_max": stimulus["targetMax"],
            "task_completed": str(scene["modelExecution"]["taskCompleted"]).lower(),
        })
    assert len({row["task_id"] for row in rows}) == 2
    output = io.StringIO(newline="")
    fields = list(rows[0])
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    summary = {"task_executions": len(scenes), "scenes": [scene["id"] for scene in scenes],
               "completed_tasks": len(scenes), "synthetic_approvals": len(scenes),
               "verified_receipts": len(scenes), "readback_verified": len(scenes),
               "run_tagged_samples": len(scenes), "runner_checks_passed": len(evidence["checks"]),
               "runner_checks_failed": 0, "isolation_checks_passed": len(isolation_checks),
               "post_trial_wait_seconds": experiment["postTrialSnapshotDelaySeconds"],
               "model_provider": experiment["provider"], "model_fixture": experiment["model"],
               "external_model_decisions": 0,
               "sample_values": {row["scene"]: row["sample_value"] for row in rows},
               "candidates": {row["scene"]: float(row["candidate"]) for row in rows},
               "target_bands": {row["scene"]: [row["target_min"], row["target_max"]] for row in rows},
               "target_attainment": False, "general_harness_interchangeability": False}
    return output.getvalue().encode("utf-8"), rows, summary


def build_r20_trace_matrix(evidence: dict) -> tuple[bytes, list[dict]]:
    """Validate and serialize the R20 task-to-run-to-sample evidence joins."""
    experiment = evidence["experiment"]
    outcomes = experiment["runOutcomes"]
    scenes = {scene["id"]: scene for scene in experiment["scenes"]}
    checks = {check["id"]: check for check in evidence["checks"]}
    expected_keys = [
        "cast-film-r1", "cast-film-r2", "cast-film-r3",
        "annealing-r1", "annealing-r2", "annealing-r3",
    ]
    assert [outcome["id"] for outcome in outcomes] == expected_keys
    assert len(evidence["checks"]) == 76
    assert evidence["status"] == "passed"
    assert all(check["status"] == "pass" for check in evidence["checks"])
    for field in ("taskId", "runId", "trialRunId"):
        assert len({outcome[field] for outcome in outcomes}) == len(expected_keys)

    rows = []
    for outcome in outcomes:
        key = outcome["id"]
        scene = scenes[outcome["evidenceSceneId"]]
        assert scene["id"] == key
        assert scene["taskId"] == outcome["taskId"]
        assert outcome["taskState"] == "COMPLETED"

        active_run_id = scene["activeRun"]["id"]
        assert active_run_id == outcome["runId"]
        assert scene["daq"]["expectedActiveRunId"] == active_run_id

        approvals = scene["approvals"]
        assert len(approvals) == 1
        approval = approvals[0]
        assert approval["decision"] == "approve"
        assert approval["statusAfterDecision"] == "approved"

        trial = scene["trial"]
        assert trial["runId"] == outcome["trialRunId"]
        assert trial["approvalId"] == approval["id"]
        ack = trial["ackSummary"]
        assert ack == {"verified": 1, "unverified": 0, "failed": 0, "total": 1}

        ack_check = checks[f"{key}-ack-verified"]
        readback_check = checks[f"{key}-readback-matches"]
        sample_check = checks[f"{key}-run-tagged-daq-probe-ingest-snapshot"]
        task_check = checks[f"{key}-real-omp-task-completed"]
        assert all(item["status"] == "pass" for item in
                   (ack_check, readback_check, sample_check, task_check))
        assert readback_check["detail"]["resultMatchesCandidate"] is True
        assert task_check["detail"]["taskState"] == "COMPLETED"

        daq = scene["daq"]
        tagged_query = daq["taggedQuery"]
        expected_sample_run_id = tagged_query["requestedRunId"]
        returned_sample_run_id = tagged_query["returnedRunId"]
        assert expected_sample_run_id == returned_sample_run_id == active_run_id
        assert tagged_query["seriesPointCount"] == 1
        assert tagged_query["probeValueMatched"] is True
        sample_value = daq["probe"]["sampleValue"]
        assert math.isclose(sample_value, tagged_query["matchingProbePoint"]["v"],
                            rel_tol=0, abs_tol=1e-6)
        assert math.isclose(sample_value, sample_check["detail"]["value"],
                            rel_tol=0, abs_tol=1e-6)
        assert sample_check["detail"]["runId"] == active_run_id
        assert math.isclose(sample_value, sample_check["detail"]["matchingPoint"]["v"],
                            rel_tol=0, abs_tol=1e-6)

        rows.append({
            "execution_key": key,
            "task_id": outcome["taskId"],
            "active_run_id": active_run_id,
            "approval_id": approval["id"],
            "recipe_trial_id": outcome["trialRunId"],
            "verified_count": ack["verified"],
            "unverified_count": ack["unverified"],
            "failed_count": ack["failed"],
            "expected_sample_run_id": expected_sample_run_id,
            "returned_sample_run_id": returned_sample_run_id,
            "sample_value": sample_value,
            "task_state_after_sample_query": task_check["detail"]["taskState"],
        })

    output = io.StringIO(newline="")
    fieldnames = [
        "execution_key", "task_id", "active_run_id", "approval_id",
        "recipe_trial_id", "verified_count", "unverified_count", "failed_count",
        "expected_sample_run_id", "returned_sample_run_id", "sample_value",
        "task_state_after_sample_query",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8"), rows


def zip_payload(path: Path, payload: dict[str, bytes]) -> None:
    temp = path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 25, 0, 0, 0))
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
    assert len(tex) == 8, "Expected main and seven section sources"
    joined = "\n".join(path.read_text(encoding="utf-8") for path in tex)
    figures = [PAPER / item for item in re.findall(r"\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}", joined)]
    assert len(figures) == 3 and len(set(figures)) == 3, "Expected three active graphic assets"
    local = [*tex, PAPER / "main.pdf", PAPER / "main.bbl", *figures,
             *(path.with_suffix(".svg") for path in figures),
             PAPER / "resources/fig-architecture-2026-9pt.eps", PAPER / "resources/fig-runtime-2026-9pt.eps",
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
        "October 20 anonymous bundle and adds October 23 failed boundary checks plus the October 25 "
        "v0.8.0 isolated software rerun and two-scene simulator integration records under "
        "revision-2026-10-25/. The Q7 datasets failed optimization eligibility or validation gates; "
        "they produced no recommendation or dispatch. R20 records six model-selected registered-harness "
        "task executions across two simulator scenes; all six completed with verified receipts, but all "
        "single post-trial samples remained outside target. The DAQ query used an isolated SQLite fallback; "
        "the executions are not independent replications or process-convergence evidence. R16 is retained "
        "as a separate deterministic fixture diagnostic. R21 separately verifies the deterministic local "
        "OMP-RPC fixture on v0.8.0 in two scenes without an LLM decision; it is not a live-agent replication. "
        "R22 separately tests two direct REST operation calls across the same simulator scenes, with verified "
        "receipts/readbacks and run-tagged snapshots outside target; it is not process-response evidence. R23 separately "
        "tests two completed tasks through the registered Pi adapter using a deterministic loopback model fixture; both "
        "task/approval/receipt/sample links are recorded and both samples remain outside target. This is not Pi model "
        "quality or general harness-interchangeability evidence.\n"
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
    r20_evidence_path = HERE / "qa/current-registered-harness/R20/evidence.json"
    r20_evidence = json.loads(r20_evidence_path.read_text(encoding="utf-8-sig"))
    r20_trace_csv, r20_trace_rows = build_r20_trace_matrix(r20_evidence)
    r21_evidence_path = HERE / "qa/current-registered-harness/R21/evidence.json"
    r21_evidence = json.loads(r21_evidence_path.read_text(encoding="utf-8-sig"))
    r21_trace_csv, r21_trace_rows = build_r21_trace_matrix(r21_evidence)
    r22_evidence_path = R22_ROOT / "evidence.json"
    r22_evidence = json.loads(r22_evidence_path.read_text(encoding="utf-8-sig"))
    r22_summary = validate_r22(r22_evidence, REPO / "scripts/e2e-direct-rest-simulator-paper.mjs")
    r23_evidence_path = R23_ROOT / "evidence.json"
    r23_evidence = json.loads(r23_evidence_path.read_text(encoding="utf-8-sig"))
    r23_runner = R23_ROOT / "e2e-pi-simulator-paper.mjs"
    r23_trace_csv, r23_trace_rows, r23_summary = validate_r23(r23_evidence, r23_runner)
    r21_runner = REPO / "scripts/e2e-registered-harness-simulator-paper.mjs"
    r20_runner = HERE / "qa/current-registered-harness/R20/e2e-registered-harness-simulator-paper.mjs"
    assert r21_runner.is_file() and r20_runner.is_file()
    assert sha(r21_runner.read_bytes()) == sha(r20_runner.read_bytes())
    assert (REPO / "scripts/fixtures/omp-paper-harness.mjs").is_file()
    # Keep the original ZIP unchanged. Refresh only the delivered root index
    # and claim map, plus the previously documented metadata privacy repair.
    changed_base = {}
    payload["README.md"] = (
        "# Anonymous experimental evidence supplement\n\n"
        "This delivered copy accompanies the October 25 IEEE TII manuscript. It extends the October 20 "
        "historical archive with R11/R12 boundary records, the current-version Q7 integration run (R13), "
        "its exploratory signal-pair pilot (R14), an earlier infrastructure-blocked attempt (R15), the "
        "deterministic registered-harness fixture (R16), the current model-driven run (R20), and the "
        "separate current-version deterministic fixture verification (R21), direct REST operation run (R22), and "
        "registered Pi local-fixture task run (R23). "
        "The source October 20 ZIP remains unchanged.\n\n"
        "Use `CLAIM-MAP.json` to locate manuscript claims by evidence unit and artifact path. `MANIFEST.json` "
        "records source and delivered hashes, byte counts, and copy transformations. `FILES.json` hashes "
        "the delivered entries except itself. `VALIDATION.json`, `DUPLICATES.json`, and "
        "`MISSING-EVIDENCE.json` retain their original archive scope. The October 25 extension manifest "
        "documents every root-copy change and added artifact.\n\n"
        "R1--R10 are historical evidence. R11/R12 preserve failed boundary checks. R13 ran a local v0.8.0 "
        "application-level integration script against two isolated repository simulators: protocol reads, bounded writes, "
        "readback, and dataset lineage passed, but both model candidates failed eligibility or validation gates; "
        "no optimization recommendation or dispatch was produced. R14 records the exploratory signal-pair pilot "
        "that preceded R13 and is not pooled with it. R15 stopped before line creation or process sampling. "
        "R16 records a deterministic fixture diagnostic and is not pooled with the current model-driven run. "
        "R20 records six sequential registered-agent task executions, three per scene, using one simulator "
        "instance per scene. Each receives synthetic approval, one route-specific recipe-trial record, and a 1/1 "
        "verified readback. After verifying the route ACK and returned trial result, the runner waits 20 s, "
        "probes and ingests one sample, queries it by active run ID, and then checks task state. No task-completion "
        "timestamp was retained, so task-completion-to-sample latency is unrecorded. The generated "
        "`revision-2026-10-25/R20/R20-TRACE-MATRIX.csv` maps each execution key to its task, run, approval, "
        "trial, receipt checks, sample run IDs, value, and post-query task state; `R20/evidence.json`, logs, "
        "runner, and source snapshot retain the underlying records. "
        "The sample is ingested through "
        "an isolated SQLite fallback; all six remain outside target bands. This does not establish independent "
        "replication, convergence, quality improvement, normal online DAQ performance, or portability. All "
        "plant tests use software simulators; no physical-plant transfer, successful current-version optimization, "
        "or comparative control benefit is established. R20 records source hashes and working-tree state; the "
        "reported run is not an exact historical commit replay. R13's report did not pin the application, test-script, "
        "simulator, or installed dependency identities at execution; R13-PROVENANCE.json gives retrospective "
        "source context and states this limitation. R21 separately reruns the deterministic local OMP-RPC "
        "fixture on v0.8.0 in two scenes without an LLM decision. Each task context produced one approved "
        "recipe trial, verified receipt/readback, and active-run-tagged sample; 31 runner assertions and 25 "
        "isolation assertions passed, including cleanup. This is a deterministic software path check, not a "
        "live-agent replication, task-completion result, process-performance test, or second R20 repetition. "
        "See `revision-2026-10-25/R21/R21-TRACE-MATRIX.csv` and its evidence and logs. R22 separately tests "
        "the direct REST tool endpoint, one bounded call per scene, without a task, harness transport, or LLM. "
        "Each synthetic approval produced a 1/1 verified receipt/readback and one active-run-tagged snapshot; "
        "both snapshots were outside target. All 19 checks passed. R22 broadens invocation-route coverage, "
        "not process response; its run records and runner are under R22/. R23 exercises the registered Pi CLI "
        "adapter with a deterministic loopback fixture, one task per scene, no external model decision, synthetic "
        "approval, verified receipt/readback, and a run-tagged sample after 20 s. Both tasks completed and both "
        "samples were below target; 37 application and 28 isolation checks passed. The R23 trace matrix joins "
        "task, approval, trial, active run, and sample; this verifies the tested route only, not Pi model quality, "
        "general adapter interchangeability, or process response.\n"
        "\n"
        "Only delivery copies were anonymized or refreshed. Historical R1--R10 numerical entries remain "
        "byte-identical. Failed outcomes were retained. Raw data, fit artifacts, scripts, and source hashes "
        "are included where available; this is not a standalone executable distribution.\n"
    ).encode("utf-8")
    claim_map = json.loads(payload["CLAIM-MAP.json"])
    assert not any(item.get("question") in {"Q7", "Q7-PILOT", "Q9", "Q10", "Q11"} for item in claim_map["claims"])
    claim_map["claims"].extend([
        {
            "question": "Q7",
            "manuscript_anchor": "sec:crossscene; current-version two-scene simulator integration",
            "evidence_unit": "R13",
            "artifacts": [
                {"path": "revision-2026-10-25/R13/report.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R13-PROVENANCE.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R13/dataset-film/manifest.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R13/dataset-anneal/manifest.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R13/job-film-artifacts/metrics.json", "json_pointer": "/platform", "line": None},
                {"path": "revision-2026-10-25/R13/job-anneal-artifacts/metrics.json", "json_pointer": "/platform", "line": None}
            ],
            "n": {"scenes": 2, "windows_per_scene": 6, "daq_points": {"cast_film": 697, "annealing": 696},
                  "dataset_rows": {"cast_film": 658, "annealing": 655},
                  "held_out_test_rows": {"cast_film": 220, "annealing": 218}, "passed_checks": 50,
                  "failed_checks": 0, "gate_blocked_outcomes": 2, "recommendations": 0, "dispatches": 0},
            "units": ["DAQ points", "dataset rows", "correlation", "NRMSE", "percent improvement"],
            "interface": "Local v0.8.0 working tree; registered protocol drivers to isolated repository simulators; no physical equipment or LLM service",
            "source_version": "Run-time source identity not recorded; retrospective context and limits in revision-2026-10-25/R13-PROVENANCE.json",
            "configuration": {"cast_film": "ScrewSpeedSP OPC UA -> thick MQTT", "annealing": "zone-3 furnace setpoint -> StripTemp Modbus TCP",
                              "sampling": "1 s; six sequential 120-s windows per scene", "model": "linear_arx@1, seed 42",
                              "eligibility": "delayed-response correlation >= 0.2; test NRMSE <= 0.10; rollout improvement >= 20%"},
            "missing_fields": {"independent_scene_replicates": None, "physical_plant_validation": None,
                               "successful_optimization_recommendation": None, "cross_harness_portability": None}
        },
        {
            "question": "Q7-PILOT",
            "manuscript_anchor": "sec:crossscene; exploratory signal-pair selection history",
            "evidence_unit": "R14",
            "artifacts": [
                {"path": "revision-2026-10-25/R14/report.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R14/dataset-film/manifest.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R14/dataset-anneal/manifest.json", "json_pointer": "", "line": None}
            ],
            "n": {"scenes": 2, "daq_points_per_scene": 582, "dataset_rows": {"cast_film": 539, "annealing": 538},
                  "passed_checks": 51, "failed_checks": 0, "gate_blocked_outcomes": 2},
            "units": ["DAQ points", "dataset rows", "correlation", "NRMSE", "percent improvement"],
            "interface": "Local v0.8.0 working tree; exploratory simulator pilot; outcomes informed later signal-pair selection",
            "source_version": "Run-time source identity not recorded; exploratory pilot source is not pinned",
            "configuration": {"cast_film": "screw speed -> melt pressure", "annealing": "zone-1 temperature setpoint -> furnace temperature",
                              "use": "selection history only; not pooled with R13"},
            "missing_fields": {"independent_scene_replicates": None, "physical_plant_validation": None}
        },
        {
            "question": "Q8",
            "manuscript_anchor": "sec:harness-e2e; current registered-harness process path",
            "evidence_unit": "R20",
            "artifacts": [
                {"path": "revision-2026-10-25/R20/evidence.json", "json_pointer": "/experiment/runOutcomes", "line": None},
                {"path": "revision-2026-10-25/R20/evidence.json", "json_pointer": "/experiment/scenes", "line": None},
                {"path": "revision-2026-10-25/R20/evidence.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R20/R20-TRACE-MATRIX.csv", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R20/R20-SUMMARY.md", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R20/agentworkshop.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R20/simulator.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R20/e2e-registered-harness-simulator-paper.mjs", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R20/source-snapshot/", "json_pointer": "", "line": None}
            ],
            "n": {"task_executions": 6, "scenes": 2, "sequential_executions_per_scene": 3,
                  "completed_tasks": 6, "synthetic_approvals": 6,
                  "verified_ack_readback": "1/1 in each execution",
                  "run_tagged_daq_samples": 6, "points_per_sample": 1,
                  "post_trial_wait_seconds": 20, "runner_checks_passed": 76,
                  "runner_checks_failed": 0, "trace_complete_executions": len(r20_trace_rows),
                  "post_trial_values": {"cast_film_um": [45.69, 46.69, 45.69],
                                         "annealing_C": [679.60, 677.70, 678.10]},
                  "target_attainment": {"cast_film": 0, "annealing": 0}},
            "execution_keys": [row["execution_key"] for row in r20_trace_rows],
            "trace_matrix": "revision-2026-10-25/R20/R20-TRACE-MATRIX.csv",
            "trace_join": "For each key, evidence.json links taskId to a unique active runId and approvalId to recipe trialRunId; the verified receipt checks and run-tagged sample query match that runId, and task completion is checked after the sample query.",
            "units": ["simulator command", "readback", "DAQ sample", "target band"],
            "interface": "Local v0.8.0 working-tree application; registered OMP adapter and glm-5.3-flash; repository simulators; synthetic approval; SQLite time-series fallback",
        "source_version": "R20/source-snapshot conditionally reconstructs app and simulator working trees from recorded base commits, lockfiles, and exact prompt assets; package manifests come from the base commits and external model decisions are not deterministic",
            "configuration": {"cast_film": "ScrewSpeedSP OPC UA -> thickness MQTT; candidates 125/130/135 rpm; target 48--52 um",
                              "annealing": "zone-3 setpoint Modbus TCP -> StripTemp Modbus TCP; candidates 735/740/745 C; target 700--760 C",
                              "sampling": "verified route ACK and returned trial result -> 20-s delay -> one driver probe -> ingest -> active-run-tagged query -> task-state check; task-completion timestamp and task-completion-to-sample latency are not recorded; one persistent simulator per scene",
                              "approval": "synthetic isolated administrator via protected approval API"},
            "missing_fields": {"independent_replicates": None, "normal_online_daq_backend": None,
                               "controlled_profile_binding_comparison": None, "process_trajectory": None,
                               "physical_plant_validation": None, "cross_harness_portability": None}
        },
        {
            "question": "Q8-DIAGNOSTIC",
            "manuscript_anchor": "supplement; earlier deterministic registered-harness fixture diagnostic",
            "evidence_unit": "R16",
            "artifacts": [
                {"path": "revision-2026-10-25/R16/evidence.json", "json_pointer": "/experiment/scenes", "line": None},
                {"path": "revision-2026-10-25/R16/fixture-cast-film.json", "json_pointer": "/hostToolCalls", "line": None},
                {"path": "revision-2026-10-25/R16/fixture-annealing.json", "json_pointer": "/hostToolCalls", "line": None},
                {"path": "revision-2026-10-25/R16/R16-SUMMARY.md", "json_pointer": "", "line": None}
            ],
            "n": {"scenes": 2, "fixture_host_tool_calls": 2, "manual_approvals": 2,
                  "verified_ack_readback": {"cast_film": "1/1", "annealing": "1/1"},
                  "run_tagged_daq_snapshots": 2, "points_per_snapshot": 1,
                  "post_trial_wait_seconds": 20,
                  "snapshot_values": {"cast_film_um": 46.37, "annealing_C": 674.799988}},
            "units": ["simulator command", "readback", "DAQ snapshot"],
            "interface": "Local v0.8.0 working-tree application; registered omp adapter and shared dispatcher; loopback repository simulators",
            "source_version": "Evidence records application and simulator source-tree hashes, git heads, working-tree state, fixture hashes, and run-script hash; see R16/evidence.json",
            "configuration": {"cast_film": "ScrewSpeedSP 120->125 rpm via OPC UA", "annealing": "zone-3 setpoint 730->735 C via Modbus TCP",
                              "agent": "deterministic local OMP-RPC fixture; not an LLM or autonomous decision",
                              "approval": "synthetic isolated administrator via protected approval API",
                              "DAQ": "one explicit driver probe and ingest per scene after 20 s; SQLite fallback"},
            "missing_fields": {"process_trajectory": None, "convergence": None, "quality_improvement": None,
                               "physical_plant_validation": None, "cross_harness_portability": None}
        },
        {
            "question": "Q9",
            "manuscript_anchor": "sec:fixture-replay; current-version deterministic registered-harness fixture path",
            "evidence_unit": "R21",
            "artifacts": [
                {"path": "revision-2026-10-25/R21/evidence.json", "json_pointer": "/experiment/scenes", "line": None},
                {"path": "revision-2026-10-25/R21/evidence.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R21/R21-TRACE-MATRIX.csv", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/README.md", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/agentworkshop.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/simulator.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/fixture-cast-film.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/fixture-annealing.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/e2e-registered-harness-simulator-paper.mjs", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R21/omp-paper-harness.mjs", "json_pointer": "", "line": None}
            ],
            "n": {"task_contexts": 2, "scenes": 2, "fixture_tool_calls": 2,
                  "synthetic_approvals": 2, "verified_receipts": 2,
                  "active_run_tagged_samples": 2, "runner_checks_passed": 31,
                  "runner_checks_failed": 0, "isolation_checks_passed": 25,
                  "trace_complete_scenes": len(r21_trace_rows)},
            "trace_matrix": "revision-2026-10-25/R21/R21-TRACE-MATRIX.csv",
            "trace_join": "Each scene record links its task context and one deterministic fixture call to an approved recipe trial and verified receipt; the single queried sample run ID matches the scene active run. Task completion is not asserted by R21.",
            "units": ["fixture task call", "synthetic approval", "verified readback", "run-tagged DAQ sample", "runner assertion"],
            "interface": "Local v0.8.0 isolated application and repository simulators; deterministic OMP-RPC fixture; no LLM or autonomous harness decision; SQLite fallback",
            "source_version": "R21 runner bytes match the R20-retained runner; fixture source and runtime source reconstruction are separately available in the evidence extension. See R21/README.md for replay scope.",
            "configuration": {"cast_film": "ScrewSpeedSP OPC UA control and thickness MQTT observation",
                              "annealing": "zone-3 setpoint and StripTemp Modbus TCP",
                              "sampling": "one driver probe and run-tagged query per scene after 20 s",
                              "candidate": "predeclared deterministic fixture value"},
            "missing_fields": {"real_agent_decision": None, "task_completion_state": None,
                                "independent_simulator_replication": None, "process_trajectory": None,
                                "process_performance": None, "cross_harness_portability": None}
        },
        {
            "question": "Q10",
            "manuscript_anchor": "sec:direct-endpoint; direct operation route across two simulator mappings",
            "evidence_unit": "R22",
            "artifacts": [
                {"path": "revision-2026-10-25/R22/evidence.json", "json_pointer": "/experiment/scenes", "line": None},
                {"path": "revision-2026-10-25/R22/evidence.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R22/README.md", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R22/agentworkshop.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R22/simulator.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R22/e2e-direct-rest-simulator-paper.mjs", "json_pointer": "", "line": None}
            ],
            "n": r22_summary,
            "trace_join": "For each direct call, the synthetic approval maps to one recipe-trial record with a verified readback; the later sample query uses the active-run ID. No task ID or harness turn exists in this route.",
            "units": ["direct operation call", "synthetic approval", "verified receipt/readback", "run-tagged snapshot", "runner assertion"],
            "interface": "Local v0.8.0 isolated application and repository simulators; worker identity; direct REST invocation; no harness transport or LLM; synthetic approval; SQLite fallback",
            "configuration": {"cast_film": "ScrewSpeedSP OPC UA control and thickness MQTT observation; 125 rpm candidate; 46.37 um snapshot vs 48--52 um target", "annealing": "zone-3 setpoint and StripTemp Modbus TCP; 735 C candidate; 675.20 C snapshot vs 700--760 C target", "sampling": "one explicit probe/ingest and active-run-tagged query 20 s after call"},
            "missing_fields": {"task_to_sample_link": None, "alternate_registered_harness": None,
                               "independent_simulator_replication": None, "process_response": None,
                               "target_attainment": None, "physical_plant_validation": None}
        },
        {
            "question": "Q11",
            "manuscript_anchor": "sec:eval; second registered-harness path (R23)",
            "evidence_unit": "R23",
            "artifacts": [
                {"path": "revision-2026-10-25/R23/evidence.json", "json_pointer": "/experiment/scenes", "line": None},
                {"path": "revision-2026-10-25/R23/evidence.json", "json_pointer": "/checks", "line": None},
                {"path": "revision-2026-10-25/R23/R23-TRACE-MATRIX.csv", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R23/README.md", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R23/agentworkshop.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R23/simulator.log", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R23/pi-model-api-trace.json", "json_pointer": "", "line": None},
                {"path": "revision-2026-10-25/R23/e2e-pi-simulator-paper.mjs", "json_pointer": "", "line": None}
            ],
            "n": r23_summary,
            "trace_matrix": "revision-2026-10-25/R23/R23-TRACE-MATRIX.csv",
            "trace_join": "Each completed task ID links the approval and recipe-trial record; the task's active-run ID matches the later DAQ sample tag. Trial-run and active-run IDs remain distinct.",
            "units": ["registered Pi task", "synthetic approval", "recipe-trial receipt", "readback", "run-tagged sample", "runner assertion"],
            "interface": "Local v0.8.0 isolated application and repository simulators; registered Pi CLI adapter; deterministic loopback OpenAI-compatible fixture; no external provider or LLM decision; synthetic approval; SQLite fallback",
            "source_version": "R23 records application, simulator, plugin, fixture, and runner hashes plus working-tree status in evidence.json; the archived runner is included and its SHA-256 is validated by the package builder.",
            "configuration": {"cast-film": "ScrewSpeedSP OPC UA control; thickness MQTT sample; 120 to 125 rpm; 46.38 um vs 48--52 um target",
                              "annealing": "zone-3 control; StripTemp Modbus TCP sample; 730 to 735 C; 674.40 C vs 700--760 C target",
                              "sampling": "one run-tagged sample 20 s after recipe_trial per scene; sample returned under active-run ID"},
            "missing_fields": {"external_model_decision_quality": None, "general_harness_interchangeability": None,
                               "independent_simulator_replication": None, "process_response": None,
                               "target_attainment": None, "physical_plant_validation": None}
        }
    ])
    payload["CLAIM-MAP.json"] = json_bytes(claim_map)
    for name, reason in {
        "README.md": "Updated delivered root index for the October 25 manuscript and R11-R23, corrected R20 sampling order, and located route-specific evidence; historical source ZIP unchanged",
        "CLAIM-MAP.json": "Appended claim-to-artifact mappings for current manuscript evidence R20-R23 and supplemental historical units; added verified execution trace matrices; historical mappings preserved",
    }.items():
        changed_base[name] = {"original_sha256": base_hashes[name], "delivered_sha256": sha(payload[name]), "reason": reason}
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
    records[0].setdefault("transformations", {})["revision_2026_10_25_local_runtime_redaction"] = 1
    payload["MANIFEST.json"] = json_bytes(metadata_manifest)
    delivered_files = json.loads(payload["FILES.json"])
    for name, record in delivered_files["files"].items():
        record["sha256"] = sha(payload[name])
        record["bytes"] = len(payload[name])
    payload["FILES.json"] = json_bytes(delivered_files)
    for name in (manifest_name, "MANIFEST.json", "FILES.json"):
        changed_base[name] = {
            "original_sha256": base_hashes[name], "delivered_sha256": sha(payload[name]),
            "reason": "Generic local runtime path replaced by [local-runtime] in execution metadata; dependent delivered hashes/byte counts updated" if name == manifest_name else "Dependent delivered hash/byte-count chain updated for the documented delivery-copy edits",
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
        "software/current-full-software-tests.log": PAPER / "qa/current-full-software-tests-round18.log",
        "software/approval-context-regression.log": PAPER / "qa/approval-context-regression-round18.log",
        "software/approval-context-ablation.log": PAPER / "qa/approval-context-ablation-round18.log",
        "software/current-simulator-harness-blocked.json": HERE / "qa/current-simulator-harness-blocked.json",
        "REPRODUCIBILITY.md": PAPER / "REPRODUCIBILITY.md",
        "CLAIM-EVIDENCE-LEDGER.md": PAPER / "CLAIM-EVIDENCE-LEDGER.md",
        "R13/README.md": HERE / "qa/current-cross-scene/R13-SUMMARY.md",
        "R14/README.md": HERE / "qa/current-cross-scene/R14-SUMMARY.md",
        "R13-PROVENANCE.json": HERE / "qa/current-cross-scene/R13-PROVENANCE.json",
        "source-snapshot/scripts/e2e-simulator-optimizer-paper.mjs": REPO / "scripts/e2e-simulator-optimizer-paper.mjs",
        "R21/e2e-registered-harness-simulator-paper.mjs": REPO / "scripts/e2e-registered-harness-simulator-paper.mjs",
        "R21/omp-paper-harness.mjs": REPO / "scripts/fixtures/omp-paper-harness.mjs",
        "R22/e2e-direct-rest-simulator-paper.mjs": REPO / "scripts/e2e-direct-rest-simulator-paper.mjs",
    }
    raw_root = HERE / "qa/current-cross-scene/raw"
    pilot_root = raw_root / "pilot-initial-mappings"
    for path in raw_root.rglob("*"):
        if path.is_file() and pilot_root not in path.parents:
            additions["R13/" + path.relative_to(raw_root).as_posix()] = path
    for path in pilot_root.rglob("*"):
        if path.is_file():
            additions["R14/" + path.relative_to(pilot_root).as_posix()] = path
    r16_root = HERE / "qa/current-registered-harness/R16"
    for path in r16_root.rglob("*"):
        if path.is_file():
            additions["R16/" + path.relative_to(r16_root).as_posix()] = path
    r20_root = HERE / "qa/current-registered-harness/R20"
    for path in r20_root.rglob("*"):
        if path.is_file():
            additions["R20/" + path.relative_to(r20_root).as_posix()] = path
    r21_root = HERE / "qa/current-registered-harness/R21"
    for path in r21_root.rglob("*"):
        if path.is_file():
            additions["R21/" + path.relative_to(r21_root).as_posix()] = path
    for path in R22_ROOT.rglob("*"):
        if path.is_file():
            additions["R22/" + path.relative_to(R22_ROOT).as_posix()] = path
    for path in R23_ROOT.rglob("*"):
        if path.is_file():
            additions["R23/" + path.relative_to(R23_ROOT).as_posix()] = path
    test_names = ("high-risk-tool-scope", "tool-profile-observer", "recipe-propose",
                  "manual-approval-optimization", "recipe-approval-snapshot", "manual-approval",
                  "tool-approvals-choice", "recipe-op-interval", "recipe-approval-context-ablation")
    selected_sources = ["tests/" + name + ".test.ts" for name in test_names]
    selected_sources += [
        "server/services/workshop/agents/host-tool-bridge/dispatch.ts",
        "server/services/workshop/agents/industrial/ops-tools.ts",
        "server/services/workshop/agents/industrial/recipe-gate.ts",
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
    prefix = "revision-2026-10-25/"
    origins = {}
    additions["R20/R20-TRACE-MATRIX.csv"] = r20_trace_csv
    additions["R21/R21-TRACE-MATRIX.csv"] = r21_trace_csv
    additions["R23/R23-TRACE-MATRIX.csv"] = r23_trace_csv
    additions["R22/README.md"] = (
        "# R22 direct operation endpoint\n\n"
        "A fresh isolated v0.8.0 application and simulator environment received one direct "
        "`POST /api/workshop/agent-tools/invoke` recipe-trial call per scene. The worker identity "
        "supplied agent scope; no task, harness transport, or external language model participated. "
        "A synthetic administrator approved each bounded operation. Both calls returned HTTP 200, "
        "one 1/1 verified receipt and matching control readback, followed 20 s later by one accepted "
        "and active-run-tagged sample query. Cast-film used OPC UA control and MQTT observation; "
        "annealing used Modbus TCP for control and observation. The observed values, 46.37 um and "
        "675.20 C, were both outside their target bands. All 19 checks, isolation checks, and cleanup "
        "checks passed.\n\n"
        "R22 demonstrates the direct operation entry route and these two simulator mappings only. "
        "It does not create a task-to-sample link, exercise another registered harness, measure a "
        "process response, establish target attainment, or validate physical equipment. The earlier "
        "lead-role attempt with a scheduler subprocess is invalid and excluded; its evidence is not "
        "included in this R22 unit. Reproduce with `node scripts/e2e-direct-rest-simulator-paper.mjs` "
        "from the reconstructed repository described in `R20/source-snapshot/README.md`.\n"
    ).encode("utf-8")
    additions["R21/README.md"] = (
        "# R21 deterministic fixture verification\n\n"
        "This is a fresh current-version v0.8.0 software-path check in two isolated simulator scenes. "
        "A deterministic local OMP-RPC fixture supplies one predeclared recipe-trial call per scene; "
        "there is no LLM request or autonomous model decision. Both scenes record a task context, one "
        "synthetic approval, a 1/1 readback-verified receipt, and one DAQ sample queried by active-run ID. "
        "All 31 runner assertions and 25 isolation assertions pass, including process and port cleanup. "
        "R21 does not assert task completion and does not measure process response, quality, convergence, "
        "cross-harness portability, or independent simulator replication. It is separate from the six "
        "real-agent R20 executions. The runner and fixture source are included here; the runner hash "
        "matches the runner retained under R20. To replay, follow `R20/source-snapshot/README.md` to "
        "reconstruct the app and simulator, place the included R21 runner and fixture at their recorded "
        "repository paths, and run `node scripts/e2e-registered-harness-simulator-paper.mjs` from the app "
        "root. The default fixture mode needs the recorded Node dependencies and, on Windows, the .NET "
        "Framework C# compiler used for the local process shim; no model credentials are needed. The source "
        "reconstruction is conditional and depends on the recorded base revisions and dependencies.\n"
    ).encode("utf-8")
    for name, source in additions.items():
        key = prefix + name
        if key in payload:
            raise ValueError("Extension would overwrite historical entry: " + key)
        if name.startswith("R20/source-snapshot/prompts/"):
            raw = source.read_bytes()
            payload[key] = raw
            origins[key] = {"original_sha256": sha(raw), "delivered_sha256": sha(raw),
                            "bytes_original": len(raw), "bytes_delivered": len(raw),
                            "transformed": False,
                            "rule": "runtime prompt asset preserved byte-for-byte; checked by package privacy scan"}
        elif isinstance(source, bytes):
            raw = source
            delivered = anonymous_text(raw.decode("utf-8")).encode("utf-8")
            payload[key] = delivered
            origins[key] = {"original_sha256": sha(raw), "delivered_sha256": sha(delivered),
                            "bytes_original": len(raw), "bytes_delivered": len(delivered),
                            "transformed": raw != delivered,
                            "rule": "derived from current experiment evidence.json; task/approval/receipt/sample joins validated where asserted; delivery-copy privacy scan applied"}
        else:
            payload[key], origins[key] = cleaned_copy(source)
    r11_original = json.loads(additions["R11/scenarios.json"].read_text(encoding="utf-8-sig"))
    r12_original = json.loads(additions["R12/summary.json"].read_text(encoding="utf-8-sig"))
    results = boundary_checks(r11_original, r12_original)
    assert results == boundary_checks(json.loads(payload[prefix + "R11/scenarios.json"]),
                                      json.loads(payload[prefix + "R12/summary.json"]))
    test_log = payload[prefix + "software/current-software-tests.log"].decode("utf-8")
    assert re.search(r"\btests\s+65\b", test_log) and re.search(r"\bpass\s+65\b", test_log) and re.search(r"\bfail\s+0\b", test_log)
    ablation_log = payload[prefix + "software/approval-context-ablation.log"].decode("utf-8")
    regression_log = payload[prefix + "software/approval-context-regression.log"].decode("utf-8")
    assert re.search(r"\btests\s+20\b", regression_log) and re.search(r"\bpass\s+20\b", regression_log) and re.search(r"\bfail\s+0\b", regression_log)
    ablation_rows = [json.loads(line.removeprefix("CONTEXT_ABLATION "))
                     for line in ablation_log.splitlines() if line.startswith("CONTEXT_ABLATION {")]
    expected_routes = {"recipe_apply", "recipe_trial", "recipe_rollback(dispatch=true)"}
    assert len(ablation_rows) == 12
    assert {row["route"] for row in ablation_rows} == expected_routes
    assert {row["changedField"] for row in ablation_rows} == {"line", "product", "recipe", "run"}
    assert sum(not row["refused"] for row in ablation_rows) == 6
    assert all(row["changedField"] in {"product", "run"} and row["mockDriverWrites"] == 2
               and row["newExecutionRecords"] == 1 for row in ablation_rows if not row["refused"])
    assert all(row["mockDriverWrites"] == 0 and row["newExecutionRecords"] == 0
               for row in ablation_rows if row["refused"])
    assert re.search(r"\btests\s+12\b", ablation_log) and re.search(r"\bpass\s+12\b", ablation_log) and re.search(r"\bfail\s+0\b", ablation_log)
    metadata_changes = {name: detail for name, detail in changed_base.items()
                       if name in {manifest_name, "MANIFEST.json", "FILES.json"}}
    extension = {"revision": REVISION, "base_package": BASE_ZIP.name,
                 "base_package_sha256": sha(BASE_ZIP.read_bytes()),
                 "base_entries_copied": len(base_hashes), "byte_identical_base_entries": len(base_hashes) - len(changed_base),
                 "base_delivery_copy_changes": changed_base,
                 "historical_metadata_privacy_changes": metadata_changes,
                 "historical_R3_assertions": assertion_count,
                 "files": origins, "boundary_checks": results,
                 "Q7_R13": {"daq_points": {"cast_film": 697, "annealing": 696},
                            "dataset_rows": {"cast_film": 658, "annealing": 655},
                            "held_out_test_rows": {"cast_film": 220, "annealing": 218},
                            "passed_checks": 50, "failed_checks": 0, "gate_blocked_outcomes": 2,
                            "optimization_eligible_scenes": 0, "recommendations": 0, "dispatches": 0},
                 "Q7_pilot_R14": {"daq_points_per_scene": 582,
                                  "dataset_rows": {"cast_film": 539, "annealing": 538},
                                  "passed_checks": 51, "failed_checks": 0, "gate_blocked_outcomes": 2},
                 "Q8_R16_diagnostic": {"scenes": 2, "runner_checks_passed": 31, "runner_checks_failed": 0,
                            "fixture_host_tool_calls": 2, "manual_approvals": 2,
                            "verified_ack_readback": {"cast_film": "1/1", "annealing": "1/1"},
                            "run_tagged_daq_snapshots": 2, "points_per_snapshot": 1,
                            "post_trial_wait_seconds": 20,
                            "snapshot_values": {"cast_film_um": 46.37, "annealing_C": 674.799988},
                            "llm_calls": 0, "quality_or_convergence_claim": False},
                 "Q8_R20": {"task_executions": 6, "scenes": 2, "sequential_executions_per_scene": 3,
                            "completed_tasks": 6, "synthetic_approvals": 6,
                            "runner_checks_passed": 76, "runner_checks_failed": 0,
                            "verified_ack_readback": "1/1 in each execution",
                            "run_tagged_samples": 6, "post_trial_wait_seconds": 20,
                            "execution_keys": [row["execution_key"] for row in r20_trace_rows],
                            "trace_matrix": "revision-2026-10-25/R20/R20-TRACE-MATRIX.csv",
                            "trace_complete_executions": len(r20_trace_rows),
                            "sampling_order": "verified route ACK and returned trial result -> 20-s delay -> driver probe -> ingest -> active-run-tagged query -> task-state check; no task-completion timestamp or task-completion-to-sample latency",
                            "post_trial_values": {"cast_film_um": [45.69, 46.69, 45.69],
                                                   "annealing_C": [679.60, 677.70, 678.10]},
                            "target_attainment": {"cast_film": 0, "annealing": 0},
                            "daq_backend": "isolated SQLite time-series fallback",
                            "quality_or_convergence_claim": False},
                 "Q9_R21": {"task_contexts": 2, "scenes": 2, "fixture_tool_calls": 2,
                            "synthetic_approvals": 2, "verified_ack_readback": "1/1 per scene",
                            "run_tagged_samples": 2, "post_trial_wait_seconds": 20,
                            "runner_checks_passed": 31, "runner_checks_failed": 0,
                            "isolation_checks_passed": 25, "trace_complete_scenes": len(r21_trace_rows),
                            "trace_matrix": "revision-2026-10-25/R21/R21-TRACE-MATRIX.csv",
                            "llm_calls": 0, "task_completion_asserted": False,
                            "process_performance_claim": False},
                 "Q10_R22": r22_summary | {
                             "route": "POST /api/workshop/agent-tools/invoke",
                             "synthetic_approvals": 2, "http_statuses": [200, 200],
                             "verified_ack_readback": "1/1 per scene",
                             "samples": {"cast_film_um": 46.37, "annealing_C": 675.2000122070312},
                             "target_bands": {"cast_film_um": [48, 52], "annealing_C": [700, 760]},
                             "llm_calls": 0, "task_contexts": 0, "harness_transport_calls": 0,
                             "process_performance_claim": False},
                 "Q11_R23": r23_summary | {
                             "trace_matrix": "revision-2026-10-25/R23/R23-TRACE-MATRIX.csv",
                             "task_to_sample_links": len(r23_trace_rows),
                             "sample_below_target": True,
                             "process_performance_claim": False},
                 "selected_source_snapshot": {"files": ["source-snapshot/" + name for name in selected_sources],
                                              "test_sources": len(test_names),
                                              "core_contract_sources": len(selected_sources) - len(test_names),
                                              "scope": "Selected current working-tree source copies captured at packaging; the working tree has uncommitted edits. This is neither a complete independent runtime nor an exact historical runtime version. The October 25 log reports execution on the local v0.8.0 working tree; source hashes do not prove a historical commit reproduces it."},
                 "redaction": "Copies only: explicit identity/local-path strings and identifying repository URLs; JSON quantitative, boolean and null leaves unchanged. HTTP(S) URLs retained except identified private repositories.",
                  "scope": "Historical R1--R10 numerical entries are byte-identical. The delivered root index/claim map are updated, one generic runtime-path metadata field and its dependent delivered hash/byte-count chain are repaired in copies only, and current manuscript evidence R20-R23 plus supplemental historical R13/R14/R16 records are retained as separate units. R20/R21 use the OMP route; R23 exercises the Pi route with a deterministic local fixture; R22 tests direct REST. The selected configurations do not establish general harness interchangeability."}
    payload[prefix + "EXTENSION-MANIFEST.json"] = json_bytes(extension)
    payload[prefix + "README.md"] = (
        "# October 25 evidence extension\n\n"
        "The original October 20 ZIP is unchanged; historical R1--R10 numerical entries remain byte-identical. "
        "The extension preserves R11/R12 failures, exploratory Q7/R13 and its preceding R14 signal-pair pilot, "
        "the separate R16 fixture diagnostic, the six sequential model-selected R20 task executions, the two-scene "
        "deterministic R21 fixture replay, and the two-scene direct operation run R22. R13 and R14 use simulators and remain separate; both model candidates failed "
        "their configured gates, with no profile, recommendation, or dispatch.\n\n"
        "R20 links each task to synthetic approval, verified recipe-trial receipt, and one sample queried 20 s after "
        "readback through an isolated SQLite fallback. Task state was checked after the query; no task-completion-to-sample "
        "latency is recorded. All six samples remained outside target, and the three executions per scene share one simulator "
        "instance. R21 separately verifies one deterministic fixture task per scene with no LLM decision. Its 31 runner "
        "assertions and 25 isolation assertions pass, including cleanup; it is not pooled with R20 or treated as process "
        "evidence. Per-execution trace matrices and source/log records are retained under R20/ and R21/. R22 "
        "uses the direct REST operation endpoint without a task or harness transport; its two calls return verified "
        "receipts and active-run-tagged snapshots, both outside target, with 19 runner checks passed. R22 broadens "
        "entry-route coverage but is not process-response evidence. Its records and runner are under R22/. R23 "
        "separately exercises the registered Pi CLI adapter using a deterministic loopback model fixture, with one "
        "explicit recipe_trial and complete_task per scene and no external model decision. Both tasks completed; each "
        "has a synthetic approval, verified ACK/readback, and a sample queried by active-run ID 20 s after the trial. "
        "The samples were 46.38 um and 674.40 C, both below target. All 37 application checks and 28 isolation checks "
        "passed. The R23 trace matrix records task, approval, trial, active-run, DAQ-node, and sample IDs. This is a "
        "selected software-route integration result, not model-quality, process-response, independent-replication, or "
        "general adapter-interchangeability evidence; its archived evidence and runner are under R23/.\n\n"
        "The current local unit suite passes 566/566 tests across seven suites; the focused 20-case approval-snapshot "
        "suite and 12-case context-guard ablation also pass. Production-handler injections change line, product, recipe, "
        "or active run across recipe_apply, recipe_trial, and recipe_rollback(dispatch=true); all 12 stale actions are "
        "refused before mock-driver writes and create no new execution record. A test-only variant that omits only the "
        "post-approval tuple comparison allows the six product/run changes to proceed, each causing two mock-driver "
        "writes and one execution record; independent checks block the line/recipe changes. This is component-level "
        "mock-state evidence, not a platform baseline or process-safety result. "
        "Selected current source files are included as a conditional "
        "snapshot, not as a full runtime or immutable historical release. Raw observations and failed outcomes are retained.\n"
    ).encode("utf-8")
    assert all(sha(payload[name]) == digest for name, digest in base_hashes.items() if name not in changed_base)
    assert all(sha(payload[name]) == digest for name, digest in base_hashes.items() if re.match(r"R\d+/", name))
    for name, record in delivered_files["files"].items():
        assert sha(payload[name]) == record["sha256"] and len(payload[name]) == record["bytes"]
    privacy_scan(payload)
    return payload, origins, {"base_entries": len(base_hashes),
                              "byte_identical_base_entries": len(base_hashes) - len(changed_base),
                              "base_delivery_copy_changes": changed_base,
                              "historical_metadata_privacy_changes": metadata_changes,
                              "historical_experimental_entries_byte_identical": True,
                              "Q7_R13": extension["Q7_R13"], "Q7_pilot_R14": extension["Q7_pilot_R14"],
                               "Q8_R20_trace_rows": len(r20_trace_rows),
                               "Q9_R21_trace_rows": len(r21_trace_rows),
                               "Q10_R22": r22_summary,
                              "Q11_R23": r23_summary | {"trace_rows": len(r23_trace_rows)},
                              "added_evidence_entries": len(origins),
                              "selected_test_sources": len(test_names),
                              "selected_core_sources": len(selected_sources) - len(test_names),
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
