# -*- coding: utf-8 -*-
"""Citation integrity + competitor-coverage audit for the TII manuscript."""
import re, glob, sys

r"""regex notes: cite pattern uses ['\\','cite'] join to survive quoting"""

CITE = re.compile(r'cite\{([^}]*)\}')
REF = re.compile(r'@\w+\{([^,]+),')

cited = {}
for f in sorted(glob.glob('sections/*.tex')) + ['main.tex']:
    s = open(f, encoding='utf-8').read()
    for m in CITE.finditer(s):
        for k in m.group(1).split(','):
            cited.setdefault(k.strip(), []).append(f)

bib = set(REF.findall(open('resources/refs.bib', encoding='utf-8').read()))

print('cited keys:', len(cited))
print('bib entries:', len(bib))
print('CITED BUT MISSING IN BIB:', sorted(set(cited) - bib) or 'none')
print('IN BIB BUT NEVER CITED (bibtex will not print; ok):',
      sorted(bib - set(cited)) or 'none')

rel = open('sections/related.tex', encoding='utf-8').read()
alltex = ' '.join(open(f, encoding='utf-8').read()
                  for f in sorted(glob.glob('sections/*.tex')))
comp = ['huang2026made', 'koehle2026llmdriven', 'waseem2026pretrained',
        'lim2025llmenabled', 'zhao2026shopfloor', 'jiang2026agentic']
print()
print('== six nearest-neighbor papers ==')
for k in comp:
    print(f'{k}: related.tex x{rel.count(k)} | whole paper x{alltex.count(k)}'
          + ('' if rel.count(k) >= 1 else '  *** NOT IN RELATED ***'))

# Table I row coverage
print()
print('Table I rows present:', all(k in rel for k in comp[:5]) and 'zhao2026shopfloor' in rel)
