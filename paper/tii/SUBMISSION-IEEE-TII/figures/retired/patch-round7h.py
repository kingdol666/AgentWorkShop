# -*- coding: utf-8 -*-
"""Batch 9: final 26pt."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path, '|', old[:46].replace("\n", ' '))
    else:
        print('MISS', path, '|', old[:46].replace("\n", ' '))

rep('sections/discussion.tex',
    r"""enabled hold heartbeats re-apply the stored setpoint without
re-admission and can trail a narrowed recipe window; oscillation, storage""",
    r"""enabled hold heartbeats re-apply the stored setpoint without
re-admission and can trail a narrowed window; oscillation, storage""")
rep('sections/discussion.tex',
    r"""until then, claims of optimization superiority, autonomous control, and safety assurance
stay unsupported.""",
    r"""until then, optimization superiority, autonomous control, and safety
assurance stay unsupported claims.""")
rep('sections/mechanisms.tex',
    r"""A semantic card exposes quantity, unit, precision, range, value, freshness, and
recipe context; the controller resolves the binding and the limits, and the
driver serializes the command.""",
    r"""A semantic card exposes quantity, unit, precision, range, value, freshness,
and recipe context; the controller resolves binding and limits, the driver
serializes the command.""")
rep('sections/mechanisms.tex',
    r"""The grade closes the command path only: a readback-verified
write says the device holds the value, not that the process responded as
intended; that distinction belongs to observation and verdict.""",
    r"""The grade closes the command path only: readback-verified says the device
holds the value, not that the process responded as intended---that
distinction belongs to observation and verdict.""")
rep('sections/evaluation.tex',
    r"""\emph{Full-suite repeatability.} Three consecutive pipeline executions
complete with zero failed checks; two runs land inside the per-line
trial-cadence window""",
    r"""\emph{Full-suite repeatability.} Three consecutive pipeline executions
complete with zero failed checks; two runs land inside the per-line
trial cadence""")
rep('main.tex',
    "\\def\\IEEEbibitemsep{0.2pt plus .4pt}",
    "\\def\\IEEEbibitemsep{0pt plus .3pt}")
print('done')
