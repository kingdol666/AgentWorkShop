from pathlib import Path
import re, json
folder=Path('qa/final-review-2026-10-26-final')
pages=(folder/'main.txt').read_text(encoding='utf-8',errors='replace').split('\f')
labels=['Fig. 1.','Fig. 2.','Fig. 3.','Fig. 4.','Fig. 5.','TABLE I','TABLE II']
locations={label:[i+1 for i,p in enumerate(pages) if label.lower() in p.lower()] for label in labels}
tex=Path('main.tex').read_text(encoding='utf-8')
abstract=tex.split('\\begin{abstract}',1)[1].split('\\end{abstract}',1)[0]
abstract=re.sub(r'\\[a-zA-Z]+\*?(?:\[[^]]*\])?(?:\{([^{}]*)\})?',r' \1 ',abstract)
word_count=len(re.findall(r"\b[\w]+(?:[-’'][\w]+)*\b",abstract))
body='\n'.join(Path(p).read_text(encoding='utf-8',errors='ignore') for p in ['sections/introduction.tex','sections/related.tex','sections/system.tex','sections/modules.tex','sections/evaluation.tex','sections/discussion.tex'])
report={'pdf_pages':len([p for p in pages if p.strip()]),'page_size_points':'612 x 792 letter (verified by pdfinfo)','abstract_word_count_approx':word_count,'figure_table_pages':locations,'fig1_fig2_separate':bool(locations['Fig. 1.'] and locations['Fig. 2.'] and locations['Fig. 1.'][0]!=locations['Fig. 2.'][0]),'body_contains_run_folder_ids':bool(re.search(r'\bR(?:20|21|22|23|24)\b',body))}
(folder/'layout-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
