"""Round-4b: the remaining items both round-3 seats listed as text-only.

Verified directly before writing:
  * seed-42 integrated missions reporting a final thickness: 10
    attained 7 (25.26, 25.32, 25.34, 25.40, 25.68, 25.68, 25.68)
    collapsed 3 (0.02, -0.02, -0.02)
  * ablation archive: bench/baselines/20260914-baseline/run-e1lite-4arm
    seed 42, 3 repetitions, commit d6c824d, config hash 3a57e722d4764b98
  * the harness hash covers pipeline.mjs plus eight lib/ modules
"""
import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"


def patch(text, old, new, tag):
    flat = re.sub(r"\s+", " ", text)
    needle = re.sub(r"\s+", " ", old).strip()
    assert flat.count(needle) == 1, "MISS/AMBIG: " + tag
    pat = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    m = pat.search(text)
    assert m, "REGEX " + tag
    return text[:m.start()] + new + text[m.end():]


ev = (SECTIONS / "evaluation.tex").read_text(encoding="utf-8")

# The ablation archive identified by its content, not by a repository path.
ev = patch(
    ev,
    r"A frozen four-arm ablation on the same API surface, archived separately in the repository "
    r"(arms: full, no interlock, no readback, ungated), shows what the write path contributes.",
    r"A frozen four-arm ablation, archived separately (seed 42, three repetitions, commit "
    r"\texttt{d6c824d}), shows what the write path contributes; its arms are full, no interlock, "
    r"no readback, and ungated.",
    "ablation identity",
)

# Mission attainment rate across the archived seed-42 missions.
ev = patch(
    ev,
    r"This attainment is one archived observation, and a later run of the same command did not "
    r"reproduce it.",
    r"Across the ten archived seed-42 missions that report a final thickness, seven reached the "
    r"band and three collapsed into the break regime, and the run reported here is one of the "
    r"seven.",
    "attainment rate",
)

# The hash covers the harness modules, not only the checkers.
ev = patch(
    ev,
    r"harness hash \texttt{00e7dc827f4a2cea}",
    r"hash \texttt{00e7dc827f4a2cea} over the harness modules",
    "fingerprint wording",
)

# Section and table were renamed; the layer label keeps the old noun.
ev = patch(
    ev,
    r"Closed-loop benchmark and scenario reuse & P6, P8, P8b & 9 & 22/22 &",
    r"Closed-loop evaluation and scenario reuse & P6, P8, P8b & 9 & 22/22 &",
    "layer noun",
)

(SECTIONS / "evaluation.tex").write_text(ev, encoding="utf-8")

# The conclusion still called archive B "the latest".
disc = (SECTIONS / "discussion.tex").read_text(encoding="utf-8")
disc = patch(disc, r"The latest run provides", r"Reference archive $B$ provides", "conclusion latest")
(SECTIONS / "discussion.tex").write_text(disc, encoding="utf-8")

print("round-4b fixes applied")
