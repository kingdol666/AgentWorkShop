# Final diagnostic receipts

- Final `analyze_grammar.py main.tex` exited 0: no rule-based grammar issues.
- An attempted `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/verify_bibliography.py main.tex` exited 1 because that filename does not exist. No document was changed. The installed skill entrypoint and bibliography module identify `verify_bib.py`; the corrected command `uv run python -B C:/Users/87287/.agents/skills/latex-paper-en/scripts/verify_bib.py resources/refs.bib --tex main.tex --json` exited 0.
- Correct bibliography output: 31 valid database entries including one IEEEbstctl style-control record, 30 cited/printed references, `missing_in_bib=[]`. Warnings concern article numbers instead of pages, preprint volume/DOI, existing author-list truncation and the script's unrecognized bstctlcite use. The separate primary-source citation audit explains those cases; no missing DOI or page range was invented.
- The first local report grammar run failed with a Windows GBK decoding error; specifying UTF-8 for report/contract reads repaired it. All five reports then passed the explicitly local structural subset. This is not canonical ARS validation or scholarly approval.
- Official web tool requests returned empty results. The already saved official-source HTTPS snapshots underpin IEEE-REQUIREMENTS.md; no web citation identifier was fabricated.
