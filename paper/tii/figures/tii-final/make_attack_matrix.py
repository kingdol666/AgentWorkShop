"""Figure: which mechanism catches which attack class, across the four ablation arms.

The manuscript claims that the hard-range guard is structural while the batch-window
interlock is what prevents window-class violations.  This plate shows that directly: four of
the six attack classes are rejected in every arm, and only the two recipe-window classes
execute once the interlock is removed.
"""

from __future__ import annotations

import sys

import plate as P

ROWS = P.ATTACK_KINDS
ARM_LABELS = ["Full", "No\ninterlock", "No\nreadback", "Both\ndisabled"]
ARMS = ["full", "no-interlock", "no-readback", "ungated"]
PER_ARM = 3          # three repetitions x one probe per class per repetition


def main() -> int:
    # harvested from the archive rather than transcribed
    rows = P.ablation_rows()
    executed: dict[tuple[str, str], int] = {}
    for kind, _ in ROWS:
        for arm in ARMS:
            n = sum(1 for r in rows
                    if r["case"] == "attack" and r["kind"] == kind and r["arm"] == arm
                    and r["verdict"] == "EXECUTED")
            executed[(kind, arm)] = n

    W, H = 470.0, 300.0
    c = P.Canvas(W, H)
    U = c.U
    M = 5.0 * U
    LEFT, RIGHT = M, c.w - M

    # ---- title: the baseline sits clear of the canvas top ------------------------------
    c.text(LEFT, 12.0 * U, "Which mechanism catches which attack class", size=P.T_TITLE,
           weight="bold")
    c.text(LEFT, 21.4 * U,
           "out-of-constraint probes executed, per class and per ablation arm "
           "(3 probes per cell)",
           size=P.T_SUB, fill=P.GREY, style="italic")

    # ---- geometry ---------------------------------------------------------------------
    label_w = 92.0 * U
    grid_x0 = LEFT + label_w
    grid_x1 = RIGHT
    colw = (grid_x1 - grid_x0) / len(ARMS)

    top = 29.0 * U
    # column headers: two lines, 9.4 pt apart so their ink boxes clear
    for i, lbl in enumerate(ARM_LABELS):
        cx = grid_x0 + colw * (i + 0.5)
        for k, part in enumerate(lbl.split("\n")):
            c.text(cx, top + (3.0 + k * 9.4) * U, part, size=P.T_KEY, anchor="middle",
                   weight="bold" if k == 0 else "normal",
                   fill=P.INK if k == 0 else P.GREY)

    grid_top = top + 15.0 * U
    rowh = 20.5 * U
    grid_bot = grid_top + rowh * len(ROWS)

    # ---- column separators and cell cells ---------------------------------------------
    for i in range(len(ARMS) + 1):
        x = grid_x0 + colw * i
        c.line(x, grid_top - 2.0 * U, x, grid_bot, stroke=P.RULE, sw=0.7)
    c.line(grid_x0, grid_top - 2.0 * U, grid_x1, grid_top - 2.0 * U, stroke=P.INK, sw=0.9)

    # ---- one row per attack class -----------------------------------------------------
    for r, (kind, label) in enumerate(ROWS):
        y0 = grid_top + rowh * r
        cy = y0 + rowh / 2
        parts = label.split("\n")
        for k, part in enumerate(parts):
            c.text(grid_x0 - 6.0 * U, cy - 4.4 * U + k * 9.4 * U, part, size=P.T_KEY,
                   anchor="end", fill=P.GREY if k else P.INK,
                   weight="normal" if k else "bold")
        # three probe slots per cell, drawn as a small tick each
        for i, arm in enumerate(ARMS):
            cx = grid_x0 + colw * (i + 0.5)
            n_exec = executed[(kind, arm)]
            slot = 4.6 * U
            span = slot * PER_ARM
            x = cx - span / 2
            for s in range(PER_ARM):
                filled = s < n_exec
                c.rect(x + s * slot + 0.4 * U, cy - 3.6 * U, slot - 0.8 * U, 7.2 * U,
                       fill=P.WARM if filled else P.WASH_T,
                       stroke=P.WARM if filled else P.TONE, sw=0.85)
            if n_exec:
                c.text(cx, cy + 11.0 * U, f"{n_exec}/{PER_ARM}", size=P.T_NOTE,
                       anchor="middle", fill=P.WARM, weight="bold")
        c.line(grid_x0, y0, grid_x1, y0, stroke=P.RULE, sw=0.5, dash="2 3")

    # bottom rule, then the class grouping brace
    c.line(grid_x0, grid_bot, grid_x1, grid_bot, stroke=P.INK, sw=0.9)

    # ---- grouping: hard-range classes vs window classes -------------------------------
    def brace(y_top, y_bot, x, depth=3.4 * U):
        c.path(f"M {x:.1f} {y_top:.1f} h {-depth:.1f} V {y_bot:.1f} h {depth:.1f}",
               stroke=P.INK, sw=0.8)

    brace(grid_top, grid_top + rowh * 4, LEFT + 3.4 * U)
    brace(grid_top + rowh * 4, grid_top + rowh * 6, LEFT + 3.4 * U)
    c.text(LEFT + 5.4 * U, grid_top + rowh * 2 - 1.0 * U, "hard", size=P.T_NOTE,
           fill=P.GREY, style="italic")
    c.text(LEFT + 5.4 * U, grid_top + rowh * 2 + 8.4 * U, "range", size=P.T_NOTE,
           fill=P.GREY, style="italic")
    c.text(LEFT + 5.4 * U, grid_top + rowh * 5 + 2.2 * U, "window", size=P.T_NOTE,
           fill=P.GREY, style="italic")

    # ---- legend -----------------------------------------------------------------------
    ly = grid_bot + 8.0 * U
    c.rect(LEFT + 5.0 * U, ly - 3.4 * U, 4.6 * U, 7.2 * U, fill=P.WASH_T, stroke=P.TONE,
           sw=0.85)
    c.text(LEFT + 12.0 * U, ly + 1.4 * U, "rejected at admission", size=P.T_NOTE,
           fill=P.GREY)
    x2 = LEFT + 110.0 * U
    c.rect(x2, ly - 3.4 * U, 4.6 * U, 7.2 * U, fill=P.WARM, stroke=P.WARM, sw=0.85)
    c.text(x2 + 7.0 * U, ly + 1.4 * U, "executed and journaled", size=P.T_NOTE,
           fill=P.GREY)

    # ---- the finding ------------------------------------------------------------------
    fy = ly + 14.0 * U
    c.text(LEFT, fy,
           "Four of six attack classes are rejected in every arm: the hard-range",
           size=P.T_BODY, fill=P.INK)
    c.text(LEFT, fy + P.L_BODY * U,
           "guard is structural. Only the two recipe-window classes execute, and",
           size=P.T_BODY, fill=P.INK)
    c.text(LEFT, fy + 2 * P.L_BODY * U,
           "only when the window interlock is bypassed.",
           size=P.T_BODY, fill=P.INK)

    facts = P.build("fig-attack-matrix", c, scale_in_latex=1.0,
                    title="Attack class versus ablation arm",
                    note="executed probes per class per arm, three probes per cell")
    ok, bad = P.qa("fig-attack-matrix")
    return P.report("fig-attack-matrix", ok=ok, bad=bad)


if __name__ == "__main__":
    raise SystemExit(main())
