from __future__ import annotations

import csv
import hashlib
import html
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RESULTS = ROOT / "bench" / "results"
PAPER = ROOT / "paper" / "tii" / "SUBMISSION-IEEE-TII"
FIGS = HERE / "figures"
DATA = HERE / "source-data"
FIGS.mkdir(parents=True, exist_ok=True)
DATA.mkdir(parents=True, exist_ok=True)

LATEST_ID = "20261031034253-1dbo"
INTEGRATED_RUNS = [
    "20261031030602-1sng",
    "20261031032514-1eyw",
    LATEST_ID,
]
PRECHECK_FAIL_ID = "20261031025846-czk"
SCENARIO_RUN_ID = "20261031033645-22n0"
E1A_ID = "20261030171011-e1lite"

COLORS = {
    "blue": "#3B6F9C",
    "orange": "#D97925",
    "green": "#4D8B68",
    "red": "#B64A4A",
    "gray": "#737373",
    "light": "#D9E1E8",
    "ink": "#202020",
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def setup_style():
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "DejaVu Serif"],
            "font.size": 8,
            "axes.labelsize": 8,
            "axes.titlesize": 8.5,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "legend.fontsize": 7,
            "axes.linewidth": 0.8,
            "lines.linewidth": 1.25,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "savefig.facecolor": "white",
            "figure.facecolor": "white",
        }
    )


def save_figure(fig, stem: str):
    report_pdf = FIGS / f"{stem}.pdf"
    fig.savefig(report_pdf, bbox_inches="tight", transparent=False)
    fig.savefig(FIGS / f"{stem}.png", dpi=320, bbox_inches="tight", transparent=False)
    fig.savefig(FIGS / f"{stem}.svg", bbox_inches="tight", transparent=False)
    paper_pdf = PAPER / "resources" / f"{stem}.pdf"
    paper_pdf.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(report_pdf, paper_pdf)
    plt.close(fig)
    return paper_pdf


def draw_integrated_results(latest: dict):
    p6 = latest["p6_rows"]
    traj = latest["biax_traj"]
    fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.65), gridspec_kw={"width_ratios": [0.92, 1.35]})

    ax = axes[0]
    seeds = [str(row["seed"]) for row in p6]
    ratios = [float(row["ratio"]) * 100 for row in p6]
    ax.axhline(100, color=COLORS["gray"], linestyle=(0, (3, 2)), linewidth=0.9, label="$J^*$ reference")
    ax.scatter(range(len(ratios)), ratios, s=34, color=COLORS["blue"], edgecolor="white", linewidth=0.6, zorder=3)
    for i, value in enumerate(ratios):
        ax.annotate(f"{value:.1f}", (i, value), xytext=(0, 6), textcoords="offset points", ha="center", fontsize=7)
    ax.set_xticks(range(len(seeds)), seeds)
    ax.set_xlabel("Simulation seed")
    ax.set_ylabel("$J_{end}/J^*$ (%)")
    ax.set_ylim(94, 101.2)
    ax.set_yticks([94, 96, 98, 100])
    ax.grid(axis="y", color="#D8D8D8", linewidth=0.55)
    ax.legend(loc="lower right", frameon=False, handlelength=1.5)
    ax.set_title("(a) Fixed-seed objective ratio")

    ax = axes[1]
    xs = list(range(len(traj)))
    ys = [float(row["thickness"]) for row in traj]
    ax.axhspan(24.3, 25.7, color=COLORS["green"], alpha=0.12, label="Target band (24.3–25.7 µm)")
    ax.plot(xs, ys, color=COLORS["blue"], marker="o", markersize=4.3, markerfacecolor="white", markeredgewidth=1.1)
    for i, (x, y) in enumerate(zip(xs, ys)):
        ax.annotate(f"{y:.2f}", (x, y), xytext=(0, 6 if i != len(ys) - 1 else -13), textcoords="offset points", ha="center", fontsize=7)
    ax.set_xticks(xs, ["Initial", "Write 1", "Write 2", "Write 3"])
    ax.set_ylabel("Film thickness (µm)")
    ax.set_ylim(23.7, 29.2)
    ax.grid(axis="y", color="#D8D8D8", linewidth=0.55)
    ax.legend(loc="upper right", frameon=False, fontsize=6.8)
    ax.set_title("(b) Single BOPET task trajectory")

    for ax in axes:
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.tick_params(direction="out", length=3, width=0.7)
    fig.subplots_adjust(wspace=0.34, bottom=0.20, top=0.84)
    return save_figure(fig, "fig-integrated-run-results")


def load_e1a():
    path = RESULTS / E1A_ID / "e1-lite.csv"
    rows = list(csv.DictReader(path.open(encoding="utf-8-sig", newline="")))
    arm_order = ["full", "no-interlock", "no-readback", "ungated"]
    by_arm_rep: dict[str, dict[int, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        by_arm_rep[row["arm"]][int(row["rep"])].append(row)
    result = []
    for arm in arm_order:
        reps = []
        for rep in sorted(by_arm_rep[arm]):
            subset = by_arm_rep[arm][rep]
            attacks = [r for r in subset if r["case"] == "attack"]
            blocked = sum(r["verdict"] == "rejected" for r in attacks)
            window_executed = sum(
                r["case"] == "attack" and r["kind"] in {"above-window", "below-window"} and r["verdict"] != "rejected"
                for r in subset
            )
            permitted = [r for r in subset if r["case"] in {"legit", "timed"}]
            false_blocks = sum(r["verdict"] != "ok" for r in permitted)
            reps.append(
                {
                    "rep": rep,
                    "attacks": len(attacks),
                    "blocked": blocked,
                    "interception_pct": (blocked / len(attacks) * 100) if attacks else None,
                    "window_reached_driver": window_executed,
                    "false_blocks": false_blocks,
                    "permitted_attempts": len(permitted),
                }
            )
        result.append({"arm": arm, "repeats": reps})
    return rows, result


def draw_e1a(ablation: list[dict]):
    fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.7))
    labels = ["Full", "No interlock", "No readback", "Ungated"]
    x = np.arange(4)
    means = [np.mean([r["interception_pct"] for r in arm["repeats"]]) for arm in ablation]
    ax = axes[0]
    ax.bar(x, means, color=[COLORS["blue"], COLORS["orange"], COLORS["green"], COLORS["red"]], width=0.58, edgecolor="white", linewidth=0.5)
    for i, arm in enumerate(ablation):
        values = [r["interception_pct"] for r in arm["repeats"]]
        jitter = np.linspace(-0.09, 0.09, len(values))
        ax.scatter(np.full(len(values), i) + jitter, values, s=17, color=COLORS["ink"], edgecolor="white", linewidth=0.4, zorder=3)
        ax.text(i, means[i] + 3.4, f"{means[i]:.1f}%", ha="center", va="bottom", fontsize=7)
    ax.set_xticks(x, labels, rotation=0)
    ax.set_ylabel("Rejected negative probes (%)")
    ax.set_ylim(0, 115)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.grid(axis="y", color="#D8D8D8", linewidth=0.55)
    ax.set_title("(a) Interception across three repeats")

    ax = axes[1]
    breaches = [np.mean([r["window_reached_driver"] for r in arm["repeats"]]) for arm in ablation]
    ax.bar(x, breaches, color=[COLORS["blue"], COLORS["orange"], COLORS["green"], COLORS["red"]], width=0.58, edgecolor="white", linewidth=0.5)
    for i, arm in enumerate(ablation):
        values = [r["window_reached_driver"] for r in arm["repeats"]]
        jitter = np.linspace(-0.09, 0.09, len(values))
        ax.scatter(np.full(len(values), i) + jitter, values, s=17, color=COLORS["ink"], edgecolor="white", linewidth=0.4, zorder=3)
        ax.text(i, max(values) + 0.13, f"{np.mean(values):.1f}/rep", ha="center", va="bottom", fontsize=7)
    ax.set_xticks(x, labels, rotation=0)
    ax.set_ylabel("Window attacks reaching mock driver")
    ax.set_ylim(0, 2.7)
    ax.set_yticks([0, 1, 2])
    ax.grid(axis="y", color="#D8D8D8", linewidth=0.55)
    ax.set_title("(b) Executed window violations")

    for ax in axes:
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.tick_params(direction="out", length=3, width=0.7)
    fig.subplots_adjust(wspace=0.28, bottom=0.18, top=0.84)
    return save_figure(fig, "fig-governance-ablation-e1a")


def draw_e1a_single(ablation: list[dict]):
    labels = ["Full", "No interlock", "No readback", "Ungated"]
    means = [np.mean([r["interception_pct"] for r in arm["repeats"]]) for arm in ablation]
    palette = [COLORS["blue"], COLORS["orange"], COLORS["green"], COLORS["red"]]
    fig, ax = plt.subplots(figsize=(3.35, 2.2))
    x = np.arange(4)
    ax.bar(x, means, color=palette, width=0.58, edgecolor="white", linewidth=0.5)
    for i, arm in enumerate(ablation):
        values = [r["interception_pct"] for r in arm["repeats"]]
        jitter = np.linspace(-0.09, 0.09, len(values))
        ax.scatter(np.full(len(values), i) + jitter, values, s=17, color=COLORS["ink"], edgecolor="white", linewidth=0.4, zorder=3)
        ax.text(i, means[i] + 4, f"{means[i]:.1f}%", ha="center", va="bottom", fontsize=7)
    ax.set_xticks(x, labels, rotation=18, ha="right")
    ax.set_ylabel("Negative probes rejected (%)")
    ax.set_ylim(0, 118)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.grid(axis="y", color="#D8D8D8", linewidth=0.55)
    ax.set_title("Four-arm governance ablation")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(direction="out", length=3, width=0.7)
    fig.subplots_adjust(bottom=0.25, top=0.84, left=0.18, right=0.98)
    return save_figure(fig, "fig-governance-ablation-e1a-single")


def draw_phase_status(phases: list[dict]):
    colors = {"pass": COLORS["green"], "warn": COLORS["orange"], "fail": COLORS["red"], "skip": "#C7CDD2"}
    labels = [p.get("phase", "?") for p in phases]
    fig_h = max(3.4, 0.25 * len(phases))
    fig, ax = plt.subplots(figsize=(7.0, fig_h))
    y = np.arange(len(phases))
    ax.barh(y, [1] * len(phases), color=[colors.get(p["status"], COLORS["gray"]) for p in phases], height=0.68)
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.set_xlim(0, 1.65)
    ax.set_xticks([])
    ax.grid(False)
    for yi, phase in enumerate(phases):
        ax.text(1.04, yi, phase["status"].upper(), va="center", ha="left", fontsize=7, color=COLORS["ink"])
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis="y", length=0, pad=6)
    fig.subplots_adjust(left=0.48, right=0.98, top=0.98, bottom=0.03)
    return save_figure(fig, "fig-integrated-stage-status")


def phase_counts(run: dict):
    return [
        {"phase": p.get("phase", "?"), "title": p.get("title", ""), "status": p.get("status", "unknown"), "note": p.get("note", "")}
        for p in run.get("phases", [])
    ]


def load_integrated(run_id: str):
    path = RESULTS / run_id
    run = read_json(path / "run.json")
    summary = read_json(path / "summary.json")
    env = run["env"]
    p6 = [row for row in run.get("closedloop", {}).get("perSeed", [])] if run.get("closedloop") else []
    if not p6:
        p6 = run.get("p6", [])
    if not p6:
        # The raw metric registry is the authoritative per-seed result table.
        with (path / "metrics.csv").open(encoding="utf-8-sig", newline="") as stream:
            p6 = [r for r in csv.DictReader(stream) if r.get("phase") == "P6"]
    normalized = []
    for row in p6:
        normalized.append(
            {
                "seed": int(row["seed"]),
                "ratio": float(row.get("ratio", row.get("J/J*", 0))),
                "J0": float(row.get("J0", 0)),
                "Jend": float(row.get("Jend", 0)),
                "Jstar": float(row.get("Jstar", 0)),
                "iters": int(float(row.get("iters", 0))),
                "writes": int(float(row.get("writes", 0))),
                "converged": str(row.get("converged", "")).lower() == "true",
            }
        )
    biax = env.get("biax") or {}
    traj = [{"iter": 0, "thickness": 28.05}]
    for row in biax.get("missionTraj", []):
        if row.get("iter", 0) > 0:
            traj.append({"iter": row["iter"], "thickness": row["thickness"], "knob": row.get("knob"), "from": row.get("from"), "to": row.get("to")})
    return {
        "id": run_id,
        "env": env,
        "verdict": env.get("verdict", summary.get("verdict", {})),
        "phases": phase_counts(run),
        "summary": summary,
        "p6_rows": normalized,
        "biax_traj": traj,
        "report": (path / "report.md").read_text(encoding="utf-8"),
    }


def write_csv(path: Path, header: list[str], rows: list[list]):
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)


def source_inventory(paths: list[Path]):
    records = []
    for path in sorted(set(p.resolve() for p in paths if p.exists())):
        records.append({"path": rel(path), "bytes": path.stat().st_size, "sha256_at_report_build": sha256(path)})
    target = HERE / "evidence-manifest.json"
    target.write_text(json.dumps({"schema": "experiment-evidence-manifest/1.0", "generated_from": str(Path(__file__).name), "files": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return records


def html_table(headers, rows):
    head = "".join(f"<th>{html.escape(str(x))}</th>" for x in headers)
    body = "".join("<tr>" + "".join(f"<td>{html.escape(str(x))}</td>" for x in row) + "</tr>" for row in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def main():
    setup_style()
    integrated = [load_integrated(run_id) for run_id in INTEGRATED_RUNS]
    latest = integrated[-1]
    e1a_rows_raw, e1a = load_e1a()
    fig1 = draw_integrated_results(latest)
    fig2 = draw_e1a(e1a)
    fig3 = draw_phase_status(latest["phases"])
    fig4 = draw_e1a_single(e1a)

    # Machine-readable data used by the manuscript figures.
    write_csv(
        DATA / "integrated-p6-seeds.csv",
        ["seed", "J0", "Jend", "Jstar", "Jend_over_Jstar", "iterations", "governed_writes", "converged"],
        [[r["seed"], r["J0"], r["Jend"], r["Jstar"], r["ratio"], r["iters"], r["writes"], r["converged"]] for r in latest["p6_rows"]],
    )
    write_csv(
        DATA / "biax-single-mission-trajectory.csv",
        ["action_index", "thickness_um", "knob", "from", "to"],
        [[r["iter"], r["thickness"], r.get("knob", "baseline"), r.get("from", ""), r.get("to", "")] for r in latest["biax_traj"]],
    )
    e1a_plot_rows = []
    for arm in e1a:
        for repeat in arm["repeats"]:
            e1a_plot_rows.append([arm["arm"], repeat["rep"], repeat["attacks"], repeat["blocked"], repeat["interception_pct"], repeat["window_reached_driver"], repeat["false_blocks"], repeat["permitted_attempts"]])
    write_csv(DATA / "e1a-ablation-summary.csv", ["arm", "repeat", "negative_probes", "rejected", "rejection_percent", "window_attacks_reaching_driver", "false_blocks", "permitted_attempts"], e1a_plot_rows)

    precheck = read_json(RESULTS / PRECHECK_FAIL_ID / "run.json")
    scenario_text = (RESULTS / SCENARIO_RUN_ID / "scenarios-benchmark.md").read_text(encoding="utf-8")
    e1a_report = (RESULTS / E1A_ID / "report.md").read_text(encoding="utf-8")
    context_log = PAPER / "qa" / "approval-context-ablation-round18.log"
    context_rows = []
    for line in context_log.read_text(encoding="utf-8").splitlines():
        match = re.match(r"CONTEXT_ABLATION (\{.*\})$", line)
        if match:
            context_rows.append(json.loads(match.group(1)))
    context_enabled = {"challenges": 12, "refused_before_write": 12, "mock_writes": 0, "records": 0}
    context_disabled = {
        "challenges": len(context_rows),
        "reached_driver": sum(not row["refused"] for row in context_rows),
        "mock_writes": sum(row["mockDriverWrites"] for row in context_rows),
        "execution_records": sum(row["newExecutionRecords"] for row in context_rows),
        "line_or_recipe_still_refused": sum(row["changedField"] in {"line", "recipe"} and row["refused"] for row in context_rows),
    }

    doc_root = ROOT / "docs" / "audit" / "evidence" / "2026-10-31-doc-driven-full-acceptance"
    doc_report = ROOT / "docs" / "audit" / "2026-10-31-doc-driven-full-acceptance-report.md"
    if (doc_root / "export-stats.json").exists():
        export_stats = read_json(doc_root / "export-stats.json")
    else:
        export_stats = {}
    if (doc_root / "dcw-roundtrip.json").exists():
        roundtrip = read_json(doc_root / "dcw-roundtrip.json")
    else:
        roundtrip = {}

    run_rows = []
    for record in integrated:
        env, v = record["env"], record["verdict"]
        run_rows.append([
            record["id"],
            env.get("startedAt", ""),
            f"{v.get('pass', 0)} pass / {v.get('warn', 0)} warn / {v.get('fail', 0)} fail",
            f"{100*env.get('closedloop', {}).get('ratioMean', 0):.1f}%",
            env.get("harnessHash", ""),
        ])

    phase_rows = [[p["phase"], p["title"], p["status"].upper(), p["note"] or "—"] for p in latest["phases"]]
    e1a_rows = []
    for arm in e1a:
        blocked = [r["blocked"] for r in arm["repeats"]]
        total = sum(r["attacks"] for r in arm["repeats"])
        rejected = sum(blocked)
        breach = sum(r["window_reached_driver"] for r in arm["repeats"])
        false_blocks = sum(r["false_blocks"] for r in arm["repeats"])
        legal_n = sum(r["permitted_attempts"] for r in arm["repeats"])
        driver_text = f"{breach} total (2/repeat)" if breach else "0"
        e1a_rows.append([arm["arm"], f"{rejected}/{total} ({100*rejected/total:.1f}%)", driver_text, f"{false_blocks}/{legal_n}"])

    sources = []
    for run_id in INTEGRATED_RUNS + [PRECHECK_FAIL_ID]:
        folder = RESULTS / run_id
        sources.extend([folder / name for name in ["report.md", "run.json", "summary.json", "metrics.csv", "line-profile.json", "agentteam-mission.log", "agentteam-biax.log"]])
    scenario_dir = RESULTS / SCENARIO_RUN_ID
    sources.extend([scenario_dir / name for name in ["scenarios-benchmark.md", "scenarios.json", "scenarios-mission-injection.log", "scenarios-mission-wwtp.log", "scenarios-mission-anneal.log", "scenarios-mission-biax.log"]])
    e1a_dir = RESULTS / E1A_ID
    sources.extend([e1a_dir / name for name in ["report.md", "run.json", "e1-lite.csv"]])
    sources.extend([context_log, PAPER / "qa" / "current-full-software-tests-round18.log", ROOT / "tests" / "recipe-approval-snapshot.test.ts", ROOT / "tests" / "recipe-approval-context-ablation.test.ts", ROOT / "bench" / "PIPELINE.md", ROOT / "bench" / "PIPELINE" / "EXPERIMENT-PLAN-GOVERNANCE-HARNESS.md", doc_report])
    sources.extend([doc_root / name for name in ["blueprint.json", "provision.json", "channel.json", "channel-activate.json", "task.json", "doc-summary.json", "dcw-roundtrip.json", "export-stats.json", "live-final.json"]])
    sources.extend(sorted((doc_root / "nodes").glob("*.csv")))
    sources.extend(sorted((doc_root / "frames").glob("*.csv")))
    p12_dir = RESULTS / "p12-20261030173217-8f6e4715-agentteam"
    sources.extend([p12_dir / name for name in ["report.md", "checks.json", "reconciliation.json", "coverage.json", "manifest.json", "run.json"]])
    sources.extend([FIGS / f"{stem}.{ext}" for stem in ["fig-integrated-run-results", "fig-governance-ablation-e1a", "fig-integrated-stage-status", "fig-governance-ablation-e1a-single"] for ext in ["pdf", "png", "svg"]])
    p6 = latest["p6_rows"]
    p6_mean = np.mean([r["ratio"] for r in p6]) * 100 if p6 else 0
    p6_seed_text = "; ".join(f"{r['seed']}: {100*r['ratio']:.1f}% (writes={r['writes']}, iterations={r['iters']})" for r in p6)
    v = latest["verdict"]
    env = latest["env"]
    doc_pass_count = export_stats.get("passed", export_stats.get("pass", "19/19"))
    dcw_summary = "independent DAQ readback: 27 then 25"
    if isinstance(roundtrip, dict):
        # Keep the report resilient to minor field-name changes while retaining source values.
        rendered = json.dumps(roundtrip, ensure_ascii=False).lower()
        if "27" in rendered and "25" in rendered:
            dcw_summary = "independent DAQ readback: 27 then restored to 25"

    html_doc = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2026-10-31 实验结果汇总与论文证据审查</title>
<style>
:root{{--ink:#182433;--muted:#5a6878;--line:#d8e0e8;--blue:#2b5f8a;--green:#28734d;--amber:#a56800;--red:#a03a3a;--paper:#fff;--bg:#f3f6f9}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.58 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif}}
header{{background:#173b5c;color:#fff;padding:30px max(calc((100% - 1160px)/2),24px) 26px}}header h1{{font-size:26px;margin:0 0 8px}}header p{{margin:0;color:#d6e2ec;max-width:1000px}}
main{{max-width:1160px;margin:24px auto;padding:0 22px 42px}}section{{background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:22px 24px;margin:16px 0;box-shadow:0 2px 10px #173b5c0a}}
h2{{font-size:20px;margin:0 0 12px;color:#173b5c}}h3{{font-size:16px;margin:18px 0 8px}}p{{margin:8px 0}}.lead{{font-size:16px}}.cards{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}}.card{{border:1px solid var(--line);border-top:4px solid var(--blue);border-radius:7px;padding:12px;background:#fff}}.card strong{{font-size:21px;display:block}}.card span{{color:var(--muted);font-size:12px}}
.status{{display:inline-block;padding:2px 8px;border-radius:99px;font-weight:650;font-size:12px}}.pass{{background:#e7f3ec;color:var(--green)}}.warn{{background:#fff3d9;color:var(--amber)}}.fail{{background:#fbe8e8;color:var(--red)}}.notrun{{background:#e9edf1;color:#59636c}}.callout{{border-left:4px solid var(--amber);background:#fff8e8;padding:12px 15px;margin:12px 0}}.callout.red{{border-color:var(--red);background:#fff1f1}}.callout.green{{border-color:var(--green);background:#eff8f2}}
table{{border-collapse:collapse;width:100%;margin:10px 0 16px;font-size:13px}}th,td{{border-bottom:1px solid var(--line);padding:8px 9px;text-align:left;vertical-align:top}}th{{background:#f0f4f7;color:#263b4c;font-weight:650}}td code,code{{font-family:Consolas,"SFMono-Regular",monospace;font-size:.92em}}.chart{{width:100%;height:auto;border:1px solid #e5e9ed;border-radius:6px;margin:10px 0}}.two{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.steps{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;counter-reset:step}}.step{{position:relative;border:1px solid var(--line);border-radius:7px;padding:12px 12px 12px 42px;min-height:100px}}.step:before{{counter-increment:step;content:counter(step);position:absolute;left:12px;top:12px;width:22px;height:22px;line-height:22px;text-align:center;background:#e8f0f6;color:var(--blue);font-weight:700;border-radius:50%}}.small{{font-size:12px;color:var(--muted)}}.legend{{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px}}a{{color:#175b8f}}ul{{margin:6px 0 8px;padding-left:21px}}li{{margin:4px 0}}.nowrap{{white-space:nowrap}}
@media(max-width:780px){{.cards{{grid-template-columns:repeat(2,1fr)}}.steps{{grid-template-columns:repeat(2,1fr)}}.two{{grid-template-columns:1fr}}header{{padding:22px}}main{{padding:0 12px}}section{{padding:18px}}table{{display:block;overflow-x:auto}}}}
</style></head><body>
<header><h1>实验结果汇总与论文证据审查</h1><p>审查截至 2026-10-31 的可追溯结果。主线聚焦多协议场景接入、治理路径、参数写入与过程观测；结果来自不同批次时分别呈现，不合并成一条端到端轨迹。</p></header>
<main>
<section><h2>结论先览</h2><p class="lead">最新集成批次 <code>{LATEST_ID}</code> 在本地确定性模拟环境中达到 <b>{v.get('pass',0)} 项通过、{v.get('warn',0)} 项警告、{v.get('fail',0)} 项失败</b>（报告评分 99.6/100）。它支持多协议接入和受治理软件路径的工程可行性论述，但运行元数据显示 <b>没有启用 LLM Agent harness</b>；不能据此主张 Agent 自主控制、模型可替换或真实产线效果。</p>
<div class="cards"><div class="card"><strong>5 / 5</strong><span>协议设备接入；5 个采集节点记录 54 个样本</span></div><div class="card"><strong>24 / 24</strong><span>四种可写协议上的负向探针被拦截</span></div><div class="card"><strong>{p6_mean:.1f}%</strong><span>固定种子 J/J* 均值；seed 43 未写入</span></div><div class="card"><strong>1 warning</strong><span>唯一警告来自 BOPET 语义卡描述检查</span></div></div>
<div class="callout"><b>证据层级：</b>系统确定性集成（可用于限定性工程论据）≠真实模型驱动任务（本批未运行）≠审批门 ON/OFF 消融（尚未执行）≠真实设备验证。</div></section>

<section><h2>按流程核对：最新集成实验</h2><p>运行：<code>{LATEST_ID}</code>；配置：seed 42，cast-film 模拟场景；工具驱动：deterministic OpenCode adapter；模型 Agent：none。平台与模拟器在运行前已存在，且 AW_HOME 为共享目录，因此该运行不是冷启动隔离部署。</p>
<div class="steps"><div class="step"><b>资格与启动</b><br>平台/模拟器可达；状态为 already-up/reused。<br><span class="small">不代表本批冷启动复现</span></div><div class="step"><b>配置与协议</b><br>5 个模拟设备覆盖 Modbus TCP/RTU、OPC UA、MQTT、HTTP；5 个节点可采样。<br><span class="small">4 条主线 + 1 条卫星采集</span></div><div class="step"><b>治理与读写</b><br>四种可写协议负向探针 24/24 被拒绝；写操作 p50 为 31.649 ms。<br><span class="small">本地模拟协议事务</span></div><div class="step"><b>过程结果</b><br>3 个固定 seed 的仿真目标比值为 96.3–98.8%；BOPET 任务 3 次写入后报告值 24.84 µm。<br><span class="small">BOPET 账本存在未闭合记录</span></div></div>
<div class="two"><div><h3>优化轨迹与过程结果</h3><img class="chart" src="figures/fig-integrated-run-results.png" alt="P6 seed objective ratio and BOPET process trajectory"><p class="small">左：seed 42/43/44 的 J<sub>end</sub>/J*；seed 43 起点已满足 benchmark 判据，0 次迭代、0 次写入。右：一次 BOPET 任务轨迹；仅最终读数进入目标带，单次任务不支持因果或重复性结论。</p></div><div><h3>阶段状态</h3><img class="chart" src="figures/fig-integrated-stage-status.png" alt="Stage status for latest integrated run"><p class="small">17 个阶段状态：16 项 PASS、1 项 WARN、0 项 FAIL；P10 的单项警告为语义卡描述检查。分数按 PIPELINE 权重计，不等于统计置信度或产品成熟度。</p></div></div>
<h3>闭环仿真分种子结果</h3>{html_table(["Seed","J0","Jend","J*","Jend/J*","迭代","治理写入","判定"],[[r['seed'],f"{r['J0']:.2f}",f"{r['Jend']:.2f}",f"{r['Jstar']:.2f}",f"{100*r['ratio']:.1f}%",r['iters'],r['writes'],"满足脚本判据" if r['converged'] else "未满足"] for r in latest['p6_rows']])}
<p class="small">报告的 mean J/J* 为 97.8%（seed 42=98.8%，43=96.3%，44=98.3%）。此处 seed 是同一仿真 benchmark 的固定起始状态；不是三个独立部署，也没有基线控制器的配对比较。seed 43 的数值来自零动作起点。</p>
<h3>阶段明细</h3>{html_table(["阶段","状态","检查/说明"],[[p["phase"]+" — "+p["title"],p["status"].upper(),p["note"] or "—"] for p in latest["phases"]])}</section>

<section><h2>同批重跑与失败批次：不能合并分母</h2><p>当天三个 integrated 报告均显示硬门通过，但同为 seed 42、复用共享 AW_HOME，checker 源哈希分别不同；因此不是冻结代码下的三次独立重复实验。最新批次用于正文的受限主结果，较早重跑用于审计复现性，不做跨运行平均。</p>
{html_table(["运行","阶段检查","J/J* 均值","checker hash","解释"],[[r[0],r[2],r[3],r[4],"同 seed/共享运行环境；不并成 n=3" ] for r in run_rows])}
<div class="two"><div class="callout red"><b>未通过的启动尝试：</b><code>{PRECHECK_FAIL_ID}</code> 在私有模拟器启动隔离检查处超时，0 条产线、0 样本；未进入有效实验阶段，不纳入结果分母，但保留在此审计记录中。</div><div class="callout red"><b>四场景并行尝试：</b><code>{SCENARIO_RUN_ID}</code> 判 FAIL。注塑、污水、退火三个脚本任务达到各自目标；BOPET 0 次写入、0 轮迭代、27.40 µm 未达 25±0.7 µm。不能据此写成四场景全成功。</div></div></section>

<section><h2>治理消融：哪些结果存在，哪些没有</h2><p>下图和表基于最近保存的 E1a 四臂 API 级模拟器消融，seed 42、每臂 3 次、每次 6 个负向探针。实验因素是 interlock/readback/authorization 组合，不是预注册的审批门 ON/OFF 单因素实验。</p><img class="chart" src="figures/fig-governance-ablation-e1a.png" alt="Four-arm governance ablation result">
{html_table(["E1a 臂","负向探针拦截","越窗请求到达 mock driver","合法尝试误拦"],e1a_rows)}
<p>Full 与 no-readback 两臂均拦截 18/18 负向探针；no-interlock 与 ungated 各拦截 12/18，且每次重复均有 2 个窗口类请求到达 mock driver。每臂合法测试请求误拦为 0（报告的边界合法检查 9/9）。这说明所测低层 mock/API fixture 中，窗口联锁参与拦截窗口越限请求；它不等于审批门效果，也不证明真实驱动或人机审批性能。</p>
<h3>独立的审批上下文复核组件消融</h3><p>另一组 12 个 mock-driver 挑战覆盖 3 条 recipe 路由 × 4 个身份字段。上下文比较启用时 12/12 在写入前拒绝；仅在测试变体移除 tuple 比较后，6 个 product/run 变化各产生 2 次 mock write 和 1 条 execution record，line/recipe 变化仍被其他检查拒绝。该结果只归因于身份上下文比较这一组件。</p>
<div class="callout"><b>计划中的 A1/A2 状态：</b>A1（完整 Agent 工具链审批 ON/OFF）和 A2（OMP/OpenCode × Qwen/DeepSeek 四组合）均为 NOT-RUN，执行器未实现。现有 E1a 与组件消融不可替代这两项实验；本报告与论文均不填入推测结果。</div></section>

<section><h2>配置驱动虚拟线：从文档到采集、导出和分离写读回</h2><p>这是单独的文档驱动虚拟线验收，不与 integrated seed runs 或 Agent 优化任务合并。依据虚拟接口说明建立 HTTP/MQTT 设备映射；配置供给 11/11 项通过，新线 5/5 个 DAQ 节点在线；64 点向量帧按向量接口读取；lead 只读任务完成并检查 5 条 acquisition streams；导出校验 19/19 通过（4 个标量文件 818 行，向量 54×64=3,456 点）。</p><p><b>写入与读任务分离：</b>管理员另行将 SP 从 25 写到 27，再恢复到 25；独立 DAQ 两次读到 27 和 25。该写入没有 Agent task、actor、approval 或 driver-event 关联，不能称为 Agent 参数下发闭环。HTTP 返回的 <code>readback-verified</code> 是响应回显，设备证据来自独立 DAQ。</p><div class="callout green">可支持：虚拟接口配置、异构标量/向量采集、数据导出与一次独立 DAQ 写后读回。不能支持：多 Agent 实际协作、Agent 发起写入或审批门消融。</div></section>

<section><h2>真实 harness、回归套件与实验覆盖缺口</h2><div class="two"><div><h3>真实 AgentTeam episode</h3><p>最近合格的完整 P12 证据包来自 OMP + 本机 Qwen 配置：资格检查通过，但 workflow 和 evidence-integrity 均 FAIL，任务 CANCELED，0 个已验证审批、0 个通过的受治理写入。此记录说明实际 harness 闭环未得到有效结果，不纳入论文正向实验结果。</p><h3>软件回归（支持性证据）</h3><ul><li>unit：915 项，913 pass、0 fail、2 skipped；</li><li>MCP 14/14，plugin lifecycle 22/22，twin-provider 5/5，skills 147/147；</li><li>line-governance 44/44；11 plugins 无 failures，126/126 工具可用。</li></ul><p class="small">API-live 因 fresh-instance 注册前置不满足而未获合格运行，不能计入产品通过数。</p></div><div><h3>论文可用性判定</h3><ul><li><b>可写：</b>本地模拟多协议配置与采集；负向写探针拦截；固定种子的确定性仿真过程结果；有限的写后独立读回。</li><li><b>需限定：</b>单次/固定 seed、共享平台状态、不同批次、mock driver、模型调用未启用或未留存。</li><li><b>不能写：</b>审批 ON/OFF 因果结论、Harness 或模型优劣/可替换性、多 Agent 自主优化能力、显著性、物理产线效果或上线结论。</li></ul><p>当前证据可以支撑一篇系统工程可行性论文中的受限实验论据；仍不足以作为完整的 TII 对照/消融与真实 Agent 验证。</p></div></div></section>

<section><h2>证据链与复现信息</h2><p>可重跑的主命令：<code>node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3</code>。E1a 命令见原始报告。当前最新 integrated run 本身没有随包生成 SHA256SUMS/manifest；本汇总对引用文件记录了生成报告时的 SHA-256，<b>这是事后字节指纹，不等同于原始运行冻结或运行时防篡改证明</b>。</p><p>机器可读的 plotted source data、绘图脚本及证据清单位于本报告目录。原始结果保留在各自的 <code>bench/results</code> 和文档驱动证据目录中。</p><p class="small">图表采用白底、二维线/点/柱图与简洁坐标轴，数据点来自结果文件；未添加合成样本、置信区间或显著性标记。SHA-256 清单：<a href="evidence-manifest.json">evidence-manifest.json</a>。</p></section>
</main></body></html>"""

    (HERE / "report.html").write_text(html_doc, encoding="utf-8")

    md = f"""# 2026-10-31 实验结果汇总与论文证据审查

## 结论

最新 integrated 批次 `{LATEST_ID}`：{v.get('pass', 0)} PASS、{v.get('warn', 0)} WARN、{v.get('fail', 0)} FAIL（加权评分 99.6/100）。本地确定性模拟环境覆盖五种协议，5 个采集节点记录 54 个样本，四种可写协议的负向探针 24/24 拒绝，写操作 p50=31.649 ms。该批运行未启用 LLM Agent harness。

闭环仿真 `J/J*`：{p6_seed_text}；均值 {p6_mean:.1f}%。seed 43 为 0 写入/0 迭代。BOPET 单次任务写入 3 个参数后报告膜厚 24.84 µm，落在 25±0.7 µm 内，但日志/汇总的优化账本存在未闭合差异。

## 批次和流程状态

{html_table(["Run","阶段检查","J/J*均值","checker hash","备注"],[[r[0],r[2],r[3],r[4],"same seed/shared state; not pooled as n=3"] for r in run_rows])}

- 首轮 `{PRECHECK_FAIL_ID}` 因私有模拟器预启动隔离检查超时而未进入有效阶段，0 线/0 样本，排除在实验分母外并保留审计记录。
- 多场景 `{SCENARIO_RUN_ID}` 判 FAIL：注塑/污水/退火 3 项达标；BOPET 0 次写入、0 次迭代，27.40 µm 未达 25±0.7 µm。
- 同 seed、共享 AW_HOME，checker hash 变化，不将上述 PASS 重跑视为统计独立重复。

## 消融结果

{html_table(["Arm","负向拦截","窗口越限到达驱动","合法请求误拦"],e1a_rows)}

E1a 是 API/mock 层四臂消融，每臂 3 repeats、每次 6 个负向探针；full/no-readback 为 18/18 拒绝，no-interlock/ungated 为 12/18 拒绝，窗口类请求每 repeat 有 2 个到达 mock driver（每个受影响臂共 6 个）。A1 审批门 ON/OFF 与 A2 Harness×模型矩阵均 NOT-RUN、runner NOT-IMPLEMENTED。

上下文比较组件消融：启用时 12/12 个身份字段挑战在写入前拒绝；移除测试变体中的 tuple comparison 后，product/run 6 个挑战到达 mock driver，各产生 2 次 mock writes 和 1 条 execution record；line/recipe 六个仍被其他检查拒绝。不是审批门消融。

## 文档驱动虚拟线验收

独立批次：provision 11/11；新线 DAQ 5/5 在线；lead 只读任务完成，检查 5 条 acquisition streams（含 64 点向量）；导出 19/19（标量 818 行，向量 54×64=3,456 点）。独立管理员 SP=25→27→25，独立 DAQ 两次读回一致；写入未关联 Agent task/actor/approval/driver event。

## 真实 harness 与论文边界

P12 OMP/Qwen 配置 episode 资格通过，但 workflow 与 evidence integrity FAIL，task CANCELED，0 verified approvals、0 accepted governed writes。不得作为成功 Agent evidence。软件回归：unit 913/915 pass（2 skipped），MCP 14/14、plugin lifecycle 22/22、twin-provider 5/5、skills 147/147、line-governance 44/44；这些是契约/回归证据，不是工艺结果。

当前结果可支持模拟器中的系统集成可行性和限定的软件治理行为；不能支持审批因果效应、Harness/模型可替换性、多 Agent 自主优化或物理设备表现。

## 复现与审计

- 主命令：`node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3`
- E1a：见 `bench/results/{E1A_ID}/report.md` 与 `e1-lite.csv`。
- 图表、数据 CSV、生成脚本和事后 SHA-256 清单与本报告同目录。
- 当前 integrated raw bundle 缺少运行时 SHA256SUMS；本报告的 hash 是生成时核验的事后指纹，不是原始冻结证明。
"""
    (HERE / "report.md").write_text(md, encoding="utf-8")

    sources.extend([HERE / "build_report.py", HERE / "report.html", HERE / "report.md"])
    sources.extend(sorted(FIGS.glob("*")))
    sources.extend(sorted((DATA).glob("*.csv")))
    manifest = source_inventory(sources)

    print(json.dumps({
        "latest_run": LATEST_ID,
        "latest_verdict": v,
        "phase_count": len(latest["phases"]),
        "p6_seeds": latest["p6_rows"],
        "e1a": e1a,
        "context_ablation_rows": len(context_rows),
        "doc_export_stats_keys": sorted(export_stats.keys()) if isinstance(export_stats, dict) else [],
        "evidence_files_hashed": len(manifest),
        "report": rel(HERE / "report.html"),
        "figures": [rel(fig1), rel(fig2), rel(fig3), rel(fig4)],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
