"""Round-2 convergence fixes.

The verification panel found that one sentence introduced by the previous
revision was false, plus five other sentence-level defects. Every replacement
below is asserted, and the archive facts behind them were re-checked directly:

  20260918040908-1f4o  commit 7d4bfc0  04:09  51/2/2  guard fired -> 0.04 um
  20260918043504-bdo   commit 7d4bfc0  04:35  75/0/0  guard not entered
  20260918150159-gpc   commit 00679bb          75/0/0  attained 25.68 um
  20260918152858-1ar8  commit 48d09ac          73/2/0  guard fired -> -0.02 um

So the guard was present in the working tree before B (same recorded commit),
B itself never entered the branch, and three archives that did enter it all
failed to restore thickness.
"""
from __future__ import annotations

import pathlib
import re

TII = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = TII / "sections"


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def patch(text: str, old: str, new: str, tag: str) -> str:
    needle = squash(old)
    assert squash(text).count(needle) == 1, f"MISS/AMBIGUOUS: {tag}"
    pattern = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
    match = pattern.search(text)
    assert match, f"REGEX MISS: {tag}"
    return text[:match.start()] + new + text[match.end():]


ev = (SECTIONS / "evaluation.tex").read_text(encoding="utf-8")

# --- 1. The guard provenance sentence was false. The guard was already in the
#        working tree before B; B simply did not enter the branch, and every
#        archive that did enter it failed to restore thickness.
ev = patch(
    ev,
    r"A film-break guard that reapplies the recipe baseline was added to the mission after "
    r"archive $B$, which contains no such branch; the guard's trigger and its relation to the "
    r"rollback manager are not part of the evaluated revision. In a later run the guard fired "
    r"and the re-application did not restore thickness, so it detects and aborts rather than "
    r"recovers.",
    r"A film-break guard that reapplies the recipe baseline is present in the mission harness "
    r"but is not represented in archive $B$, which never entered that branch. Three other "
    r"archives did, one of them 26 minutes earlier at the same recorded commit, and in every "
    r"case the re-application failed to restore thickness, leaving final readings of $0.04$, "
    r"$-0.02$, and $-0.02\,\mu$m. The guard therefore aborts rather than recovers, and a "
    r"negative thickness indicates that the plant model, not only the governance layer, bounds "
    r"this result.",
    "guard provenance",
)

# --- 2. The failing archive's checks were warnings, not failures, and the
#        hard gate stayed green; name the two archives.
ev = patch(
    ev,
    r"two archives sharing one harness hash and one seed ended at $25.68\,\mu$m and at "
    r"$-0.02\,\mu$m, the second with two warnings and the mission check failed.",
    r"two archives sharing one harness hash and one seed, neither of them $B$, ended at "
    r"$25.68\,\mu$m and at $-0.02\,\mu$m; in the second, both mission checks are recorded as "
    r"warnings, no check failed, and the hard gate stayed green.",
    "verdict taxonomy",
)

# --- 3. "latest" is contradicted by the paper's own new caveat.
ev = patch(
    ev,
    r"Every measured result below comes from one archived run,",
    r"Every measured result in this section comes from one reference archived run,",
    "single-run scope",
)
ev = patch(
    ev,
    r"and is not part of the 75 checks above.",
    r"and is not part of the 75 checks of archive $B$.",
    "ablation scope",
)

# --- 4. The ablation paragraph mislabelled the probe classes and inverted its
#        own inference: four of the six probes are engineering-range class.
ev = patch(
    ev,
    r"With the full path, all six window-class attacks are rejected; with the interlock "
    r"disabled, or with the path ungated, four of six are rejected and the remaining two "
    r"execute at the driver while still being journaled; disabling readback alone changes "
    r"nothing in this arm. The batch-window interlock, not the engineering range, is therefore "
    r"the load-bearing governance check, and attribution records what happened without "
    r"preventing it.",
    r"With the full path, all six attacks are rejected. With the batch-window interlock "
    r"disabled, four are still rejected and the two recipe-window violations execute at the "
    r"driver; disabling readback alone changes nothing in this arm. The engineering range is "
    r"therefore structurally enforced and the batch-window check is the one that adds "
    r"protection, while attribution records what happened without preventing it. The same "
    r"archive carries boundary probes one tenth of a unit either side of the window edge, all "
    r"of which are rejected with no false block in any arm.",
    "ablation classes",
)

# --- 5. The superlative is true of defect rate and false of the objective it follows.
ev = patch(
    ev,
    r"Seed~44 degrades most in relative terms.",
    r"Seed~44 shows the largest relative rise in defect rate.",
    "seed superlative",
)

# --- 6. The paragraph now carries three observations, not two.
ev = patch(
    ev,
    r"Two failures observed outside archive $B$ bound the governance claim.",
    r"Three failures observed outside archive $B$ bound the governance claim.",
    "failure count",
)
ev = patch(
    ev,
    r"Second, the audit path fails open:",
    r"Third, the audit path fails open:",
    "failure enumeration",
)

# --- 7. The mission result must point at its own reproducibility caveat.
ev = patch(
    ev,
    r"that judgment is stored separately from execution and compensation, not that a judgment "
    r"was earned.",
    r"that judgment is stored separately from execution and compensation, not that a judgment "
    r"was earned. This attainment is one archived observation, and a later run of the same "
    r"command did not reproduce it.",
    "attainment frequency",
)

# --- 8. Contribution 3 still called the second scenario "independent".
intro = (SECTIONS / "introduction.tex").read_text(encoding="utf-8")
intro = patch(
    intro,
    r"and an independent film-line scenario rejects 9/9 hard-range probes with 0/3 false blocks.",
    r"and a second film-line scenario rejects 9/9 out-of-constraint probes with 0/3 false blocks.",
    "independent scenario",
)
(SECTIONS / "introduction.tex").write_text(intro, encoding="utf-8")

ev = patch(
    ev,
    r"Table~\ref{tab:plc} reports write latency and readback.",
    r"Table~\ref{tab:plc} reports write latency and readback; the OPC UA readback entry is a "
    r"single sample rather than a general claim of exactness.",
    "readback semantics",
)

(SECTIONS / "evaluation.tex").write_text(ev, encoding="utf-8")
print("evaluation.tex + introduction.tex: round-2 fixes applied")
