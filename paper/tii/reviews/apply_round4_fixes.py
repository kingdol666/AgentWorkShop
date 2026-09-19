"""Round-4 fixes: the defects R3's third-round verification found, most of which
the previous revision introduced.

The decisive one is a rendering bug: the cross-reference added to scope Fig. 6 was
written with a doubled backslash, so the published PDF prints "Section
refsec:writepath" instead of "Section IV-C".
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

# 1. The broken cross-reference.
ev = patch(
    ev,
    r"Section refsec:writepath sets out the recipe-application",
    r"Section~\ref{sec:writepath} sets out the recipe-application",
    "broken ref",
)
ev = patch(
    ev,
    r"(Section refsec:writepath gives the paths that bypass the window branch)",
    r"(Section~\ref{sec:writepath} gives the paths that bypass the window branch)",
    "broken ref alt",
)

# 2. The layer is now described in Section IV, so the old sentence contradicts it.
ev = patch(
    ev,
    r"the layer was added late in development and is absent from Section~\ref{sec:mech}.",
    r"the layer is described in Section~\ref{sec:paramlayer}.",
    "layer crossref",
)

# 3. The ablation has four arms; the previous text reported three.
ev = patch(
    ev,
    r"A frozen four-arm ablation on the same API surface, archived separately in the repository, "
    r"shows what the write path contributes.",
    r"A frozen four-arm ablation on the same API surface, archived separately in the repository "
    r"(arms: full, no interlock, no readback, ungated), shows what the write path contributes.",
    "ablation arms",
)
ev = patch(
    ev,
    r"With the batch-window interlock disabled, four are still rejected and the two "
    r"recipe-window violations execute at the driver; disabling readback alone changes nothing "
    r"in this arm.",
    r"With the batch-window interlock disabled, or with the path ungated, four are still "
    r"rejected and the two recipe-window violations execute at the driver; disabling readback "
    r"alone changes nothing.",
    "ablation arms result",
)

# 4. The universal in V-A excludes the ablation, which is a separate archive.
ev = patch(
    ev,
    r"Every measured result in this section comes from one reference archived run,",
    r"Except where an archive is named, the results in this section come from one reference "
    r"archived run,",
    "single-run scope",
)

# 5. Four caveats are listed, then a fifth; make the count consistent.
ev = patch(
    ev,
    r"Four caveats keep this short of full reproducibility.",
    r"Five caveats keep this short of full reproducibility.",
    "caveat count",
)
ev = patch(
    ev,
    r"A fifth caveat concerns the mission layer.",
    r"The last caveat concerns the mission layer.",
    "caveat ordinal",
)

# 6. The mission checks record outcomes, not admission or readback.
ev = patch(
    ev,
    r"Every write cleared the gate shown in the figure (checks \texttt{biax-mission-multinode} "
    r"and \texttt{biax-mission-attained}), was accepted by its driver,",
    r"Every write cleared the gate shown in the figure, was accepted by its driver,",
    "mission check citation",
)

(SECTIONS / "evaluation.tex").write_text(ev, encoding="utf-8")

# 7. One mechanism count everywhere.
intro = (SECTIONS / "introduction.tex").read_text(encoding="utf-8")
intro = patch(intro, r"its six mechanisms and the cross-cutting", r"its seven mechanisms and the cross-cutting",
              "intro count")
(SECTIONS / "introduction.tex").write_text(intro, encoding="utf-8")

disc = (SECTIONS / "discussion.tex").read_text(encoding="utf-8")
disc = patch(disc, r"None of the six mechanisms is enforced outside the platform process,",
             r"None of these mechanisms is enforced outside the platform process,", "disc count")
(SECTIONS / "discussion.tex").write_text(disc, encoding="utf-8")

# 8. The four intervals must all be named.
mech = (SECTIONS / "mechanisms.tex").read_text(encoding="utf-8")
mech = patch(
    mech,
    r"A write through this surface is bounded by the intersection of those four intervals,",
    r"A write through this surface is bounded by the intersection of node range, baseline "
    r"interval, product interval and recipe window,",
    "four intervals",
)
(SECTIONS / "mechanisms.tex").write_text(mech, encoding="utf-8")

print("round-4 fixes applied")
