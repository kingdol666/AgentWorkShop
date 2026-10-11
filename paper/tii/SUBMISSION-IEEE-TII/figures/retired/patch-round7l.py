# -*- coding: utf-8 -*-
"""Batch 13: final 18pt after bib-entry addition."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path)
    else:
        print('MISS', path, '|', old[:64])

rep('sections/discussion.tex',
    r"""Deployment-wise, the layer installs as one service beside the plant's
protocol endpoints: a line is onboarded by declaring a blueprint, the ensure
pass projects it into semantic nodes and a versioned recipe, and an approval
client---web panel or API---receives the HITL cards; PLC protection and DCS
interlocks stay untouched on the far side.""",
    r"""Deployment-wise, the layer installs as one service beside the plant's
protocol endpoints: a line is onboarded by declaring a blueprint, which the
ensure pass projects into semantic nodes and a versioned recipe, and
approval clients---web panel or API---receive the HITL cards; PLC protection
and DCS interlocks stay untouched.""")

rep('sections/evaluation.tex',
    r"""Two regimes appear: October 7--8 descends the setpoint
ladder $66\!\rightarrow\!63$\,bar one governed step per run under converged""",
    r"""Two regimes appear: October 7--8 descends $66\!\rightarrow\!63$\,bar one
governed step per run under converged""")

rep('sections/evaluation.tex',
    r"""The index counts
attainment-relevant writes only (6 plotted of 15 for wastewater).""",
    r"""The index counts attainment-relevant writes (6 of 15 plotted for
wastewater).""")

print('done')
