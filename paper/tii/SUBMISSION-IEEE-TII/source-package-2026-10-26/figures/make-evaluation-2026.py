#!/usr/bin/env python3
"""Rebuild three IEEE TII evaluation figures from immutable archived artifacts.

No services or devices are contacted. Run from any directory with Python,
matplotlib and PyMuPDF. Source data, alignment and QA reports are emitted beside
this revision's evidence document. Native exported dimensions are final print
sizes; no tight bounding-box rescaling is applied. All marks represent archived
snapshots or command events; no interpolated waveform, CI or replicate is added.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import MaxNLocator

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent
ROOT = PAPER.parents[2]
REV = ROOT / "paper/tii/revision-2026-10-20"
OUT = PAPER / "resources"
REV.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
BLUE, ORANGE, GREEN, DARK, LIGHT = "#245D85", "#B96A22", "#37816F", "#262626", "#EAF1ED"
plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
    "font.size": 9, "axes.labelsize": 9, "axes.titlesize": 9,
    "xtick.labelsize": 9, "ytick.labelsize": 9, "legend.fontsize": 9,
    "axes.linewidth": 0.6, "lines.linewidth": 1.0,
    "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    "xtick.major.size": 2.5, "ytick.major.size": 2.5,
    "axes.spines.top": False, "axes.spines.right": False,
    "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none",
    "legend.frameon": False, "savefig.facecolor": "white",
})


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8-sig"))


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def write_json(name, data):
    (REV / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def csv_out(name, rows):
    keys = list(dict.fromkeys(k for row in rows for k in row))
    with (REV / name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()})


def tag(ax, label):
    ax.text(0, 1.08, "(" + label + ")", transform=ax.transAxes,
            va="bottom", ha="left", fontsize=9, fontweight="bold")
    ax.set_gid(label)
    ax.tick_params(direction="out")
    ax.xaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))


def band(ax, target, tol):
    ax.axhspan(target - tol, target + tol, color=LIGHT, zorder=0)
    ax.axhline(target - tol, color=GREEN, linewidth=0.5, linestyle=":")
    ax.axhline(target + tol, color=GREEN, linewidth=0.5, linestyle=":")
    ax.axhline(target, color=GREEN, linewidth=0.6, linestyle="--")


def source_receipt(paths):
    return [{"path": p, "sha256": hashlib.sha256((ROOT / p).read_bytes()).hexdigest()} for p in paths]


def export(fig, name, skill_root, axes=None, preview_name=None):
    sys.path.insert(0, str(skill_root / "scripts"))
    from audit_panel_alignment import require_matplotlib_panel_alignment
    fig.canvas.draw()
    require_matplotlib_panel_alignment(
        fig, axes=axes, json_out=REV / (name + ".alignment.json"),
        overlay_svg=REV / (name + ".alignment.svg"), tolerance_pt=1.5,
        gutter_tolerance_pt=1.5, strict=True,
    )
    for ext in ("pdf", "svg"):
        fig.savefig(OUT / (name + "." + ext))
    fig.savefig(OUT / ((preview_name or name) + ".png"), dpi=600)
    plt.close(fig)


def injection(skill_root):
    rel = "bench/results/injection-pressure-loop-2026-10-18T12-37-22-157Z/summary.json"
    src = load(rel)
    b = src["baseline"]
    rows = [{"trial": 0, "source": rel, "anchor": "baseline", "requested_bar": b["p"],
             "platform_bar": b["p"], "hold_time_s": b["t"], **b["q"],
             "timestamp": datetime.fromtimestamp(b["q"]["lastAt"] / 1000, tz=__import__("datetime").timezone.utc).isoformat(),
             "confirmed_parameters": None}]
    for item in src["results"]:
        if not re.fullmatch(r"P3-\d+", item["id"]):
            continue
        text = item["detail"]
        row = {"trial": int(item["id"].split("-")[1]), "source": rel,
               "anchor": "results[" + item["id"] + "].detail", "hold_time_s": b["t"]}
        for key in ("weight", "flash", "sink", "p"):
            row[key] = float(re.search(key + r"=([0-9.]+)", text).group(1))
        row["requested_bar"] = float(re.search(r"→([0-9.]+)bar", text).group(1))
        row["platform_bar"] = row.pop("p")
        row["timestamp"] = re.search(r"lastAt=([^ ]+)", text).group(1)
        row["batch_prefix"] = re.search(r"批次 (rr-[a-z0-9]+)", text).group(1)
        row["confirmed_parameters"] = "1/1" if "全部设备证实(1/1" in text else None
        row["melt"] = None
        rows.append(row)
    assert [r["requested_bar"] for r in rows] == [45, 50, 55, 60, 65]
    assert b["t"] == 6
    assert all(r["platform_bar"] == r["requested_bar"] for r in rows)
    t0 = stamp(rows[0]["timestamp"])
    for row in rows:
        row["snapshot_elapsed_s"] = stamp(row["timestamp"]) - t0
    csv_out("source-data-injection.csv", rows)
    write_json("source-data-injection.json", {"unit": "one simulator-backed recipe trajectory", "n": 1,
        "approval": "test-harness supplied", "time_semantics": "DAQ maximum-node timestamp; each trial followed by 65-s wait",
        "readback_semantics": "platform DCW state plus textual per-parameter confirmation; no independent raw device trace",
        "missing_guard": "melt temperature", "sources": source_receipt([rel]), "snapshots": rows})
    fig, axs = plt.subplots(1, 3, figsize=(7.16, 2.35))
    fig.subplots_adjust(left=.075, right=.985, bottom=.24, top=.80, wspace=.38)
    x = [r["trial"] for r in rows]
    ax = axs[0]; tag(ax, "a"); band(ax, 32.5, .35)
    ax.plot(x, [r["weight"] for r in rows], "o-", color=BLUE, markersize=3.5, markerfacecolor="white")
    ax.set(xlabel="Recipe trial index", ylabel="Part weight (g)", ylim=(31.05, 33.05), xlim=(-.25, 4.25))
    ax.set_title("Quality attainment", pad=20)
    ax.text(.98, .08, "32.30 g", transform=ax.transAxes, ha="right", color=BLUE)
    ax = axs[1]; tag(ax, "b")
    ax.plot(x, [r["sink"] for r in rows], "o-", color=BLUE, markersize=3.5, markerfacecolor="white", label="Sink (limit 1.5%)")
    ax.plot(x, [r["flash"] for r in rows], "s--", color=ORANGE, markersize=3, markerfacecolor="white", label="Flash (limit 0.4%)")
    ax.axhline(1.5, color=BLUE, linewidth=.6, linestyle=":")
    ax.axhline(.4, color=ORANGE, linewidth=.6, linestyle=":")
    ax.set(xlabel="Recipe trial index", ylabel="Defect metric (%)", ylim=(-.13, 2.85), xlim=(-.25,4.25))
    ax.set_title("Observed guard metrics", pad=20)
    ax.legend(loc="upper left", bbox_to_anchor=(.02,1.02), ncol=1, handlelength=1.3, labelspacing=.15)
    ax = axs[2]; tag(ax, "c")
    ax.plot(x[1:], [r["requested_bar"] for r in rows[1:]], color=BLUE, linestyle="--", marker="o", markersize=5,
            markerfacecolor="white", label="Command")
    ax.plot(x, [r["platform_bar"] for r in rows], color=DARK, linestyle="none", marker="x", markersize=3.7,
            markeredgewidth=.8, label="Platform state")
    ax.set(xlabel="Recipe trial index", ylabel="Hold pressure (bar)", ylim=(40,76), xlim=(-.25,4.25))
    ax.set_title("Actuation evidence", pad=20)
    ax.legend(loc="upper left", handlelength=1.3, borderpad=.1, labelspacing=.2)
    for k in x[1:]:
        ax.text(k, 42, "1/1", ha="center", va="bottom", fontsize=9)
    fig.text(.53,.025,"n = 1; index 0 = baseline; 65-s waits; hold time = 6 s; snapshots",ha="center",fontsize=9)
    export(fig, "fig-injection-controls", skill_root)
    return rows


def timeline(skill_root):
    rel = "docs/benchmarks/benchmark-20261009033810/timeline.jsonl"
    raw = [json.loads(s) for s in (ROOT / rel).read_text(encoding="utf-8").splitlines() if s.strip()]
    rows = []
    origins = {stage: stamp(next(r["ts"] for r in raw if r["stage"] == stage and r["type"] == "observation")) for stage in ("S4","S5")}
    for number, item in enumerate(raw, 1):
        if item["stage"] in origins:
            rows.append({"source":rel,"line":number, **item, "local_elapsed_s":stamp(item["ts"])-origins[item["stage"]],
                         "S4_elapsed_s":stamp(item["ts"])-origins["S4"]})
    csv_out("source-data-governance.csv", rows)
    write_json("source-data-governance.json", {"sources":source_receipt([rel]),"events":rows,"n":1,"approval":"test harness supplied"})
    s4 = [r for r in rows if r["stage"] == "S4"]
    s5 = [r for r in rows if r["stage"] == "S5"]
    get = lambda ss, kind: next(r["local_elapsed_s"] for r in ss if r["type"] == kind)
    fig, axs = plt.subplots(2,1,figsize=(3.5,2.75))
    fig.subplots_adjust(left=.17,right=.97,bottom=.225,top=.845,hspace=1.12)
    ax=axs[0];tag(ax,"a")
    a=get(s4,"cadence-wait");b=[r["local_elapsed_s"] for r in s4 if r["type"]=="propose"][-1]
    ax.fill_between([a,b],.18,.70,color="#F5E8D7",lw=0)
    ax.hlines(0,0,get(s4,"verify"),color=DARK,lw=.7)
    ax.plot([r["local_elapsed_s"] for r in s4],[0]*len(s4),linestyle="none",marker="o",ms=2.5,color=BLUE)
    ax.text((a+b)/2,.43,f"Cadence {b-a:.3f} s",ha="center",va="center",fontsize=9)
    ax.text(0,-.40,"Observe / propose",ha="left",va="center",fontsize=9)
    ax.text(82,-.40,"Approve / dispatch",ha="center",va="center",fontsize=9)
    ax.text(96.105,.96,"Verify 65|65|65",ha="right",va="center",fontsize=9)
    ax.set(xlim=(-2,101),ylim=(-.75,1.4),yticks=[],xlabel="")
    ax.set_title("S4: verified state at 96.105 s",pad=15)
    ax=axs[1];tag(ax,"b")
    a=get(s5,"settle-wait");b=get(s5,"verdict")
    ax.fill_between([a,b],.18,.70,color="#F5E8D7",lw=0)
    ax.hlines(0,0,b,color=DARK,lw=.7)
    ax.plot([r["local_elapsed_s"] for r in s5],[0]*len(s5),linestyle="none",marker="s",ms=2.5,color=BLUE)
    ax.text((a+b)/2,.45,f"Wait {b-a:.3f} s",ha="center",va="center",fontsize=9)
    ax.text(0,-.4,"40 → 40.5°C; blocked",ha="left",va="center",fontsize=9)
    ax.text(b,-.4,"40°C",ha="right",va="center",fontsize=9)
    ax.set(xlim=(-2,101),ylim=(-.75,1.15),yticks=[],xlabel="Time from S5 observation (s)")
    ax.set_title("S5: rollback after the write interval",pad=15)
    fig.text(.52,.015,"S4 converged = false; no terminal quality claim",ha="center",fontsize=9)
    export(fig,"fig-governance-timeline",skill_root)


def mission_data():
    rel="bench/results/20260921184204-10lc/scenarios.json"
    src=load(rel)
    missions={m["id"]:m for m in src["results"]}
    all_events=[];outcomes=[]
    for mid,m in missions.items():
        traj=m["mission"]["traj"]
        for k,t in enumerate(traj):
            outcomes.append({"mission":mid,"source":rel,"anchor":f"results[id={mid}].mission.traj[{k}]",**t})
        for t in traj[1:]:
            all_events.append({"mission":mid,"event":sum(x["mission"]==mid for x in all_events)+1,
                "knob":t["knob"],"from":t["from"],"to":t["to"],"record":t.get("record"),"judge":t.get("judge"),
                "kind":"requested", "source":rel,"anchor":f"results[id={mid}].mission.traj[{traj.index(t)}]"})
    # The remaining WWTP control events are explicitly retained in archived ev strings.
    w=missions["wwtp"]["mission"]["ev"]
    for j,text in enumerate(w):
        if "(降耗)" not in text:continue
        match=re.search(r"(风机|NaOH) ([0-9.]+)→([0-9.]+)",text)
        if not match:raise ValueError("Cannot parse archived WWTP event: "+text)
        knob="blower-hz-sp" if match[1]=="风机" else "naoh-dose-sp"
        origin,target=float(match[2]),float(match[3])
        rejected="回退" in text
        event=sum(x["mission"]=="wwtp" for x in all_events)+1
        all_events.append({"mission":"wwtp","event":event,"knob":knob,"from":origin,"to":target,
            "record":None,"judge":None,"kind":"reverted candidate" if rejected else "kept trim",
            "source":rel,"anchor":f"results[id=wwtp].mission.ev[{j}]"})
        if rejected:
            all_events.append({"mission":"wwtp","event":event+1,"knob":knob,"from":target,"to":origin,
                "record":None,"judge":None,"kind":"compensation","source":rel,
                "anchor":f"results[id=wwtp].mission.ev[{j}] (rollback stated; no separate raw receipt)"})
    a=missions["anneal"]["mission"]["ev"]
    j=next(j for j,s in enumerate(a) if "164→176" in s)
    for event,origin,target,kind in [(5,164.,176.,"reverted candidate"),(6,176.,164.,"compensation")]:
        all_events.append({"mission":"anneal","event":event,"knob":"line-speed-sp","from":origin,"to":target,
            "record":None,"judge":None,"kind":kind,"source":rel,"anchor":f"results[id=anneal].mission.ev[{j}]"})
    csv_out("source-data-missions-controls.csv",all_events)
    csv_out("source-data-missions-outcomes.csv",outcomes)
    write_json("source-data-missions.json",{"sources":source_receipt([rel]),"seed":src["seed"],"n_per_mission":1,
        "raw_results":src["results"],"controls":all_events,
        "scope":"seed-42 scripted platform tool-API operation path; normalized u is request intent, not raw device readback"})
    return missions,all_events


def missions(skill_root):
    ms,events=mission_data()
    ids=["injection","wwtp","anneal","biax"]
    names=["Injection molding","Wastewater","Annealing","BOPET film"]
    qty=["Weight (g)","DO (mg/L)","Hardness (HV)","Thickness (µm)"]
    pv_units={"injection":"g","wwtp":"mg/L","anneal":"HV","biax":"µm"}
    controls={
        "injection":[("hold-pressure-sp","Pressure",BLUE,"o"),("hold-time-sp","Hold time",ORANGE,"s")],
        "wwtp":[("blower-hz-sp","Blower",BLUE,"o"),("naoh-dose-sp","NaOH",ORANGE,"s"),("pac-dose-sp","PAC",GREEN,"^")],
        "anneal":[("zone3-sp","Zone 3",BLUE,"o"),("zone2-sp","Zone 2",ORANGE,"s"),("line-speed-sp","Line speed",GREEN,"^")],
        "biax":[("cast-spd-sp","Casting",BLUE,"o"),("fast-roll-sp","Fast roll",ORANGE,"s"),("rail-out-sp","Rail width",GREEN,"^")],
    }
    fig,axs=plt.subplots(2,4,figsize=(7.16,3.55))
    fig.subplots_adjust(left=.075,right=.99,bottom=.26,top=.84,wspace=.65,hspace=.95)
    for c,mid in enumerate(ids):
        m=ms[mid];t=m["mission"]["traj"];ee=[e for e in events if e["mission"]==mid]
        if mid=="wwtp":
            yy=[r["pv"] for r in t if r["phase"] in ("baseline","blower")]
            xx=list(range(len(yy)));xf=max(e["event"] for e in ee)
        else:
            yy=[r["pv"] for r in t]
            xx=list(range(len(yy)));xf=max(e["event"] for e in ee)
        ax=axs[0,c];tag(ax,chr(97+c))
        if mid=="wwtp":
            # The DO series ends after the blower phase. Later controls target
            # pH and total phosphorus, so retain the event-index gap visibly.
            ax.axvspan(5.5,xf,color="#F4F6F5",zorder=-1)
            ax.axvline(5.5,color="#89938E",linewidth=.6,linestyle=":",zorder=2)
        band(ax,m["pv"]["target"],m["pv"]["tol"])
        ax.plot(xx,yy,"o-",color=BLUE,ms=3,mfc="white")
        if mid=="anneal":
            ax.plot([5],[101.3],marker="x",color=ORANGE,ms=4,linestyle="none")
            ax.plot([1],[yy[1]],marker="^",color=DARK,mfc="white",ms=5,linestyle="none")
        terminal=float(m["mission"]["final"])
        ax.plot([xf],[terminal],marker="s",color=DARK,ms=3.5,linestyle="none",zorder=5)
        all_y=yy+[terminal,m["pv"]["target"]-m["pv"]["tol"],m["pv"]["target"]+m["pv"]["tol"]]
        lo,hi=min(all_y),max(all_y);span=hi-lo
        ax.set_ylim(lo-.10*span,hi+.18*span)
        ax.set_xlim(-.4,xf+.6);ax.set_ylabel(qty[c],labelpad=1)
        ax.set_title(f"{names[c]}\nFinal: {terminal:.2f} {pv_units[mid]}",pad=20,linespacing=1.05)
        ax.set_xlabel("")
        ax=axs[1,c];tag(ax,chr(101+c));ax.axhline(0,color="#888888",lw=.5,ls=":")
        if mid=="wwtp":
            ax.axvspan(5.5,xf,color="#F4F6F5",zorder=-1)
            ax.axvline(5.5,color="#89938E",linewidth=.6,linestyle=":",zorder=2)
        for knob,label,color,marker in controls[mid]:
            es=[e for e in ee if e["knob"]==knob];base=es[0]["from"];cur=base
            xs=[0];ys=[0.]
            for e in ee:
                if e["knob"]==knob:cur=e["to"]
                xs.append(e["event"]);ys.append(100.*(cur-base)/base)
            ax.step(xs,ys,where="post",color=color,lw=.85,ls="--" if marker=="s" else "-",label=label)
            for e in es:
                ax.plot([e["event"]],[100.*(e["to"]-base)/base],marker="x" if e["kind"]=="reverted candidate" else marker,
                        ms=3.2,mfc="white",mec=color,color=color,linestyle="none")
        ax.set_xlim(-.4,xf+.6)
        y0,y1=ax.get_ylim();ax.set_ylim(min(-2,y0),y1+(y1-y0)*.55)
        ax.set_ylabel("Requested change (%)",labelpad=1)
        ax.set_xlabel("Control event index",labelpad=1)
        ax.legend(loc="lower left",bbox_to_anchor=(.14,.95),fontsize=9,handlelength=.8,borderpad=.1,labelspacing=.15,handletextpad=.3)
    native_units = {"hold-pressure-sp":"bar", "hold-time-sp":"s", "blower-hz-sp":"Hz", "naoh-dose-sp":"L/h", "pac-dose-sp":"L/h", "zone3-sp":"°C", "zone2-sp":"°C", "line-speed-sp":"m/min", "cast-spd-sp":"m/min", "fast-roll-sp":"m/min", "rail-out-sp":"mm"}
    short_names = {"hold-pressure-sp":"Pressure", "hold-time-sp":"Time", "blower-hz-sp":"Blower", "naoh-dose-sp":"NaOH", "pac-dose-sp":"PAC", "zone3-sp":"Z3", "zone2-sp":"Z2", "line-speed-sp":"Speed", "cast-spd-sp":"Cast", "fast-roll-sp":"Roll", "rail-out-sp":"Rail"}
    for c,mid in enumerate(ids):
        native=[]
        for knob,label,color,marker in controls[mid]:
            es=[e for e in events if e["mission"]==mid and e["knob"]==knob]
            native.append(f"{short_names[knob]} {es[0]['from']:g} → {es[-1]['to']:g} {native_units[knob]}")
        pos=axs[1,c].get_position()
        fig.text(.98 if c == 3 else (pos.x0+pos.x1)/2,.015,"\n".join(native),
                 ha="right" if c == 3 else "center",va="bottom",fontsize=9,linespacing=1.12)
    export(fig,"fig-missions-controls",skill_root,preview_name="fig-missions-controls-preview")


def quality_audits(skill_root):
    scripts=skill_root/"scripts"
    results=[]
    def check(label,args):
        p=subprocess.run([sys.executable,*map(str,args)],capture_output=True,text=True,encoding="utf-8",errors="replace")
        (REV/(label+".log")).write_text(p.stdout+p.stderr,encoding="utf-8")
        results.append({"audit":label,"exit_code":p.returncode})
        return p.returncode
    check("evaluation-source-audit",[scripts/"validate_figure.py",Path(__file__),"--backend","python","--json"])
    for name in ("fig-injection-controls","fig-governance-timeline","fig-missions-controls"):
        pdf=OUT/(name+".pdf")
        check(name+".text-audit",[scripts/"audit_pdf_text.py",pdf,"--min-pt","9","--json"])
        check(name+".collision-audit",[scripts/"audit_figure_collisions.py",pdf,"--json-out",REV/(name+".collision.json"),"--overlay-pdf",REV/(name+".collision-overlay.pdf"),"--strict"])
    write_json("evaluation-qa-summary.json",results)
    if any(x["exit_code"]!=0 for x in results):
        raise SystemExit("QA requires repair: "+json.dumps(results))
    print(json.dumps(results,indent=2))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-root",type=Path,default=Path.home()/".codex/skills/nature-figure")
    parser.add_argument("--qa",action="store_true")
    args=parser.parse_args()
    injection(args.skill_root)
    timeline(args.skill_root)
    missions(args.skill_root)
    if args.qa:quality_audits(args.skill_root)
    print("Exported three PDF/SVG/600-dpi PNG figures; sources and alignment JSON in",REV)

if __name__=="__main__":
    main()
