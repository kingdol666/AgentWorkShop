from __future__ import annotations

import csv
import hashlib
import html
import json
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch


ROOT = Path(__file__).resolve().parents[4]
REPORT = Path(__file__).resolve().parent
DOC_EVIDENCE = ROOT / "docs/audit/evidence/2026-10-31-doc-driven-full-acceptance"
IDD_EVIDENCE = ROOT / "docs/audit/evidence/2026-10-31-idd-rag-integration"
QWEN_EVIDENCE = ROOT / "docs/audit/evidence/2026-10-30-real-channel-mission/report.json"
P12 = ROOT / "bench/results/p12-20261030173217-8f6e4715-agentteam"
PROTOCOL = ROOT / "bench/results/20261029180436-1lo0"
EXPORT = Path("D:/tmp/aw-idd-rag-e2e-20261030/data/daq-exports/daqexp-20261031014629-b6bee4")
SUPP = ROOT / "paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5-Evidence"

PALETTE = {
    "ink": "#203440",
    "muted": "#60737d",
    "line": "#cbd8dd",
    "navy": "#205b73",
    "teal": "#268a8c",
    "green": "#367a5a",
    "amber": "#bb842d",
    "red": "#ad514b",
    "pale": "#eef5f5",
    "pale_red": "#fbefed",
    "pale_amber": "#fbf4e7",
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def copy_exact(source: Path, destination: Path, records: list[dict]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    if source.is_relative_to(ROOT):
        source_ref = source.relative_to(ROOT).as_posix()
    elif source.is_relative_to(EXPORT):
        source_ref = f"external-export/{source.relative_to(EXPORT).as_posix()}"
    else:
        source_ref = "external-source/" + source.name
    records.append({
        "source": source_ref,
        "delivered": str(destination.relative_to(SUPP)),
        "source_sha256": digest(source),
        "delivered_sha256": digest(destination),
        "bytes": destination.stat().st_size,
        "transformed": False,
    })


def build_figures(stats: dict, task: dict, dcw: dict, manifest: dict) -> None:
    mpl.rcParams.update({
        "font.family": "serif",
        "font.serif": ["Times New Roman", "Liberation Serif", "DejaVu Serif"],
        "font.size": 8.5,
        "axes.labelsize": 8,
        "axes.titlesize": 9,
        "xtick.labelsize": 7.5,
        "ytick.labelsize": 7.5,
        "legend.fontsize": 7,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "axes.edgecolor": PALETTE["line"],
        "axes.labelcolor": PALETTE["ink"],
        "text.color": PALETTE["ink"],
        "xtick.color": PALETTE["muted"],
        "ytick.color": PALETTE["muted"],
    })

    fig = plt.figure(figsize=(7.16, 4.35), layout="constrained")
    grid = fig.add_gridspec(2, 2, height_ratios=[0.84, 1.16], hspace=0.22, wspace=0.25)
    flow = fig.add_subplot(grid[0, :])
    flow.set_axis_off()
    flow.set_xlim(0, 1)
    flow.set_ylim(0, 1)
    steps = [
        ("Interface contract", "6 declared points\nHTTP + MQTT"),
        ("Scene mapping", "5 DAQ + 1 DCW\n11/11 provisioning"),
        ("Channel task", "4 roles configured\nlead-only read task"),
        ("Independent write", "operator initiated\n25 → 27 → 25"),
        ("Evidence export", "19/19 checks\n818 scalar + 3456 vector rows"),
    ]
    xs = [0.02, 0.217, 0.414, 0.611, 0.808]
    box_w = 0.17
    for i, (title, detail) in enumerate(steps):
        x = xs[i]
        box = FancyBboxPatch(
            (x, 0.26), box_w, 0.56,
            boxstyle="round,pad=0.012,rounding_size=0.025",
            facecolor=PALETTE["pale"] if i < 3 or i == 4 else PALETTE["pale_amber"],
            edgecolor=PALETTE["line"],
            linewidth=0.8,
        )
        flow.add_patch(box)
        flow.text(x + box_w / 2, 0.66, title, ha="center", va="center",
                  fontsize=8, fontweight="bold", color=PALETTE["navy"])
        flow.text(x + box_w / 2, 0.45, detail, ha="center", va="center",
                  fontsize=7, color=PALETTE["muted"], linespacing=1.25)
        if i < len(steps) - 1:
            flow.annotate("", xy=(xs[i + 1] - 0.012, 0.54), xytext=(x + box_w + 0.012, 0.54),
                          arrowprops={"arrowstyle": "-|>", "color": PALETTE["teal"], "lw": 1.1})
    flow.text(0.5, 0.97, "Document-driven virtual integration: evidence path and separation of actors",
              ha="center", va="top", fontsize=9, fontweight="bold", color=PALETTE["ink"])
    flow.text(0.5, 0.08,
              "The channel task was read-only; the operator write/readback test is a separate episode.",
              ha="center", va="center", fontsize=7.2, color=PALETTE["red"])

    coverage = fig.add_subplot(grid[1, 0])
    labels = ["Enclosure PV", "SP readback", "Profile frames", "Ambient temp.", "Humidity"]
    counts = [17, 17, 22, 17, 17]
    colors = [PALETTE["navy"], PALETTE["teal"], PALETTE["amber"], PALETTE["teal"], PALETTE["teal"]]
    bars = coverage.barh(range(len(labels)), counts, color=colors, height=0.58, edgecolor="white", linewidth=0.5)
    bars[2].set_hatch("///")
    coverage.set_yticks(range(len(labels)), labels)
    coverage.invert_yaxis()
    coverage.set_xlim(0, 27)
    coverage.set_xlabel("Reported query units")
    coverage.set_title("Lead-task acquisition", loc="left", fontweight="bold")
    coverage.grid(axis="x", color=PALETTE["line"], linewidth=0.5, alpha=0.8)
    coverage.set_axisbelow(True)
    for index, count in enumerate(counts):
        suffix = " frames × 64" if index == 2 else " buckets"
        coverage.text(count + 0.5, index, f"{count}{suffix}", va="center", fontsize=7, color=PALETTE["ink"])
    coverage.spines[["top", "right", "left"]].set_visible(False)
    coverage.spines["bottom"].set_color(PALETTE["line"])

    sequence = fig.add_subplot(grid[1, 1])
    observed = [25.0, 25.0, float(dcw["readback27"]["value"]), float(dcw["readback25"]["value"])]
    xvals = [0, 1, 2, 3]
    sequence.step(xvals, observed, where="mid", color=PALETTE["navy"], linewidth=1.8, zorder=2)
    sequence.scatter(xvals, observed, s=35, color=PALETTE["teal"], edgecolor="white", linewidth=0.6, zorder=3)
    sequence.scatter([1], [27], marker="x", s=38, color=PALETTE["red"], linewidth=1.5, zorder=4)
    sequence.set_xticks(xvals, ["Start", "Rejected\nattempt", "DAQ readback", "Restored\nDAQ readback"])
    sequence.set_ylim(23.7, 28.2)
    sequence.set_ylabel("Setpoint (°C)")
    sequence.set_title("Independent write/readback sequence", loc="left", fontweight="bold")
    sequence.grid(axis="y", color=PALETTE["line"], linewidth=0.5, alpha=0.8)
    sequence.set_axisbelow(True)
    sequence.spines[["top", "right"]].set_visible(False)
    sequence.spines["left"].set_color(PALETTE["line"])
    sequence.spines["bottom"].set_color(PALETTE["line"])
    sequence.annotate("cooldown gate; state stayed at 25 °C", xy=(1, 25), xytext=(1.12, 24.25),
                      arrowprops={"arrowstyle": "->", "color": PALETTE["red"], "lw": 0.8},
                      fontsize=6.6, color=PALETTE["red"])
    sequence.text(0.5, -0.32, "Ordered events; horizontal spacing is not elapsed time.",
                  transform=sequence.transAxes, ha="center", va="top", fontsize=6.7, color=PALETTE["muted"])

    fig.savefig(REPORT / "integration-evidence.pdf", bbox_inches="tight")
    fig.savefig(REPORT / "integration-evidence.svg", bbox_inches="tight")
    fig.savefig(REPORT / "integration-evidence.png", dpi=450, bbox_inches="tight")
    plt.close(fig)

    # Paper-sized vector copy.
    paper_resource = ROOT / "paper/tii/SUBMISSION-IEEE-TII/resources/fig-latest-doc-driven-integration.pdf"
    paper_resource.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPORT / "integration-evidence.pdf", paper_resource)


def collect_export_rows() -> list[dict]:
    rows = []
    for path in sorted((EXPORT / "nodes").glob("*.csv")) + sorted((EXPORT / "frames").glob("*.csv")):
        with path.open(newline="", encoding="utf-8-sig") as stream:
            data = list(csv.DictReader(stream))
        numeric = []
        states: dict[str, int] = {}
        for row in data:
            if "state" in row:
                states[row["state"]] = states.get(row["state"], 0) + 1
            if row.get("value") not in ("", None):
                try:
                    numeric.append(float(row["value"]))
                except ValueError:
                    pass
        rows.append({
            "file": path.relative_to(EXPORT).as_posix(),
            "rows": len(data),
            "min": min(numeric) if numeric else None,
            "max": max(numeric) if numeric else None,
            "states": states,
        })
    return rows


def build_package(source_hashes: dict, csv_rows: list[dict]) -> None:
    SUPP.mkdir(parents=True, exist_ok=True)
    copies: list[dict] = []
    file_map = [
        (ROOT / "docs/audit/2026-10-31-doc-driven-full-acceptance-report.md", SUPP / "doc-driven/full-acceptance-report.md"),
        (DOC_EVIDENCE / "blueprint.json", SUPP / "doc-driven/blueprint.json"),
        (DOC_EVIDENCE / "provision.json", SUPP / "doc-driven/provision.json"),
        (DOC_EVIDENCE / "provision.log", SUPP / "doc-driven/provision.log"),
        (DOC_EVIDENCE / "channel.json", SUPP / "doc-driven/channel.json"),
        (DOC_EVIDENCE / "channel-activate.json", SUPP / "doc-driven/channel-activate.json"),
        (DOC_EVIDENCE / "channel.log", SUPP / "doc-driven/channel.log"),
        (DOC_EVIDENCE / "task.json", SUPP / "doc-driven/task.json"),
        (DOC_EVIDENCE / "doc-summary.json", SUPP / "doc-driven/doc-summary.json"),
        (DOC_EVIDENCE / "dcw-roundtrip.json", SUPP / "doc-driven/dcw-roundtrip.json"),
        (DOC_EVIDENCE / "export-stats.json", SUPP / "doc-driven/export-stats.json"),
        (DOC_EVIDENCE / "logs/t0-static.log", SUPP / "doc-driven/logs/t0-static.log"),
        (DOC_EVIDENCE / "logs/t0-lint-final.log", SUPP / "doc-driven/logs/t0-lint-final.log"),
        (DOC_EVIDENCE / "logs/t1-unit-contract.log", SUPP / "doc-driven/logs/t1-unit-contract.log"),
        (DOC_EVIDENCE / "logs/t1-rerun-after-lintfix.log", SUPP / "doc-driven/logs/t1-rerun-after-lintfix.log"),
        (DOC_EVIDENCE / "logs/t2-line-governance.log", SUPP / "doc-driven/logs/t2-line-governance.log"),
        (DOC_EVIDENCE / "logs/t3-api-live.log", SUPP / "doc-driven/logs/t3-api-live.log"),
        (DOC_EVIDENCE / "t4-plugin-tools.json", SUPP / "doc-driven/t4-plugin-tools.json"),
        (QWEN_EVIDENCE, SUPP / "agent-runs/2026-10-30-qwen-report.json"),
        (IDD_EVIDENCE / "aw-iddrag-run.log", SUPP / "agent-runs/2026-10-31-idd-rag-run.log"),
        (IDD_EVIDENCE / "aw-iddrag-evidence.json", SUPP / "agent-runs/2026-10-31-idd-rag-evidence.json"),
        (P12 / "report.md", SUPP / "agent-runs/2026-10-30-p12-report.md"),
        (P12 / "checks.json", SUPP / "agent-runs/2026-10-30-p12-checks.json"),
        (P12 / "manifest.json", SUPP / "agent-runs/2026-10-30-p12-manifest.json"),
        (P12 / "SHA256SUMS", SUPP / "agent-runs/2026-10-30-p12-SHA256SUMS"),
        (PROTOCOL / "report.md", SUPP / "protocol-matrix/2026-10-29-report.md"),
        (PROTOCOL / "summary.json", SUPP / "protocol-matrix/2026-10-29-summary.json"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/evidence.json", SUPP / "route-fixture/R21-evidence.json"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/R21-TRACE-MATRIX.csv", SUPP / "route-fixture/R21-trace-matrix.csv"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/fixture-cast-film.json", SUPP / "route-fixture/R21-cast-film-fixture.json"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/fixture-annealing.json", SUPP / "route-fixture/R21-annealing-fixture.json"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R21/README.md", SUPP / "route-fixture/R21-README.md"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R22/evidence.json", SUPP / "route-fixture/R22-evidence.json"),
        (ROOT / "paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/R22/README.md", SUPP / "route-fixture/R22-README.md"),
        (ROOT / "paper/tii/SUBMISSION-IEEE-TII/resources/figure-source-data/four-scenario-2026-09-28.json", SUPP / "process-missions/four-scenario-2026-09-28.json"),
        (ROOT / "bench/results/20260928020612-1juc/scenarios-mission-injection.log", SUPP / "process-missions/injection.log"),
        (ROOT / "bench/results/20260928020612-1juc/scenarios-mission-biax.log", SUPP / "process-missions/bopet-film.log"),
        (ROOT / "bench/results/20260928020612-1juc/scenarios-mission-anneal.log", SUPP / "process-missions/annealing.log"),
        (ROOT / "bench/results/20260928020612-1juc/scenarios-mission-wwtp.log", SUPP / "process-missions/wastewater.log"),
    ]
    for src, dst in file_map:
        if src.exists():
            copy_exact(src, dst, copies)
    for src in sorted((EXPORT / "nodes").glob("*.csv")) + sorted((EXPORT / "frames").glob("*.csv")):
        copy_exact(src, SUPP / "doc-driven/raw-export" / src.relative_to(EXPORT), copies)
    copy_exact(EXPORT / "manifest.json", SUPP / "doc-driven/raw-export/manifest.json", copies)

    source_manifest = {
        "schema": "tii-supplement-evidence/1",
        "generated_at_local": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
        "primary_run": "2026-10-31 document-driven virtual integration",
        "separate_runs": [
            "2026-10-30 OMP/Qwen assertion record (R2 query result is reclassified as unverified)",
            "2026-10-30 P12 AgentTeam (qualification PASS, workflow FAIL, integrity FAIL)",
            "2026-10-31 03:37 OMP configured USTC/DeepSeek Flash task (10/13, WORKING)",
            "2026-10-29 deterministic five-protocol matrix",
        ],
        "source_checksums": source_hashes,
        "delivered_files": copies,
        "export_csv_rows": csv_rows,
        "interpretation": [
            "The 2026-10-31 channel seed task was read-only and assigned to the lead; it was not a four-agent execution.",
            "The 27 and 25 setpoint writes were an independent operator/controller check, not linked to the read-only agent task.",
            "No A1 approval ablation or A2 Harness/model factorial run is present in this evidence package.",
            "All process endpoints in these results are simulators; no physical plant was tested.",
            "The September four-scene process missions are single scripted trajectories and are not replications of the October integration case.",
        ],
    }
    (SUPP / "SOURCE-MANIFEST.json").write_text(
        json.dumps(source_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    readme = """# Supplementary File S5 evidence bundle

This package contains the exact archived records and raw CSV exports used for the
document-driven virtual integration summary, together with separate records for
the OMP/Qwen write demonstration, the incomplete USTC/DeepSeek-configured task,
the P12 AgentTeam attempt, the deterministic protocol matrix, route fixtures,
and four earlier scripted process missions.

These runs are separate evidence units. The 2026-10-31 channel task was read-only
and assigned to the lead agent. The 25→27→25 HTTP simulator writes were initiated
by the acceptance operator/controller and are not linked to that task by a task,
approval, actor, or driver-event identifier. The OMP/Qwen and USTC/DeepSeek records
are not a matched comparison. A1/A2 were not run.

The route fixtures and September process missions are separate evidence units.
The mission routines selected setpoints deterministically and contain one
trajectory per scene; they are not agent runs or statistical replications.

Raw export CSV files preserve the exported rows, including startup samples marked
offline in the source manifest. The export checks establish manifest/count/range
consistency, not process improvement. All scenarios are local simulations; no
physical equipment was involved.

The adjacent SOURCE-MANIFEST.json records original and delivered SHA-256 hashes
for the copied files. Recompute with the SHA-256 utilities available on the
target platform before relying on the package.
"""
    (SUPP / "README.md").write_text(readme, encoding="utf-8")

    sums = []
    for path in sorted(p for p in SUPP.rglob("*") if p.is_file() and p.name not in {"SHA256SUMS", "Supplementary-File-S5-Evidence.zip"}):
        sums.append(f"{digest(path)}  {path.relative_to(SUPP).as_posix()}")
    (SUPP / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    archive = ROOT / "paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5-Evidence.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(p for p in SUPP.rglob("*") if p.is_file()):
            zf.write(path, Path("Supplementary-File-S5-Evidence") / path.relative_to(SUPP))


def build_html(task: dict, doc_summary: dict, stats: dict, iddr: dict, p12_report: str,
               csv_rows: list[dict], source_hashes: dict) -> None:
    tool_counts: dict[str, int] = {}
    failures = 0
    for event in task.get("history", []):
        for part in event.get("parts", []):
            text = part.get("text", "")
            if not text.startswith("🔧"):
                continue
            name = text[1:].split("(", 1)[0].split(" ", 1)[0]
            tool_counts[name] = tool_counts.get(name, 0) + 1
            if "❌" in text or "失败" in text[:80]:
                failures += 1
    all_members = doc_summary.get("members", [])
    roles = ", ".join(f"{m.get('role')} ({m.get('harness', 'unknown')})" for m in all_members)
    offline = sum(row["states"].get("offline", 0) for row in csv_rows)
    scalar_rows = sum(row["rows"] for row in csv_rows if row["file"].startswith("nodes/"))
    vector_rows = sum(row["rows"] for row in csv_rows if row["file"].startswith("frames/"))
    tool_html = "".join(
        f"<tr><td>{html.escape(name)}</td><td>{count}</td></tr>" for name, count in sorted(tool_counts.items())
    )
    csv_html = "".join(
        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            html.escape(row["file"]), row["rows"],
            "—" if row["min"] is None else f'{row["min"]:.4f}',
            "—" if row["max"] is None else f'{row["max"]:.4f}',
            html.escape(", ".join(f"{k}={v}" for k, v in row["states"].items()) or "vector data"),
        ) for row in csv_rows
    )
    hashes_html = "".join(
        f"<tr><td>{html.escape(k)}</td><td><code>{v}</code></td></tr>" for k, v in source_hashes.items()
    )
    report = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>最新实验结果复核与论文证据报告</title>
<style>
:root{{--ink:#203440;--muted:#5e707a;--line:#d5dfe3;--paper:#fff;--bg:#eef3f5;--teal:#176f80;--green:#347658;--amber:#9b6a20;--red:#a34a45;--pale:#edf5f5;--shadow:0 8px 26px #1b3a4a0c}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}}
main{{max-width:1240px;margin:0 auto;padding:32px 26px 56px}}header,.panel,.card{{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}}
header{{padding:30px 34px;background:linear-gradient(120deg,#fff 10%,#eaf4f5 100%)}}.eyebrow{{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal);font-weight:800}}
h1{{font-size:30px;line-height:1.22;margin:9px 0}}h2{{font-size:21px;margin:0 0 12px}}h3{{font-size:16px;margin:18px 0 7px}}
p{{margin:8px 0}}.lead{{font-size:17px;color:#314c59;max-width:990px}}.pill{{display:inline-block;padding:5px 10px;border-radius:99px;font-size:12px;font-weight:800;margin:3px 5px 3px 0}}
.pass{{background:#e8f4ed;color:var(--green)}}.warn{{background:#fff4e1;color:var(--amber)}}.fail{{background:#f9e9e7;color:var(--red)}}.neutral{{background:#eef1f3;color:#596a73}}
.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:16px 0}}.card{{padding:17px 19px}}.num{{font-size:27px;font-weight:800;line-height:1.2}}.label{{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700}}.note{{font-size:13px;color:var(--muted);margin-top:5px}}
.panel{{padding:22px 25px;margin-top:15px}}table{{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0 4px}}th,td{{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:9px 10px}}th{{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#435a66;background:#f5f8f9}}tbody tr:last-child td{{border-bottom:0}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}.callout{{padding:14px 16px;background:#f5f9fa;border-left:4px solid var(--teal);border-radius:8px}}.callout.red{{border-color:var(--red);background:#fff4f2}}.callout.amber{{border-color:var(--amber);background:#fff9ed}}
img{{display:block;width:100%;height:auto;margin:12px auto 5px;border:1px solid var(--line);border-radius:10px;background:#fff}}code{{font-family:Consolas,monospace;font-size:12px;overflow-wrap:anywhere}}.small{{font-size:12px;color:var(--muted)}}a{{color:#126b7d;text-decoration:none}}a:hover{{text-decoration:underline}}ul{{padding-left:22px}}li{{margin:6px 0}}details{{background:#fbfcfd;border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:10px 13px}}summary{{cursor:pointer;font-weight:700}}
@media(max-width:900px){{.cards{{grid-template-columns:1fr 1fr}}.grid2{{grid-template-columns:1fr}}main{{padding:15px}}}}
@media(max-width:560px){{.cards{{grid-template-columns:1fr}}header{{padding:22px}}h1{{font-size:24px}}.panel{{padding:17px 14px}}table{{font-size:12px}}th,td{{padding:7px 5px}}}}
@media print{{body{{background:#fff;font-size:11pt}}main{{max-width:none;padding:0}}header,.panel,.card{{box-shadow:none;break-inside:avoid}}a{{color:inherit}}}}
</style></head><body><main>
<header><div class="eyebrow">Evidence review · 2026-10-31 · local time UTC+08</div>
<h1>最新实验结果复核与论文证据报告</h1>
<p class="lead">最新的真实 Harness 任务是 03:37 的 OMP Channel 运行，配置记录为 USTC/DeepSeek Flash；它调用了四类工具，但总体验收 10/13，任务仍为 WORKING。较早的文档驱动模拟线运行完成了配置、读取和导出验证，但其写入是独立管理员验收，不是 Agent 写入。</p>
<span class="pill warn">最新任务未收口</span><span class="pill pass">文档驱动接入：限定范围通过</span><span class="pill fail">P12：工作流/证据完整性失败</span><span class="pill neutral">A1/A2：未运行</span></header>
<section class="cards">
<div class="card"><div class="label">Latest Harness episode</div><div class="num" style="color:var(--red)">10 / 13</div><div class="note">4 类真实工具调用；任务 WORKING；没有已记录审批或写入</div></div>
<div class="card"><div class="label">Latest completed integration</div><div class="num" style="color:var(--green)">11 / 11</div><div class="note">新建虚拟线供给；5 DAQ + 1 DCW；1 个只读 lead task 完成</div></div>
<div class="card"><div class="label">Export verification</div><div class="num" style="color:var(--green)">19 / 19</div><div class="note">818 标量行 + 54 × 64 向量点；原始 CSV 已纳入 S5 包</div></div>
<div class="card"><div class="label">PIPELINE A1/A2</div><div class="num" style="color:var(--amber)">未执行</div><div class="note">当前没有审批门消融或完整 Harness × 模型 2 × 2 结果</div></div></section>

<section class="panel"><h2>审阅结论</h2><div class="grid2">
<div class="callout"><b>可以作为论文的有限工程证据</b><br>文档到场景配置、HTTP/MQTT 接入、标量与 64 点向量读取、Channel lead 查询任务、CSV/向量导出一致性，以及独立虚拟 DCW 写后 DAQ 读回。</div>
<div class="callout red"><b>不能据此写成的结论</b><br>四 Agent 协作完成控制、Agent 发起的 27→25 写入、审批门消融、模型/Harness 因果比较、工艺优化收益、实体工厂安全或上线性能。</div></div>
<p>一项更晚的 OMP 配置任务被记录为 USTC/DeepSeek Flash，但包中没有运行时 Provider/Model 回读；因此只称为“配置/记录为”，不视为已完成模型身份核验。不同批次的任务、写入和测试计数不合并。</p></section>

<section class="panel"><h2>最新系统回归测试结果（按阶段）</h2><p>以下是 10/31 报告留存的 T0–T4 结果；软件契约测试与模拟工艺运行分开统计。通过项仅代表所列检查，不外推到未运行的完整功能矩阵。</p>
<table><thead><tr><th>阶段</th><th>执行与结果</th><th>判读</th></tr></thead><tbody>
<tr><td>T0 · 静态门禁</td><td>lint 修复后通过；typecheck、docs:check、i18n:check、readme:lint 均通过。首轮曾发现 5 个 lint 错误，已修复并复跑。</td><td><span class="pill pass">完成</span></td></tr>
<tr><td>T1 · 单元与接口契约</td><td>915 tests：913 pass、0 fail、2 skipped；MCP 14/14；plugin lifecycle 22/22；SDK surface PASS；twin-provider 5/5；skills 147/147。</td><td><span class="pill pass">完成</span></td></tr>
<tr><td>T2 · 核心闭环</td><td>隔离线治理 44/44；文档驱动虚拟验证完成供给、只读任务、独立写读回和导出核验。其他高负载本体/优化器/UI/模型套件本轮未运行。</td><td><span class="pill pass">限定覆盖</span></td></tr>
<tr><td>T3 · API 回归</td><td>api-live 未获合格运行：脚本要求 fresh-instance 注册，既有 3300 服务注册已关闭；其他 T3 本轮未跑。</td><td><span class="pill warn">前置不满足</span></td></tr>
<tr><td>T4 · 插件与工具面</td><td>11 个插件，0 个 reported failures；126 个工具均 available。</td><td><span class="pill pass">完成</span></td></tr>
</tbody></table><p class="small">该矩阵说明本轮静态、契约、治理和插件工具面检查的状态；不等于完整系统回归全部通过，也不是统计性能实验。</p></section>

<section class="panel"><h2>实验步骤与观测</h2><img src="integration-evidence.png" alt="文档驱动模拟场景的流程、查询采样与设定值独立读回">
<table><thead><tr><th>阶段</th><th>执行情况</th><th>结果和证据边界</th></tr></thead><tbody>
<tr><td>1 · 接口契约</td><td>六个点位：HTTP 箱体温度 PV/SP/SP 回读/64 点壁厚向量；MQTT 环境温度/湿度。</td><td>本地虚拟设备，仅 loopback；不是厂家 PLC 文档。</td></tr>
<tr><td>2 · 生成配置</td><td>从接口说明生成 blueprint 与 provision；创建新 line、5 DAQ、1 DCW、产品和配方；11/11 供给检查通过、跨线冲突 0。</td><td>不等同任意工业场景自动零配置；原报告修正了两个 MQTT 节点的采样周期偏差。</td></tr>
<tr><td>3 · 建立协作面</td><td>Channel 配置 lead + 3 workers，四个成员的适配器字段均为 OMP；激活记录只证明 lead 已 wired。</td><td>模型身份未留存；没有 worker 子任务派发证据。</td></tr>
<tr><td>4 · 执行 Agent 任务</td><td>一个 lead 的只读任务 COMPLETED/100；历史含工具调用和最终交付，覆盖 4 个 scalar 查询及 64 点向量读取。</td><td>没有通过该任务执行写入。工作流有一次参数校验错误后按要求参数重试；不作为调用成功率估计。</td></tr>
<tr><td>5 · 独立写读回</td><td>管理员/验收控制器独立发起 SP=27 与恢复 25；独立 DAQ 分别观测到 27 与 25。较早一次请求被 60 s 冷却拦截。</td><td>HTTP POST 的回显不算设备回读；两次 DAQ 值是 readback evidence。没有 approvalId/taskId/Agent driver 事件关联。</td></tr>
<tr><td>6 · 导出验证</td><td>19/19 manifest/表头/行数/向量形状/值域检查通过。</td><td>4 个 scalar CSV 共 818 行，向量 CSV 为 54 帧 × 64 点 = 3,456 行；启动期有状态为 offline 的数据行，完整性检查不等于全行有效。</td></tr>
</tbody></table></section>

<section class="panel"><h2>导出 CSV 核验</h2><p>原始 CSV 从导出任务的运行目录复制到 Supplementary File S5 Evidence；下表由这些文件重新计数。标量导出行数与平台查询使用的降采样 bucket 数不同，两者不可相加。</p>
<table><thead><tr><th>文件</th><th>导出行数</th><th>最小</th><th>最大</th><th>行状态</th></tr></thead><tbody>{csv_html}</tbody></table>
<p class="small">共计：{scalar_rows} 标量行，{vector_rows} 向量点；在 scalar CSV 中计得 {offline} 行标为 offline。19/19 检查核验的是导出契约，不把 offline 行自动解释成有效观测。</p></section>

<section class="panel"><h2>不同批次的证据矩阵</h2><table><thead><tr><th>运行</th><th>实测结果</th><th>审计分类</th><th>可支持的结论</th></tr></thead><tbody>
<tr><td>10/31 03:37 · OMP / USTC-DeepSeek Flash 配置任务</td><td>10/13；daq_query、daq_export、diag_run、kb_agent 被真实调用；50 个 DAQ 点；任务 WORKING；0 审批卡。</td><td><span class="pill fail">未完成</span></td><td>支持一次工具面/后端调用探索；不支持任务完成、治理写入或 A2 模型比较。</td></tr>
<tr><td>10/31 01:41 · 文档驱动 HTTP/MQTT 模拟线</td><td>11/11 供给；5/5 acquisition streams；只读 lead task COMPLETED；19/19 导出；独立管理员写读回 27/25。</td><td><span class="pill pass">限定范围通过</span></td><td>接口映射、读取、导出与独立模拟写读回。不是四 Agent 控制闭环。</td></tr>
<tr><td>10/30 · OMP/Qwen 真实模型记录</td><td>R3 pending 时 SP=195；脚本批准后 SP=198。R4 写入 SP=200.5；JSON 的 PV=199.45。R2 任务取消且返回数字不匹配。</td><td><span class="pill warn">部分有效</span></td><td>R3/R4 支持一次模型参与的模拟器写入路径；R2 原 PASS 判据不可靠，查询结果排除。</td></tr>
<tr><td>10/30 · PIPELINE P12 AgentTeam</td><td>资格 PASS；workflow FAIL；evidence integrity FAIL；CANCELED；0 个 verified approvals、0 个 accepted DCW writes；run ended on stale/future DAQ sample.</td><td><span class="pill fail">不构成完整 episode</span></td><td>说明完整 AgentTeam 任务和证据关联尚未通过。</td></tr>
<tr><td>10/29 · 五协议确定性矩阵</td><td>Modbus TCP/RTU、OPC UA、MQTT、HTTP；52 个 acquisition samples；24/24 越界探针被拒绝。LLM 关闭。</td><td><span class="pill neutral">独立组件证据</span></td><td>只支持该次仿真协议/护栏覆盖；不能与最新 Channel run 合并。</td></tr>
<tr><td>路由状态读回 fixture</td><td>注册任务 route 与 direct REST 两场景共 4 个设定值转换均有独立状态读回；使用合成管理员批准。</td><td><span class="pill neutral">独立路由检查</span></td><td>支持状态转换记录，不支持 Agent 决策或写后工艺响应。</td></tr>
<tr><td>9/28 四场景脚本任务</td><td>注塑 31.296→32.36 g；BOPET 28.03→25.30 μm；退火 134.9→99.5 HV；污水 DO 0.194→3.54 mg/L，均落入各自报告窗口。</td><td><span class="pill neutral">单次轨迹</span></td><td>每场景一个脚本控制轨迹；不作基线比较或重复试验统计。</td></tr>
<tr><td>A1/A2 预注册实验</td><td>runner 未实现；approval-only bypass 未资格化；四个 harness × model 组合未全部通过预检。</td><td><span class="pill warn">NOT-RUN</span></td><td>无审批门差异或 Harness/模型效应可以报告。</td></tr>
</tbody></table></section>

<section class="panel"><h2>模型运行证据纠偏</h2><div class="callout amber"><b>10/30 Qwen run 的 R2.1 虽标 PASS，但不能算查询成功。</b> 原始 JSON 记录任务状态 CANCELED，交付数字为 37、120、260、120、260、195、53、195；runner 用整个对话历史里的任意数字与 simulator truth 比较，未要求准确解析 DAQ 结果。报告中 207.67/205.83 °C 与 200.84 °C 也无法由该 JSON 支持；R4.2 原始值为 PV=199.45 °C、SP=200.5 °C。修订稿将 R2 降为未验证，仅保留 R3/R4 可对账的设备写证。</div>
<p>最新 DeepSeek-configured episode 的插件面检查和复用产线启动检查失败，任务没有到终态。P12 的资格门通过，但 actor/task/tool 关联和团队派发/工作流门未通过。完整记录均保留在报告和 S5 证据包中，不将失败项从总体状态中隐藏。</p></section>

<section class="panel"><h2>论文证据是否充足</h2><table><thead><tr><th>论文主张</th><th>当前证据</th><th>判定</th><th>措辞建议</th></tr></thead><tbody>
<tr><td>配置异构场景并统一采集</td><td>两种协议的最新文档驱动线；另有五协议确定性矩阵及多场景历史模拟。</td><td>有限支持</td><td>“在所测模拟配置中完成映射和数据访问”。</td></tr>
<tr><td>真实 Agent 任务使用数据工具</td><td>一次 Channel lead 只读任务完成；较晚 DeepSeek-configured task 调用了四类工具但未收口。</td><td>有限支持</td><td>明确单次配置、身份留存缺口和任务未完成记录。</td></tr>
<tr><td>Agent 受治理参数写入</td><td>单次 OMP/Qwen 的 pending→scripted approval→SP=198；后续探索写 SP=200.5。</td><td>有限支持</td><td>模拟器集成演示；不是人工审批有效性或实体安全验证。</td></tr>
<tr><td>多 Agent/Harness 可替换、优化改善或上线效果</td><td>P12 workflow/integrity fail；A1/A2 未运行；没有重复/基线比较。</td><td>不支持</td><td>不能作出因果、优越性、等效性或现场就绪结论。</td></tr>
</tbody></table></section>

<section class="panel"><h2>复现材料</h2><p>结构化证据与 CSV 已打包在 <a href="../../../../paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5-Evidence.zip">Supplementary-File-S5-Evidence.zip</a>；格式化补充说明见 <a href="../../../../paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5.pdf">Supplementary-File-S5.pdf</a>。图表源代码为本目录的 <code>build_report.py</code>，输出图表为 PDF/SVG/PNG。</p>
<table><thead><tr><th>归档源</th><th>SHA-256</th></tr></thead><tbody>{hashes_html}</tbody></table>
<p class="small">校验列表位于 S5 Evidence 包的 SOURCE-MANIFEST.json 和 SHA256SUMS。文档驱动证据的原始归档当初没有 hash 清单；此报告在归档副本上生成新的、可核验的文件清单，不把它冒充成实验当时生成的 run manifest。</p></section>
<p class="small" style="text-align:center;margin-top:18px">所有性能数值均为本地模拟器、单次工程运行记录；图中顺序轴不表示连续时间，且不表示因果效果。</p>
</main></body></html>"""
    (REPORT / "report.html").write_text(report, encoding="utf-8")


def build_markdown(stats: dict, task: dict, iddr: dict, csv_rows: list[dict]) -> None:
    lines = [
        "# 最新实验结果复核与论文证据报告",
        "",
        "> 当前最新 OMP Channel 任务配置记录为 USTC/DeepSeek Flash，但验收 10/13、任务仍为 WORKING；不能作为完整成功。较早文档驱动模拟线受控范围通过，可支持接口接入、读取、导出和独立管理员写读回，不支持 Agent 写控制或多 Agent 协同。",
        "",
        "## 总体判断",
        "",
        "- 可作为论文工程集成证据：HTTP/MQTT 场景映射、标量/向量采集、lead 只读 Channel task、导出契约和分离的模拟写读回。",
        "- 不足以证明：四 Agent 实际协作、Agent 发起的 27→25 写入、审批门消融、Harness/模型效应、工艺改善或实体设备可投运。",
        "- A1/A2 仍为 NOT-RUN；最新 P12 资格虽通过，但工作流与证据完整性均失败。",
        "",
        "## 文档驱动模拟线的完整步骤",
        "",
        "1. 按虚拟接口说明定义 6 个信号：HTTP 箱体温度 PV/SP/回读/64 点壁厚向量，MQTT 环境温度/湿度。",
        "2. 生成 blueprint 与 provision；新增 5 DAQ、1 DCW、产品/配方；供给检查 11/11，通过跨线冲突检查。",
        "3. 建立 lead + 3 worker 配置的 Channel。执行证据只显示 lead wired，四个 harness 字段配置为 OMP；model/provider 未归档。",
        "4. lead 执行一个只读任务并完成。结果检查了 5 个 acquisition streams，包括一个 64 点向量；没有在该 task 内写参数。",
        "5. 独立管理员验收将 SP 写至 27 再恢复到 25；独立 DAQ 分别读到 27 和 25。一次较早请求因 60 s cooldown 被拒绝。写入与 task 无 actor/task/approval/driver 关联。",
        "6. 导出检查 19/19：4 个标量 CSV 共 818 行，向量 CSV 为 54×64=3,456 点。CSV 中包括启动时 offline 行；完整性检查不代表每行都有效。",
        "",
        "## T0–T4 最新系统回归",
        "",
        "| 阶段 | 本轮实测 | 状态边界 |",
        "|---|---|---|",
        "| T0 静态门禁 | lint 修复后通过；typecheck、docs、i18n、README 检查通过 | 首轮 5 个既有 lint 错误已修复并复跑 |",
        "| T1 单元/契约 | unit 915：913 pass、0 fail、2 skipped；MCP 14/14；plugin lifecycle 22/22；SDK surface pass；twin-provider 5/5；skills 147/147 | 仅为软件契约结果 |",
        "| T2 核心闭环 | line-governance 44/44；文档驱动虚拟线限定验收通过 | 本体、优化器、UI 等重负载套件本轮未跑 |",
        "| T3 API-live | fresh-instance 前置不满足，未获合格运行；其他 T3 未跑 | 不计为产品通过或失败 |",
        "| T4 插件/工具 | 11 插件、0 failures；126/126 工具 available | 工具注册不等于每工具端到端执行 |",
        "",
        "## 最新 OMP Channel 运行",
        "",
        f"- 记录时间：{iddr.get('at')}；证据目录记录 IDD/RAG episode。",
        "- 配置：OMP Channel lead，配置/报告记为 USTC/DeepSeek Flash；provider/model runtime readback 未留存。",
        "- 通过项：后端健康、配置/工业工具注册、任务启动、四类工具调用（daq_query、daq_export、diag_run、kb_agent）、诊断与 RAG 结果标记。",
        "- 未通过项：插件启用确认、复用产线开跑、任务收口；最终 10/13，task state=WORKING，无 approval card、无完整写入链。",
        "",
        "## 关键纠偏",
        "",
        "- 10/30 Qwen run 的 R2.1 原标 PASS，但原始 report.json 记录 task CANCELED，交付数字与 DAQ 结果不符；脚本从整个 history 任取数字做近似比较，不能视为查询成功。",
        "- 同一 report.json 支持 R3 的待审批 SP=195、脚本批准后 SP=198，以及 R4 的 SP=200.5；R4.2 原始 PV=199.45。接受报告中的 207.67/205.83、200.84 数字没有匹配原始 JSON。",
        "- P12 最新完整 evidence bundle 为 qualification PASS、workflow FAIL、integrity FAIL；任务 CANCELED，0 个 verified approvals、0 个 accepted writes。不能列为成功 AgentTeam episode。",
        "- A1/A2 runner 和 approval-only ablation 尚未资格化；doc-driven 和 IDD/RAG 运行不替代它们。",
        "",
        "## 其他独立论文证据（不与最新集成任务合并）",
        "",
        "- 五协议确定性矩阵：五种本地模拟协议、52 个采集样本、四种可写协议；24/24 越界探针被拒绝，LLM 关闭。",
        "- 路由状态 fixture：注册任务路由与 direct REST 两场景共四次状态转换均有独立状态读回；管理员批准为合成刺激，无 Agent 候选选择和写后过程响应。",
        "- 四个 2026-09-28 脚本模拟任务分别报告注塑 31.296→32.36 g、BOPET 28.03→25.30 μm、退火 134.9→99.5 HV、污水 DO 0.194→3.54 mg/L。每个场景只有一条轨迹，控制由脚本确定，不是 LLM 选择或复现实验。",
        "",
        "## 原始 CSV 行核验",
        "",
        "| 文件 | 行数 | min | max | 状态 |",
        "|---|---:|---:|---:|---|",
    ]
    for row in csv_rows:
        state = ", ".join(f"{k}={v}" for k, v in row["states"].items()) or "vector data"
        lines.append(f"| {row['file']} | {row['rows']} | {row['min'] if row['min'] is not None else '—'} | {row['max'] if row['max'] is not None else '—'} | {state} |")
    lines += [
        "",
        "## 论文适用性",
        "",
        "文档驱动 run 适合用作系统配置/接入可行性的主工程案例，但需要与单次 OMP/Qwen 写入记录分开。没有重复试验、统计区间、传统控制器 baseline 或完整 A1/A2 消融；当前数据不足以支持控制性能优越性、多 Agent 协同效能、模型替代效果或真实产线部署结论。",
        "",
        "## 证据",
        "",
        "- 完整图文：report.html",
        "- S5 结构化补充文件及原始 CSV：paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5.pdf 与 Supplementary-File-S5-Evidence.zip",
        "- 本地 source evidence: docs/audit/evidence/2026-10-31-doc-driven-full-acceptance/",
        "- 最新任务: docs/audit/evidence/2026-10-31-idd-rag-integration/",
        "- P12: bench/results/p12-20261030173217-8f6e4715-agentteam/",
    ]
    (REPORT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    doc_summary = read_json(DOC_EVIDENCE / "doc-summary.json")
    task = read_json(DOC_EVIDENCE / "task.json")
    stats = read_json(DOC_EVIDENCE / "export-stats.json")
    dcw = read_json(DOC_EVIDENCE / "dcw-roundtrip.json")
    iddr = read_json(IDD_EVIDENCE / "aw-iddrag-evidence.json")
    qwen = read_json(QWEN_EVIDENCE)
    p12_report = (P12 / "report.md").read_text(encoding="utf-8")
    raw_manifest = read_json(EXPORT / "manifest.json")

    assert task["state"] == "COMPLETED" and task["progress"] == 100
    assert stats["verdict"] == "PASS" and stats["pass"] == stats["total"] == 19
    assert dcw["readback27"]["value"] == 27 and dcw["readback25"]["value"] == 25
    assert iddr["results"] and sum(bool(r["pass"]) for r in iddr["results"]) == 10
    assert qwen["assertions"][0]["id"] == "R0.1"
    assert (P12 / "SHA256SUMS").exists()
    csv_rows = collect_export_rows()
    scalar_count = sum(row["rows"] for row in csv_rows if row["file"].startswith("nodes/"))
    vector_count = sum(row["rows"] for row in csv_rows if row["file"].startswith("frames/"))
    assert scalar_count == 818 and vector_count == 3456
    assert raw_manifest["nodes"][2]["frames"] == 54 and raw_manifest["nodes"][2]["vector"]["points"] == 64

    source_paths = {
        "doc_task": DOC_EVIDENCE / "task.json",
        "doc_summary": DOC_EVIDENCE / "doc-summary.json",
        "independent_write": DOC_EVIDENCE / "dcw-roundtrip.json",
        "export_stats": DOC_EVIDENCE / "export-stats.json",
        "latest_iddrag": IDD_EVIDENCE / "aw-iddrag-evidence.json",
        "qwen_run": QWEN_EVIDENCE,
        "p12_report": P12 / "report.md",
        "p12_checks": P12 / "checks.json",
    }
    source_hashes = {name: digest(path) for name, path in source_paths.items()}
    build_figures(stats, task, dcw, raw_manifest)
    build_package(source_hashes, csv_rows)
    build_html(task, doc_summary, stats, iddr, p12_report, csv_rows, source_hashes)
    build_markdown(stats, task, iddr, csv_rows)

    out_manifest = {
        "schema": "latest-experiment-review/1",
        "source_hashes": source_hashes,
        "csv_recount": csv_rows,
        "checks": {
            "doc_task_completed": task["state"] == "COMPLETED",
            "export_19_of_19": stats["pass"] == 19 and stats["total"] == 19,
            "scalar_csv_rows": scalar_count,
            "vector_points": vector_count,
            "iddrag_pass_count": 10,
            "iddrag_total": len(iddr["results"]),
            "a1_a2_status": "NOT-RUN",
        },
    }
    (REPORT / "review-manifest.json").write_text(json.dumps(out_manifest, indent=2) + "\n", encoding="utf-8")
    sums = []
    for path in sorted(p for p in REPORT.iterdir() if p.is_file() and p.name != "SHA256SUMS"):
        sums.append(f"{digest(path)}  {path.name}")
    (REPORT / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print(f"Report written: {REPORT / 'report.html'}")
    print(f"Supplementary bundle: {ROOT / 'paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S5-Evidence.zip'}")
    print(f"CSV rows: scalar={scalar_count}; vector={vector_count}; export checks={stats['pass']}/{stats['total']}")


if __name__ == "__main__":
    main()
