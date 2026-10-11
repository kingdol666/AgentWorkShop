# -*- coding: utf-8 -*-
"""Batch 10: the last 16pt."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path)
    else:
        print('MISS', path, '|', old[:60].replace("\n", ' '))

rep('main.tex',
    r"""The result is an inspectable, simulation-tier
verification of the governance mechanisms themselves, not an
optimization-benefit claim over an ungoverned baseline.""",
    r"""The result is an inspectable, simulation-tier
verification of the governance mechanisms themselves, not an
optimization-benefit claim.""")

rep('sections/evaluation.tex',
    r"""MQTT, and HTTP (medians 47.8/19.8/19.3/32.9\,ms; the RTU-over-TCP satellite
is acquisition-only).
One admission, record, and verdict path serves every request.""",
    r"""MQTT, and HTTP (medians 47.8/19.8/19.3/32.9\,ms; the RTU-over-TCP satellite
is acquisition-only), with one admission, record, and verdict path serving
every request.""")

rep('sections/mechanisms.tex',
    r"\vspace{2pt}",
    r"\vspace{1pt}")

print('done')
