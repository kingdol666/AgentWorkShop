"""Round-3 evaluation.tex fixes (R3 items iii/v, adversarial item A3)."""
import pathlib
import re

p = pathlib.Path(__file__).resolve().parent.parent / "sections" / "evaluation.tex"
t = p.read_text(encoding="utf-8")


def patch(text, old, new, tag):
    flat = re.sub(r"\s+", " ", text)
    needle = re.sub(r"\s+", " ", old).strip()
    assert flat.count(needle) == 1, "MISS/AMBIG: " + tag
    pat = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    m = pat.search(text)
    assert m, "REGEX " + tag
    return text[:m.start()] + new + text[m.end():]


t = patch(t, r"\section{Benchmark Evaluation}", r"\section{Integrated Evaluation}",
          "section title")

t = patch(t, "Integrated benchmark results in archive $B$",
          "Integrated evaluation results in archive $B$", "table caption")

t = patch(t, "Closed-loop benchmark and portability & P6, P8, P8b & 9 & 22/22 &",
          "Closed-loop benchmark and scenario reuse & P6, P8, P8b & 9 & 22/22 &",
          "layer name")

t = patch(
    t,
    "Each writable stack rejects four engineering-range and two recipe-window",
    "The checks behind these numbers are the per-line integration checks "
    "\\texttt{line-$n$-io} in phase P3 and \\texttt{port-$n$-*} in phase P8. "
    "Each writable stack rejects four engineering-range and two recipe-window",
    "check ids protocol",
)

t = patch(
    t,
    "Every write cleared the gate shown in the figure,",
    "Every write cleared the gate shown in the figure (checks "
    "\\texttt{biax-mission-multinode} and \\texttt{biax-mission-attained}),",
    "check ids mission",
)

t = patch(
    t,
    r"The objective, control law, and reference $J^{*}$ come from the harness and the "
    r"separately maintained simulator, not from the run.",
    r"The objective, control law, and reference $J^{*}$ come from the harness and the "
    r"separately maintained simulator, not from the run. Two features of that scoring bound "
    r"the ratio. Its throughput and energy terms are evaluated from the setpoints the "
    r"controller issued rather than from measured values, because the twin returns no "
    r"independent reading for them; and the control law inverts the model's own relation "
    r"$h\propto N/v$, so the plateau is structural. The suite's gate is $J/J^{*}\geq0.8$, so "
    r"the reported value is not near a threshold.",
    "circularity residuals",
)

p.write_text(t, encoding="utf-8")
print("evaluation.tex: round-3 fixes applied")
