"""Round-5: the four final text edits the adversarial seat left before production.

All four were verified against the archives before writing:
  * the fingerprint manifest is pipeline.mjs + 8 lib/*.mjs, not "checker sources"
  * the ablation baseline is seed 42, repeats 3, commit d6c824d, config 3a57e722d4764b98
  * seed-42 integrated runs reporting a final thickness: 10, of which 7 attained
    (25.26, 25.32, 25.34, 25.40, 25.68 x3) and 3 did not (0.02, -0.02, -0.02)
  * of those three, only 18qs and 1ar8 entered the guard branch; 4ms collapsed
    without it. The guard's third firing, 1f4o, is a quick-profile run whose own
    verdict is red and which reports no mission thickness.
  * the +/-0.1 window-edge probes are rejected in the full and no-readback arms
    and accepted in the no-interlock and ungated arms.
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
SECTIONS = root / "sections"


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


patch(SECTIONS / "evaluation.tex", [
    # 1. fingerprint wording, both occurrences
    ("a hash over the nine checker sources",
     "a hash over the nine harness modules", "fingerprint a"),
    ("The hash covers checker sources in the working tree",
     "The hash covers harness modules in the working tree", "fingerprint b"),

    # 2. qualify the population the attainment rate is drawn from
    ("Across the ten archived seed-42 missions that report a final thickness, seven reached "
     "the band and three collapsed into the break regime, and the run reported here is one of "
     "the seven.",
     "Across the ten archived seed-42 runs of the reference command that report a final "
     "thickness, seven reached the band and three did not, and the run reported here is one of "
     "the seven. Two of the ten carry unrelated failing checks in other phases.", "population"),

    # 3. the boundary probes are rejected only where the window check is active
    ("The same archive carries boundary probes one tenth of a unit either side of the window "
     "edge, all of which are rejected with no false block in any arm.",
     "The same archive carries boundary probes one tenth of a unit either side of the window "
     "edge: they are rejected where the window check is active, accepted where it is disabled, "
     "and no arm records a false block.", "boundary predicate"),

    # 4. distinguish the collapsed set from the guard's firing set
    ("Three other archives did, one of them 26 minutes earlier at the same recorded commit, and "
     "in every case the re-application failed to restore thickness, leaving final readings of "
     "$0.04$, $-0.02$, and $-0.02\\,\\mu$m. The guard therefore aborts rather than recovers, and "
     "a negative thickness indicates that the plant model, not only the governance layer, "
     "bounds this result.",
     "Three other archives entered it, one of them earlier on the same day at the same recorded "
     "commit, and in each case the re-application failed to restore thickness, leaving $0.04$, "
     "$-0.02$, and $-0.02\\,\\mu$m. A fourth archive collapsed without entering the branch. The "
     "guard therefore aborts rather than recovers, and a negative thickness indicates that the "
     "plant model, not only the governance layer, bounds this result.", "guard set"),
])
