#!/usr/bin/env python
"""Measure rendered text widths so card copy can be fit to its card exactly."""
import os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

# label -> (text, font-size, weight, family)
CAND = {
    # group A cards: card 248 wide, text starts at x+20 -> 208 px available
    "A1t":  ("Harness registry", 16, 700, "sans"),
    "A2t":  ("Lead scheduler + tasks", 16, 700, "sans"),
    "A3t":  ("Typed memory", 16, 700, "sans"),
    "A4t":  ("Teams, channels, SDK", 16, 700, "sans"),
    "A1s":  ("14 engines &#183; capability matrix", 12, 400, "sans"),
    "A2s":  ("7-state tasks &#183; rule fallback", 12, 400, "sans"),
    "A3s":  ("FTS5-CJK + vector, RRF + MMR", 12, 400, "sans"),
    "A4s":  ("operator and developer surfaces", 12, 400, "sans"),
    # group B: card 228 wide -> 188 px available
    "B1t":  ("Semantic cards", 16, 700, "sans"),
    "B2t":  ("Governed tool surface", 16, 700, "sans"),
    "B3t":  ("HITL approval gate", 16, 700, "sans"),
    "B4t":  ("Rollback backstop", 16, 700, "sans"),
    "B1s":  ("unit, range, recipe window", 12, 400, "sans"),
    "B2m":  ("dcw_control", 12, 400, "mono"),
    "B2s":  (" &#8212; sole write path", 12, 400, "sans"),
    "B3s":  ("manual / auto / unbound", 12, 400, "sans"),
    "B4s":  ("breach count, bounded recovery", 12, 400, "sans"),
    # group C: card 248 wide -> 208 px available
    "C1t":  ("Protocol drivers", 16, 700, "sans"),
    "C2t":  ("Per-node edge runtimes", 16, 700, "sans"),
    "C3t":  ("Alarm chain", 16, 700, "sans"),
    "C4t":  ("Time-series store", 16, 700, "sans"),
    "C1s":  ("Modbus, OPC UA, MQTT, HTTP", 12, 400, "sans"),
    "C2s":  ("quota 64 per 250 ms, 3 rates", 12, 400, "sans"),
    "C3s":  ("warn band, 2 % hysteresis", 12, 400, "sans"),
    "C4s":  ("TimescaleDB, MinIO, fallback", 12, 400, "sans"),
    # group headers (band width = group width)
    "GAh":  ("AGENT HALF", 15, 700, "sans"),
    "GBh":  ("GOVERNED BRIDGE", 15, 700, "sans"),
    "GCh":  ("INDUSTRIAL HALF", 15, 700, "sans"),
    # plane lines
    "Pl":   ("Interoperability plane&#160;&#160;|&#160;&#160;WebSocket AEP v1 (resumable sequence)"
             "&#160;&#160;&#183;&#160;&#160;MCP server (25 tools)"
             "&#160;&#160;&#183;&#160;&#160;A2A agent card + JSON-RPC"
             "&#160;&#160;&#183;&#160;&#160;208 REST route files", 15.4, 400, "sans"),
    "Au1":  ("Shared audit plane&#160;&#160;|&#160;&#160;audit_log (actor, actor kind "
             "user/agent/system, target, 8 event kinds)&#160;&#160;&#183;&#160;&#160;recipe log + "
             "version history&#160;&#160;&#183;&#160;&#160;signed write-journal anchors", 15.4, 400, "sans"),
    "Au2":  ("Every write, alarm, recipe change and rollback is attributed here; agent actions "
             "carry their channel and member badge", 13, 400, "sans"),
    "Plc1": ("PLC / physical plant", 16.4, 700, "sans"),
    "Plc2": ("hard real-time control + safety functions", 13, 400, "sans"),
}

AVAIL = {"A": 208, "B": 188, "C": 208, "G": 268, "P": 1140, "Plc": 300}


def main():
    rows = []
    for k, (txt, size, wt, fam) in CAND.items():
        f = "Liberation Mono" if fam == "mono" else "Liberation Sans"
        rows.append(f'<text id="{k}" x="20" y="60" font-family="{f}" font-size="{size}" '
                    f'font-weight="{wt}" fill="#000">{txt}</text>')
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="120">'
           '<rect width="1600" height="120" fill="#fff"/>' + "".join(rows) + "</svg>")
    p = os.path.join(HERE, "_measure.html")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write('<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>' + svg)
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 120})
        pg.goto("file:///" + p.replace("\\", "/"))
        out = pg.evaluate("() => { const r={}; for (const t of document.querySelectorAll('text')) "
                          "r[t.id]=Math.round(t.getBBox().width*10)/10; return r; }")
        b.close()
    os.remove(p)

    print(f"{'key':6s} {'width':>7s} {'avail':>6s}  fit")
    bad = []
    for k in CAND:
        w = out[k]
        grp = ("A" if k.startswith(("A1","A2","A3","A4")) else
               "B" if k.startswith("B") else
               "C" if k.startswith("C") else
               "P" if k in ("Pl", "Au1", "Au2") else "G")
        av = AVAIL[grp]
        ok = w <= av
        print(f"{k:6s} {w:7.1f} {av:6d}  {'ok' if ok else 'OVERFLOW by %.1f' % (w-av)}")
        if not ok:
            bad.append(k)
    print()
    print("ALL FIT" if not bad else f"{len(bad)} need shortening: {bad}")


if __name__ == "__main__":
    main()
