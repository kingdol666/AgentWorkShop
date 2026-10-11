# -*- coding: utf-8 -*-
"""Batch 7: last 83pt (fixed heredoc mangling)."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path, '|', old[:46].replace("\n", ' '))
    else:
        print('MISS', path, '|', old[:46].replace("\n", ' '))

rep('sections/evaluation.tex',
    r"""table (\resNovWideRows{}--\resWideRows{} rows, 14 columns) with in-specification
weight ratio \resInspecRatio{} on October 7--8 (the single outlier a blank
boundary cell parsed as zero) and \resNovInspec{} (October 9, wider feed
spread, std \resNovStd)---a feed data-quality observation, not a process
excursion.""",
    r"""table (\resNovWideRows{}--\resWideRows{} rows, 14 columns) with in-specification
weight ratio \resInspecRatio{} (October 7--8; the single outlier a blank
boundary cell parsed as zero) and \resNovInspec{} (October 9, wider feed
spread, std \resNovStd)---a feed data-quality observation, not a process
excursion.""")

rep('sections/evaluation.tex',
    r"""\resConsistencyErr{} (tolerances: $0.05$\,bar on the device readback,
$0.51$\,bar on the bucketed mirror sample---the observed zero is a passed
tight check, not equality by construction).""",
    r"""\resConsistencyErr{} (tolerances: $0.05$\,bar device readback, $0.51$\,bar
bucketed mirror---the observed zero is a passed tight check, not equality by
construction).""")

rep('sections/mechanisms.tex',
    r"\includegraphics[width=0.58\textwidth]{resources/aws_fig3-flat.png}",
    r"\includegraphics[width=0.55\textwidth]{resources/aws_fig3-flat.png}")

rep('sections/system.tex',
    r"\includegraphics[width=0.84\textwidth]{resources/fig2-architecture.pdf}",
    r"\includegraphics[width=0.82\textwidth]{resources/fig2-architecture.pdf}")

print('done')
