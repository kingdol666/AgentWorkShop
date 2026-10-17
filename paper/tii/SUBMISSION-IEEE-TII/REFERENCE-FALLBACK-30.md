# Reference consolidation record (39 → 30)

The final manuscript uses **30 references**, matching the TII
initial-submission consolidation. This file records what was removed and how
to restore a richer list if the submission portal explicitly allows more than
30 references.

## What was consolidated

- **ISA-88 + ISA-95** merged into one entry (`isa88isa95`), cited as [13].
- Removed **Leitão 2009** [6]; the TII-adjacent supervision reference
  (Biskupovic et al.) remains.
- Removed **GAMP 5**; 21 CFR Part 11 remains as the regulated-practice
  example.
- Removed **NAMUR NOA**; DCS/SCADA batch-journal and R2R practice remain.
- Removed **IEC 60870-5-104**; DNP3 remains as the telecontrol example.
- Removed **SWaT**; Tennessee Eastman remains as the future benchmark.
- Removed **GuardAgent**; AgentSpec and CaMeL remain as the runtime-governance
  examples.
- Removed **Crowe 1996**; the data-reconciliation sentence remains in prose.
- Removed **ISA-18.2**; alarm-rationalization practice remains in prose.

## If the portal allows >30

Restore in this order, then rebuild and check 10 pages / 0 overfull:

1. Crowe 1996 (data-reconciliation positioning).
2. ISA-18.2 (alarm rationalization).
3. GuardAgent (runtime-governance lineage).
4. SWaT (second community benchmark).
5. IEC 60870-5-104 (second telecontrol example).
6. GAMP 5 / NAMUR (regulated-practice breadth).
7. Leitão 2009 (classic agent-based supervision).
8. Split ISA-88/95 back into two entries.

Do not restore all eight at once: the manuscript is exactly 10 pages with
8 pt figures and 30 references. Restoring an entry requires cutting an equal
amount of body text.

## Verification

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
python tools/audit.py
python tools/audit-figures.py
node check-refs.cjs .main.txt
```
