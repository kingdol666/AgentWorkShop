# -*- coding: utf-8 -*-
"""Batch 12: the final 16pt."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path)
    else:
        print('MISS', path, '|', old[:64])

rep('sections/system.tex',
    r"""and mirrored manufacturing-execution-system (MES)
records---so heterogeneity in the plant's data
shape does not reach the team loop.""",
    r"""and mirrored manufacturing-execution-system (MES)
records---so plant data-shape heterogeneity does not reach the team loop.""")

rep('sections/evaluation.tex',
    r"""Every step verifies
equal values across the three sources with maximum consistency error
\resConsistencyErr{} (tolerances: $0.05$\,bar device readback, $0.51$\,bar
bucketed mirror---the observed zero is a passed tight check, not equality by
construction).""",
    r"""Every step verifies
equal values across the three sources at maximum consistency error
\resConsistencyErr{} ($0.05$\,bar device, $0.51$\,bar bucketed-mirror
tolerances---the zero is a passed tight check, not equality by
construction).""")

print('done')
