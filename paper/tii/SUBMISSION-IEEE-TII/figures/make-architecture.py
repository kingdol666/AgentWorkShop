# -*- coding: utf-8 -*-
"""Architecture figure for the TII paper — one model, two renderers.

Emits:
  1. fig1-architecture.excalidraw  (editable Excalidraw source)
  2. ../resources/fig1-architecture-excalidraw.pdf (clean vector for LaTeX)

Content mirrors sections III/IV: five planes, governed write path, shared
stores, external surfaces. Run: python make-architecture.py
"""
import json
import os
import random

OUT = os.path.dirname(os.path.abspath(__file__))
BLUE, ORANGE, GREEN, PURPLE, GREY, DARK = "#0072B2", "#E69F00", "#009E73", "#7B5EA7", "#7F7F7F", "#333333"

# ---------------- model ----------------
nodes = [
    dict(id="ops", kind="box", label="Operator interfaces", sub="workshop UI · REST API", x=300, y=20, w=400, h=48, color=PURPLE),
    dict(id="team", kind="plane", label="Team plane", sub="members · channels · tasks\nepisodic memory (hybrid search)", x=40, y=150, w=280, h=140, color=BLUE),
    dict(id="gov", kind="plane", label="Governance plane", sub="admission → approval → dispatch\n3-level ACK → 3-way consistency\nverdict · compensation · backstop", x=360, y=150, w=280, h=140, color=ORANGE),
    dict(id="integ", kind="plane", label="Integration plane", sub="DAQ nodes (4 modalities)\nDCW nodes · drivers · readback", x=680, y=150, w=280, h=140, color=GREEN),
    dict(id="oper", kind="plane", label="Operations plane", sub="line · product · recipe · run\nversioned production objects", x=360, y=310, w=280, h=80, color=PURPLE),
    dict(id="ext", kind="plane", label="Extensibility plane", sub="plugins · drivers · agent tools\nSDK · sanctioned registration", x=680, y=310, w=280, h=80, color=GREY),
    dict(id="eng", kind="external", label="Agent engines", sub="14 adapters — replaceable strategy slot", x=40, y=505, w=280, h=56, color=GREY),
    dict(id="plant", kind="external", label="Plant", sub="PLC · MQTT · Modbus · OPC UA · HTTP · MES", x=700, y=505, w=280, h=56, color=DARK),
    dict(id="sqlite", kind="store", label="SQLite", sub="", x=240, y=405, w=140, h=48, color=BLUE),
    dict(id="tsdb", kind="store", label="TSDB", sub="", x=420, y=405, w=140, h=48, color=BLUE),
    dict(id="obj", kind="store", label="Object store", sub="", x=600, y=405, w=140, h=48, color=BLUE),
]
edges = [
    dict(id="e1", f="ops", t="container", label="", style="data"),
    dict(id="e2", f="eng", t="team", label="engine adapter", style="ext"),
    dict(id="e3", f="team", t="gov", label="governed write request", style="gov"),
    dict(id="e4", f="gov", t="integ", label="graded dispatch", style="gov"),
    dict(id="e5", f="integ", t="plant", label="semantic writes", style="gov"),
    dict(id="e6", f="oper", t="gov", label="admitting window", style="data"),
    dict(id="e7", f="ext", t="integ", label="sanctioned registration", style="ext"),
]
random.seed(7)
for n in nodes:
    n["seed"] = random.randint(1, 2**31 - 1)

# ---------------- excalidraw serializer ----------------
def ex_rect(n):
    bg = {"plane": "#F2F5F9", "box": "#FBF6EC", "store": "#EFF7F3", "external": "#F7F7F7"}[n["kind"]]
    return {"id": n["id"], "type": "rectangle", "x": n["x"], "y": n["y"],
            "width": n["w"], "height": n["h"], "angle": 0, "strokeColor": n["color"],
            "backgroundColor": bg, "fillStyle": "solid",
            "strokeWidth": 2 if n["kind"] == "external" else 1, "roughness": 1,
            "opacity": 100, "seed": n["seed"], "versionNonce": n["seed"],
            "isDeleted": False, "groupIds": [], "boundElements": None,
            "updated": 1, "link": None, "locked": False}

def ex_text(nid, x, y, lines, size, color):
    return {"id": nid, "type": "text", "x": x, "y": y, "width": 240,
            "height": size * 1.25 * len(lines), "angle": 0, "strokeColor": color,
            "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 1,
            "roughness": 1, "opacity": 100, "seed": 2, "versionNonce": 2,
            "isDeleted": False, "groupIds": [], "boundElements": None, "updated": 1,
            "link": None, "locked": False, "text": "\n".join(lines), "fontSize": size,
            "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle",
            "containerId": None}

elements = []
for n in nodes:
    elements.append(ex_rect(n))
    cx, lab = n["x"] + n["w"] / 2 - 120, DARK
    if n["kind"] == "store":
        elements.append(ex_text(n["id"] + "-t", cx, n["y"] + n["h"] / 2 - 10, [n["label"]], 16, lab))
    else:
        elements.append(ex_text(n["id"] + "-t", cx, n["y"] + 10, [n["label"]], 18, lab))
        if n.get("sub"):
            elements.append(ex_text(n["id"] + "-s", cx, n["y"] + 34, n["sub"].split("\n"), 12, "#555555"))
def route(e):
    a = next(n for n in nodes if n["id"] == e["f"])
    b = next((n for n in nodes if n["id"] == e["t"]), None)
    if e["f"] == "ops":
        return (500, 68), (500, 110)
    if e["f"] == "eng":
        return (165, 505), (165, 292)
    if e["f"] == "integ" and e["t"] == "plant":
        return (960, 220), (980, 533)
    if e["t"] == "gov" and e["f"] == "oper":
        return (a["x"] + 140, a["y"]), (b["x"] + 90, b["y"] + b["h"])
    if e["f"] == "ext":
        return (a["x"] + 140, a["y"]), (b["x"] + 140, b["y"] + b["h"])
    return (a["x"] + a["w"], a["y"] + a["h"] / 2), (b["x"], b["y"] + b["h"] / 2)
for e in edges:
    (x0, y0), (x1, y1) = route(e)
    color = {"gov": ORANGE, "data": GREY, "ext": GREY}[e["style"]]
    elements.append({"id": e["id"], "type": "arrow", "x": x0, "y": y0,
                     "width": abs(x1 - x0), "height": abs(y1 - y0), "angle": 0,
                     "strokeColor": color, "backgroundColor": "transparent",
                     "fillStyle": "solid", "strokeWidth": 3 if e["style"] == "gov" else 1,
                     "roughness": 1, "opacity": 100, "seed": 4, "versionNonce": 4,
                     "isDeleted": False, "groupIds": [], "boundElements": None,
                     "updated": 1, "link": None, "locked": False,
                     "points": [[0, 0], [x1 - x0, y1 - y0]],
                     "startBinding": None, "endBinding": None,
                     "startArrowhead": None, "endArrowhead": "arrow"})
    if e["label"]:
        mx, my = (x0 + x1) / 2 - 90, (y0 + y1) / 2 - 8
        elements.append(ex_text(e["id"] + "-l", mx, my, [e["label"]], 11,
                                "#7a5a1a" if e["style"] == "gov" else "#666666"))
elements.append(ex_text("stores-cap", 320, 460, ["shared persistent stores — identifiers shared, transaction domain not assumed"], 12, "#666666"))
elements.append(ex_text("title", 270, 580, ["AgentWorkShop — governed supervisory execution architecture"], 16, "#33455e"))
doc = {"type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
       "elements": elements, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20}, "files": {}}
with open(os.path.join(OUT, "fig1-architecture.excalidraw"), "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False)
print("excalidraw written:", len(elements), "elements")

# ---------------- matplotlib renderer (same model) ----------------
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({"font.family": "serif",
                     "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
                     "pdf.fonttype": 42})
fig, ax = plt.subplots(figsize=(7.16, 4.45))
ax.set_xlim(-8, 1008)
ax.set_ylim(600, -12)
ax.axis("off")

ax.add_patch(plt.Rectangle((20, 110), 960, 360, facecolor="#FAFBFD",
                           edgecolor="#C5CEDB", linewidth=0.8, linestyle=(0, (4, 3)), zorder=1))
ax.text(34, 126, "AgentWorkShop platform", fontsize=7.6, color="#33455e", style="italic", va="top", zorder=2)

for n in nodes:
    fc = {"plane": "#F2F5F9", "box": "#FBF6EC", "store": "#EFF7F3", "external": "#F7F7F7"}[n["kind"]]
    ls = (0, (3, 2)) if n["kind"] == "external" else "-"
    lw = 1.0 if n["kind"] == "external" else 1.3
    ax.add_patch(plt.Rectangle((n["x"], n["y"]), n["w"], n["h"], facecolor=fc,
                               edgecolor=n["color"], linewidth=lw, linestyle=ls, zorder=3))
    if n["kind"] == "store":
        ax.text(n["x"] + n["w"] / 2, n["y"] + n["h"] / 2, n["label"], ha="center",
                va="center", fontsize=8.2, color=DARK, zorder=4)
    else:
        ax.text(n["x"] + n["w"] / 2, n["y"] + 16, n["label"], ha="center", va="center",
                fontsize=8.8, color=DARK, fontweight="bold", zorder=4)
        if n.get("sub"):
            ax.text(n["x"] + n["w"] / 2, n["y"] + 30, n["sub"], ha="center", va="top",
                    fontsize=6.9, color="#555555", linespacing=1.35, zorder=4)

for e in edges:
    (x0, y0), (x1, y1) = route(e)
    color = {"gov": ORANGE, "data": "#8A8A8A", "ext": "#9A9A9A"}[e["style"]]
    lw = 1.7 if e["style"] == "gov" else 0.8
    ls = (0, (3, 2)) if e["style"] == "ext" else "-"
    if e["f"] == "integ" and e["t"] == "plant":
        ax.plot([x0, 992, 992], [y0, y0, y1], color=color, lw=lw, ls=ls, zorder=2, solid_capstyle="round")
        ax.annotate("", xy=(x1, y1), xytext=(992, y1), zorder=2,
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=lw, mutation_scale=11))
        mid = ((x0 + 1), (y0 + y1) / 2)
    elif e["f"] == "eng":
        ax.plot([x0, x1], [y0, 460], color=color, lw=lw, ls=ls, zorder=2, solid_capstyle="round")
        ax.plot([x1, x1], [460, 292], color=color, lw=lw, ls=ls, zorder=2, solid_capstyle="round")
        ax.annotate("", xy=(180, 292), xytext=(165, 340), zorder=2,
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=lw, mutation_scale=11))
        mid = (188, 470)
    else:
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0), zorder=2,
                    arrowprops=dict(arrowstyle="-|>", color=color, lw=lw, linestyle=ls,
                                    shrinkA=2, shrinkB=2, mutation_scale=11))
        mid = ((x0 + x1) / 2, (y0 + y1) / 2)
    if e["label"]:
        c = "#7a5a1a" if e["style"] == "gov" else "#666666"
        if e["f"] == "team":
            mid = (350, 252)
        elif e["f"] == "gov" and e["t"] == "integ":
            mid = (670, 252)
        elif e["f"] == "oper":
            mid = (500, 300)
        elif e["f"] == "ext":
            mid = (860, 300)
        elif e["f"] == "eng":
            mid = (230, 478)
        elif e["f"] == "integ" and e["t"] == "plant":
            mid = (858, 487)
        ax.text(mid[0], mid[1], e["label"], ha="center", va="center",
                fontsize=6.8 if e["style"] == "gov" else 6.3, color=c,
                style="italic" if e["style"] == "gov" else "normal", zorder=5,
                bbox=dict(facecolor="white", edgecolor="none", pad=0.6, alpha=0.85))

ax.text(858, 415, "shared persistent stores —\nidentifiers shared, transaction\ndomain not assumed", ha="center", va="top", fontsize=6.5, color="#666666", style="italic", zorder=4, linespacing=1.4)
fig.tight_layout(pad=0.2)
fig.savefig(os.path.join(OUT, "..", "resources", "fig1-architecture-excalidraw.pdf"),
            bbox_inches="tight", pad_inches=0.02)
fig.savefig(os.path.join(OUT, "chk-arch.png"), dpi=200)
plt.close(fig)
print("pdf rendered")
