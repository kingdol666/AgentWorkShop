"""Final trims to restore the page budget after the round-2 disclosure fixes."""
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
    assert m, "REGEX MISS " + tag
    return text[:m.start()] + new + text[m.end():]


t = patch(
    t,
    r"A film-break guard that reapplies the recipe baseline is present in the mission harness "
    r"but is not represented in archive $B$, which never entered that branch. Three other "
    r"archives did, one of them 26 minutes earlier at the same recorded commit, and in every "
    r"case the re-application failed to restore thickness, leaving final readings of $0.04$, "
    r"$-0.02$, and $-0.02\,\mu$m. The guard therefore aborts rather than recovers, and a "
    r"negative thickness indicates that the plant model, not only the governance layer, bounds "
    r"this result.",
    r"A film-break guard that reapplies the recipe baseline is present in the mission harness "
    r"but not represented in archive $B$, which never entered that branch. Three other archives "
    r"did, one 26 minutes earlier at the same recorded commit; in each the re-application failed "
    r"to restore thickness, leaving $0.04$, $-0.02$, and $-0.02\,\mu$m. A negative thickness "
    r"indicates that the plant model, not only the governance layer, bounds this result.",
    "guard sentence",
)

t = patch(
    t,
    r"objective, the four admission checks a governed agent write clears before a driver is "
    r"invoked (Section~\ref{sec:writepath} sets out the recipe-application and heartbeat paths "
    r"that bypass the window branch), and the three steps the run recorded.",
    r"objective, the four admission checks a governed agent write clears before a driver is "
    r"invoked (Section~\ref{sec:writepath} gives the paths that bypass the window branch), and "
    r"the three steps the run recorded.",
    "caption trim",
)

p.write_text(t, encoding="utf-8")
print("trimmed")
