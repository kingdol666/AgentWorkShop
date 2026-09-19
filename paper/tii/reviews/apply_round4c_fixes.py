"""Round-4c: the last of the round-3 verification items."""
import pathlib
import re


def patch(path, pairs):
    t = path.read_text(encoding="utf-8")
    for old, new, tag in pairs:
        flat = re.sub(r"\s+", " ", t)
        needle = re.sub(r"\s+", " ", old).strip()
        assert flat.count(needle) == 1, "MISS/AMBIG: " + tag
        pat = re.compile(r"\s+".join(re.escape(w) for w in needle.split(" ")))
        m = pat.search(t)
        assert m, "REGEX " + tag
        t = t[:m.start()] + new + t[m.end():]
    path.write_text(t, encoding="utf-8")
    print("patched", path.name)


root = pathlib.Path(__file__).resolve().parent.parent

patch(root / "sections" / "evaluation.tex", [
    ("Closed-loop benchmark and scenario reuse & P6",
     "Closed-loop evaluation and scenario reuse & P6", "layer noun"),
    (r"harness hash \texttt{00e7dc827f4a2cea}",
     r"hash \texttt{00e7dc827f4a2cea} over the harness modules", "fingerprint"),
    ("Four caveats keep this short of full reproducibility.",
     "Five caveats keep this short of full reproducibility.", "caveat count"),
    ("A fifth caveat concerns the mission layer.",
     "The last caveat concerns the mission layer.", "caveat ordinal"),
    ("This attainment is one archived observation, and a later run of the same command did not "
     "reproduce it.",
     "Across the ten archived seed-42 missions that report a final thickness, seven reached the "
     "band and three collapsed into the break regime, and the run reported here is one of the "
     "seven.", "success rate"),
    ("the layer was added late in development and is absent from Section~\\ref{sec:mech}.",
     "the layer is described in Section~\\ref{sec:paramlayer}.", "layer crossref"),
    ("Every measured result in this section comes from one reference archived run,",
     "Except where an archive is named, the results in this section come from one reference "
     "archived run,", "single-run scope"),
])

patch(root / "sections" / "introduction.tex", [
    ("its six mechanisms and the cross-cutting", "its seven mechanisms and the cross-cutting",
     "intro count")])

patch(root / "sections" / "discussion.tex", [
    ("None of the six mechanisms is enforced", "None of these mechanisms is enforced",
     "disc count"),
    ("The latest run provides three", "Reference archive $B$ provides three",
     "conclusion latest")])

patch(root / "sections" / "mechanisms.tex", [
    ("A write through this surface is bounded by the intersection of those four intervals,",
     "A write through this surface is bounded by the intersection of node range, baseline "
     "interval, product interval and recipe window,", "four intervals")])
