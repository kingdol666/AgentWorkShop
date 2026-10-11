# -*- coding: utf-8 -*-
"""Batch 14: the last 18pt."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path)
    else:
        print('MISS', path, '|', old[:64])

rep('sections/evaluation.tex',
    r"""regimes: October 7--8 descends $66\!\rightarrow\!63$\,bar one governed
step per run under converged dead-band excitation; October 9 answers a
sagging mirror weight (\resNovWeights) with a bounded zigzag
(\resNovZigzagFrom$\!\rightarrow\!$\resNovZigzagTo\,bar, verdict converged)
and corrective steps (\resNovCorrFrom$\!\rightarrow\!$\resNovCorrTo\,bar).""",
    r"""regimes: October 7--8 descends $66\!\rightarrow\!63$\,bar one governed
step per run under converged dead-band excitation; October 9 answers a
sagging mirror weight (\resNovWeights) with a bounded zigzag
(\resNovZigzagFrom$\!\rightarrow\!$\resNovZigzagTo\,bar, converged) and
corrective steps (\resNovCorrFrom$\!\rightarrow\!$\resNovCorrTo\,bar).""")

rep('sections/mechanisms.tex',
    r"""and rejection is decidable and
layer-attributable, where a learned feasibility model offers neither""",
    r"""and rejection is decidable and layer-attributable, where a learned
feasibility model offers neither""")

rep('sections/introduction.tex',
    r"""\item a \textbf{reusable integration boundary} of self-describing node and
driver contracts across six protocol families (five exercised in the
evaluation), versioned production objects, plugin extension points, and a
typed software development kit (SDK), into which the reference adapter
projects scenario blueprints while process models and policies stay
external---Section~\ref{sec:protocol} shows a second preset commissioned
by configuration alone;""",
    r"""\item a \textbf{reusable integration boundary} of self-describing node and
driver contracts across six protocol families (five exercised in the
evaluation), versioned production objects, plugin extension points, and a
typed software development kit (SDK), into which the reference adapter
projects scenario blueprints while process models and policies stay
external (a second preset is commissioned by configuration alone,
Section~\ref{sec:protocol});""")

print('done')
