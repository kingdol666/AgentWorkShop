# -*- coding: utf-8 -*-
"""Batch 11: the last two lines."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path)
    else:
        print('MISS', path, '|', old[:64])

rep('main.tex',
    "whether a human approved, whether the device accepted the command, and whether the",
    "whether a human approved, whether the device accepted, and whether the")
rep('main.tex',
    "campaign on one live multi-tenant instance (many provisioned lines and agent\nchannels on a single host).",
    "campaign on one live multi-tenant instance (many provisioned lines and\nchannels on a single host).")
rep('sections/evaluation.tex',
    "both close with the task state and the predicate\nagreeing, on separate records.",
    "both close with task state and predicate agreeing, on separate\nrecords.")
print('done')
