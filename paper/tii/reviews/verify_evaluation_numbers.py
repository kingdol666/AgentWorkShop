#!/usr/bin/env python
"""Cross-check every quantitative claim in sections/evaluation.tex against the
archived benchmark run 20260918043504-bdo.

Run:  python reviews/verify_evaluation_numbers.py
Exit code 0 means every checked claim matches the archive. Any mismatch is
printed and makes the script exit non-zero. This script never writes to the
archive; it only reads it and the LaTeX source.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TII = HERE.parent
REPO = TII.parents[1]
RUN_DIR = REPO / "bench" / "results" / "20260918043504-bdo"

RUN = json.loads((RUN_DIR / "run.json").read_text(encoding="utf-8"))
SUMMARY = json.loads((RUN_DIR / "summary.json").read_text(encoding="utf-8"))
REPORT = (RUN_DIR / "report.md").read_text(encoding="utf-8")
METRICS = (RUN_DIR / "metrics.csv").read_text(encoding="utf-8")
BIAX_LOG = (RUN_DIR / "agentteam-biax.log").read_text(encoding="utf-8")
MISSION_LOG = (RUN_DIR / "agentteam-mission.log").read_text(encoding="utf-8")
TEX = (TII / "sections" / "evaluation.tex").read_text(encoding="utf-8")

failures: list[str] = []
checked = 0


def check(label: str, actual, expected, tol: float = 1e-9) -> None:
    global checked
    checked += 1
    if isinstance(expected, float) or isinstance(actual, float):
        ok = math.isclose(float(actual), float(expected), rel_tol=0.0, abs_tol=tol)
    else:
        ok = actual == expected
    if not ok:
        failures.append(f"{label}: archive={actual!r} paper/expected={expected!r}")


def in_tex(fragment: str, label: str) -> None:
    global checked
    checked += 1
    if fragment not in " ".join(TEX.split()):
        failures.append(f"{label}: fragment not found in evaluation.tex -> {fragment!r}")


# ---------------------------------------------------------------- fingerprints
check("run id", RUN["env"]["runId"], "20260918043504-bdo")
check("seed", int(RUN["env"]["seed"]), 42)
check("commit", RUN["env"]["gitCommit"], "7d4bfc0")
check("harness hash", RUN["env"]["harnessHash"], "00e7dc827f4a2cea")
check("node version", RUN["env"]["node"], "v24.19.0")
in_tex("7d4bfc0", "commit cited in tex")
in_tex("00e7dc827f4a2cea", "harness hash cited in tex")

# ------------------------------------------------------------------ scorecard
verdict = SUMMARY["verdict"]
check("checks pass", int(verdict["pass"]), 75)
check("checks warn", int(verdict["warn"]), 0)
check("checks fail", int(verdict["fail"]), 0)
check("checks total", len(RUN["checks"]), 75)

phase_rows = re.findall(
    r"^\|\s*(P[0-9]+[a-z]?)\s*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|"
    r"\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*(\d+)\s*\|",
    REPORT,
    flags=re.MULTILINE,
)
check("phase rows parsed from report", len(phase_rows), 17)
check("sum of phase checks", sum(int(r[1]) for r in phase_rows), 75)
check("sum of phase warnings", sum(int(r[2]) for r in phase_rows), 0)
check("sum of phase failures", sum(int(r[3]) for r in phase_rows), 0)
check("sum of phase weights", sum(int(r[6]) for r in phase_rows), 37)
in_tex("17 phases", "17-phase statement")
in_tex("all 17 phases and all 75 checks", "table caption partition claim")

LAYERS = {
    "plant": (["P0", "P1", "P2"], 4, 9),
    "p3": (["P3"], 3, 5),
    "p4": (["P4"], 3, 7),
    "records": (["P4b", "P4c", "P4d", "P4e", "P4f"], 10, 12),
    "missions": (["P4m", "P10"], 6, 16),
    "closedloop": (["P6", "P8", "P8b"], 9, 22),
    "platform": (["P7", "P9"], 2, 4),
}
by_phase = {r[0]: r for r in phase_rows}
for name, (phases, weight, checks) in LAYERS.items():
    got_checks = sum(int(by_phase[p][1]) for p in phases)
    got_weight = sum(int(by_phase[p][6]) for p in phases)
    check(f"layer {name} checks", got_checks, checks)
    check(f"layer {name} weight", got_weight, weight)
check("layers partition phases", sum(len(v[0]) for v in LAYERS.values()), 17)

# ------------------------------------------------------- protocol / governance
lines = {int(row["index"]): row for row in RUN["lines"]}
expected = {
    1: ("modbus-tcp", 7, 62.717, 162.607, 0.04),
    2: ("opcua", 11, 18.711, 21.899, 0.0),
    3: ("mqtt", 11, 18.837, 19.140, None),
    4: ("http", 13, 32.273, 32.972, None),
    5: ("modbus-rtu", 14, None, None, None),
}
for index, (proto, samples, p50, p95, delta) in expected.items():
    row = lines[index]
    check(f"line {index} protocol", row["protocol"], proto)
    check(f"line {index} daq samples", int(row["daqSamples"]), samples)
    check(f"line {index} f5 rejected", int(row.get("f5Rejected") or 0), 6 if p50 else 0)
    check(f"line {index} f5 total", int(row.get("f5Total") or 0), 6 if p50 else 0)
    check(f"line {index} false blocks", int(row.get("falseBlock") or 0), 0 if p50 else 0)
    if p50 is not None:
        check(f"line {index} write p50", float(row["writeP50"]), p50, 5e-4)
        check(f"line {index} write p95", float(row["writeP95"]), p95, 5e-4)
    if delta is None:
        check(f"line {index} readback delta null", row.get("readbackDelta"), None)
    else:
        check(f"line {index} readback delta", float(row["readbackDelta"]), delta, 1e-9)

check("DAQ samples total", sum(int(lines[i]["daqSamples"]) for i in range(1, 6)), 56)
pooled = sum(float(lines[i]["writeP50"]) for i in range(1, 5)) / 4.0
check("mean of per-stack p50", round(pooled, 3), 33.135, 5e-4)
check(
    "report pooled p50 KPI",
    float(next(k["value"] for k in RUN["kpis"] if "p50" in k["label"])),
    33.135,
    5e-4,
)
check("governance rejected total", sum(int(lines[i].get("f5Rejected") or 0) for i in range(1, 5)), 24)
check("governance probes total", sum(int(lines[i].get("f5Total") or 0) for i in range(1, 5)), 24)
in_tex("24/24", "24/24 governance claim")
in_tex("none of the four designated legal writes is blocked", "false-block claim")

# ----------------------------------------------------------------- portability
port = RUN["portability"]["agg"]
check("film-line preset", port["preset"], "film-line")
check("film-line own lines", int(port["ownLines"]), 3)
check("film-line satellites", int(port["lines"]) - int(port["ownLines"]), 2)
check("film-line f5 rejected", int(port["f5Rejected"]), 9)
check("film-line f5 total", int(port["f5Total"]), 9)
check("film-line false blocks", int(port["falseBlocks"]), 0)
check("film-line code changes", int(port["codeChanges"]), 0)
in_tex("9/9", "9/9 film-line claim")

# ------------------------------------------------------------------ closed loop
closed = RUN["closedloop"]
check("write mode", closed["writeMode"], "governed")
agg = closed["agg"]
check("closedloop n", int(agg["n"]), 3)
check("Jstar", float(agg["Jstar"]), 89.894, 5e-4)
check("ratio min", float(agg["ratioMin"]), 0.968, 5e-4)
check("ratio mean", float(agg["ratioMean"]), 0.970, 5e-4)
check("ratio max", float(agg["ratioMax"]), 0.972, 5e-4)
check("writes total", int(agg["writesTotal"]), 6)
check("rejected total", int(agg["rejectedTotal"]), 0)
check("converged seeds", int(agg["convergedN"]), 3)
check("mean wall seconds", float(agg["wallSMean"]), 36.193, 5e-4)
seed_expected = {
    42: (70.115, 87.105, 0.969, 49.883),
    43: (68.792, 87.027, 0.968, 49.383),
    44: (70.248, 87.366, 0.972, 49.317),
}
for seed in closed["seeds"]:
    number = int(seed["seed"])
    j0, jend, ratio, thickness = seed_expected[number]
    check(f"seed {number} J0", float(seed["J0"]), j0, 5e-4)
    check(f"seed {number} Jend", float(seed["Jend"]), jend, 5e-4)
    check(f"seed {number} ratio", float(seed["ratio"]), ratio, 5e-4)
    final = max(seed["traj"], key=lambda p: int(p["iter"]))
    check(f"seed {number} final thickness", float(final["thickness"]), thickness, 5e-4)
in_tex("70.115", "seed-42 J0 in tex")
in_tex("49.317", "seed-44 thickness in tex")

# J is maximized, J is bounded by [0, 95], and the archive's J_end is a
# two-point mean that is higher than the last measured evaluation. The paper
# must not present J_end as the settled value.
check("J upper bound from weights", 55 + 25 + 8 + 7, 95)
last_iterate = {}
for seed in closed["seeds"]:
    number = int(seed["seed"])
    points = sorted(seed["traj"], key=lambda item: int(item["iter"]))
    final_j = float(points[-1]["J"])
    last_iterate[number] = final_j / 89.894
    check(
        f"seed {number} J_end is mean of last two",
        float(seed["Jend"]),
        (float(points[-1]["J"]) + float(points[-2]["J"])) / 2.0,
        5e-4,
    )
    check(f"seed {number} J falls on second write",
          float(points[-1]["J"]) < float(points[-2]["J"]), True)
check("last-iterate ratios", sorted(round(v, 3) for v in last_iterate.values()),
      [0.963, 0.967, 0.968])
in_tex("0.963", "last-iterate ratio in tex")
in_tex("0.963$--$0.972", "two-convention ratio range in tex")

# ---------------------------------------------------------------- AgentTeam P4m
p4m = [c for c in RUN["checks"] if c["phase"] == "P4m"]
check("P4m checks", len(p4m), 6)
check("P4m all pass", all(c["status"] == "pass" for c in p4m), True)
in_tex("204.704", "single-node target in tex")
in_tex("204.700", "single-node readback in tex")
check("acceptance band is loose",
      abs(204.0 - 204.704) <= 0.75, True)
for token in ["writes=1", "attained=true", "terminal=COMPLETED"]:
    check(f"mission log token {token}", token in MISSION_LOG, True)

# ------------------------------------------------------------------- biax P10
biax = RUN["env"]["biax"]
check("biax devices", int(biax["devices"]), 9)
check("biax signals", int(biax["signals"]), 49)
check("biax setpoints", int(biax["sp"]), 30)
check("biax acquired", int(biax["platformDaq"]), 19)
check("biax dcw", int(biax["platformDcw"]), 30)
check("biax writes", int(biax["missionWrites"]), 3)
check("biax distinct knobs", int(biax["missionKnobs"]), 3)
check("biax final thickness", float(biax["missionFinalUm"]), 25.68, 5e-4)
check("biax attained", biax["missionAttained"], True)
check("P10 checks", len([c for c in RUN["checks"] if c["phase"] == "P10"]), 10)

traj = biax["missionTraj"]
check("biax trajectory length", len(traj), 4)
check("biax initial thickness", float(traj[0]["thickness"]), 28.10, 5e-4)
for index, (knob, before, after, record, thickness) in enumerate(
    [
        ("cast-spd-sp", 32.0, 33.8, "opt-86313140", 26.62),
        ("fast-roll-sp", 118.0, 120.5, "opt-41929fe2", 25.90),
        ("rail-out-sp", 3000.0, 3031.0, "opt-8d2faadb", 25.68),
    ],
    start=1,
):
    point = traj[index]
    check(f"biax step {index} knob", point["knob"], knob)
    check(f"biax step {index} from", float(point["from"]), before)
    check(f"biax step {index} to", float(point["to"]), after)
    check(f"biax step {index} record", point["record"], record)
    check(f"biax step {index} thickness", float(point["thickness"]), thickness, 5e-4)
    check(f"biax step {index} melt temp in window",
          268.0 <= float(point["meltTemp"]) <= 300.0, True)
    in_tex(record, f"record {record} cited in tex")
target, tol = 25.0, 0.7
check("biax inside band",
      target - tol <= float(traj[-1]["thickness"]) <= target + tol, True)
check("biax margin to band edge",
      round(tol - abs(float(traj[-1]["thickness"]) - target), 4), 0.02, 5e-4)
in_tex("0.02\\,\\mu$m", "margin stated in tex")
in_tex("3 of its 6 allowed", "write-budget claim")
in_tex("two protocols", "two-protocol claim")
# The three mission nodes are not three distinct drivers or units.
knob_nodes = [point["node"] for point in traj[1:]]
check("biax three distinct nodes", len(set(knob_nodes)), 3)
for token in ["writes=3 distinctKnobs=3 final=25.68", "terminal=COMPLETED",
              "initial thickness=28.10"]:
    check(f"biax log token {token}", token in BIAX_LOG, True)

# ----------------------------------------------------------- lifecycle / misc
check("journal anchors", int(next(m["value"] for m in RUN["metrics"]
                                 if m["key"] == "journal_anchors")), 11)
check("audit entries", int(next(m["value"] for m in RUN["metrics"]
                                if m["key"] == "audit_entries")), 200)
check("hitl approval latency ms", int(next(m["value"] for m in RUN["metrics"]
                                           if m["key"] == "approval_latency_ms")), 16)
check("recipe lifecycles ok", int(next(m["value"] for m in RUN["metrics"]
                                       if m["key"] == "recipe_lifecycles_ok")), 2)
check("param layer checks", int(next(m["value"] for m in RUN["metrics"]
                                     if m["key"] == "param_layer_checks_ok")), 4)
check("vector frames", int(next(m["value"] for m in RUN["metrics"]
                                if m["key"] == "vector_frames")), 5)
check("image frames", int(next(m["value"] for m in RUN["metrics"]
                               if m["key"] == "image_frames")), 5)
check("harness registry", int(next(m["value"] for m in RUN["metrics"]
                                   if m["key"] == "harness_registry")), 14)
backstop = RUN["env"]["backstop"]
check("backstop fired", backstop["fired"], True)
check("backstop restored", backstop["restored"], True)
check("backstop latency s", float(backstop["latencyS"]), 120.161, 5e-4)
check("backstop record", backstop["recordId"], "opt-4d097133")
in_tex("120.161", "backstop latency in tex")
in_tex("14 agent engines", "registry claim in tex")

# Reporting hygiene the reviewers asked us to state explicitly.
phase_ids = [row[0] for row in phase_rows]
check("phase count from archive", len(phase_ids), 17)
check("P4m present", "P4m" in phase_ids, True)
empty_evidence = [c["id"] for c in RUN["checks"] if not c.get("evidence")]
check("checks with empty evidence", empty_evidence, ["biax-mission-journal"])
skipped = sorted(
    c["id"] for c in RUN["checks"] if "skipped" in json.dumps(c).lower()
)
check("checks mentioning skipped sub-checks", skipped,
      ["line-5-io", "port-4-modbus-rtu", "port-5-http"])
in_tex("empty evidence array", "empty-evidence disclosure in tex")
in_tex("skipped because their nodes expose no writable", "skip disclosure in tex")

# tool-level loops
loop_seconds = [5.252, 4.334, 4.332, 4.344]
for line_index, seconds in enumerate(loop_seconds, start=1):
    row = lines[line_index]
    check(f"line {line_index} loop iterations", int(row["loopIterations"]), 3)
    check(f"line {line_index} loop seconds", float(row["convergenceS"]), seconds, 5e-4)
in_tex("3 scripted setpoint iterations per line", "tool-loop row in tex")

# ---------------------------------------------------------------------------
# Corrections and disclosures added after the five-seat blind review panel.
# Each asserts a fact that a reviewer raised, so a later edit cannot silently
# undo it.
# ---------------------------------------------------------------------------
MAIN_TEX = (TII / "main.tex").read_text(encoding="utf-8")

# Defect rate: the paper said 0.50-0.53 and omitted seed 44's 0.383.
pre = [float(sorted(s["traj"], key=lambda p: int(p["iter"]))[1]["defect"]) for s in closed["seeds"]]
post = [float(sorted(s["traj"], key=lambda p: int(p["iter"]))[2]["defect"]) for s in closed["seeds"]]
check("pre-write defect min", round(min(pre), 4), 0.3833, 5e-4)
check("pre-write defect max", round(max(pre), 4), 0.5333, 5e-4)
check("post-write defect min", round(min(post), 4), 0.6167, 5e-4)
check("post-write defect max", round(max(post), 4), 0.7167, 5e-4)
in_tex("0.38--0.53", "corrected defect range in tex")
check("stale defect range removed", "0.50--0.53" in TEX, False)

# Fig. 5 caption: the plotted third point is the last measured evaluation.
in_tex("Each marker is one measured evaluation", "fig5 caption correction in tex")

# The film-break guard was already in the working tree before archive B; B did
# not enter the branch, and every archive that did enter it failed to recover.
# Verified against 20260918040908-1f4o (26 min before B, same commit 7d4bfc0),
# 20260918144835-18qs and 20260918152858-1ar8 (final readings 0.04, -0.02, -0.02).
in_tex("present in the mission harness", "guard provenance in tex")
in_tex("aborts rather than recovers", "guard behaviour in tex")

# The mission layer is not reproducible across runs, and the failing run's
# checks were warnings, not failures.
in_tex("A final caveat concerns the mission layer", "reproducibility disclosure in tex")
in_tex("same-hash, same-seed archives, neither of them $B$", "hash-collision disclosure in tex")
in_tex("neither of them $B$", "archive pair named in tex")
in_tex("both mission checks are recorded as warnings", "verdict taxonomy in tex")
in_tex("Seven report a final thickness inside the band", "mission attainment rate in tex")

# Scenario-2 probe set: wording and the missing recipe-window branch.
in_tex("nine out-of-constraint probes (three node-range probes per writable line)", "scenario-2 probe wording in tex")
in_tex("exercises no recipe-window branch", "scenario-2 window gap in tex")

# The governance ablation, archived separately from the 75 checks.
in_tex("frozen four-arm ablation", "ablation reference in tex")

# Attribution reconciled against the empty-evidence check.
in_tex("journal query for the cast-speed node", "attribution reconciliation in tex")

# Abstract qualifiers.
check("abstract states skipped sub-checks",
      "skipped write sub-checks" in " ".join(MAIN_TEX.split()), True)
check("title no longer claims multi-agent LLM teams",
      "Multi-Agent Teams for Industrial Supervisory" in MAIN_TEX, False)

# ------------------------------------------------------------------- reporting
print(f"checked {checked} claims against {RUN_DIR}")
if failures:
    print(f"\n{len(failures)} MISMATCH(ES):")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("all claims match the archive")
