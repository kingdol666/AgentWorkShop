"""Independently compile a clean temporary extraction of the source delivery ZIP."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile
import time
import zipfile
import pymupdf as fitz

QA=Path(__file__).resolve().parent
HERE=QA.parent
ROOT=HERE.parent/'SUBMISSION-IEEE-TII'
temp=Path(tempfile.mkdtemp(prefix='tii-verifier-rebuild-'))
source_zip=HERE/'IEEE-TII-manuscript-source.zip'
with zipfile.ZipFile(source_zip) as z:
    z.extractall(temp)
packaged_pdf_sha256=hashlib.sha256((temp/'main.pdf').read_bytes()).hexdigest()
(temp/'main.pdf').unlink()
assert not (temp/'main.pdf').exists()
output_absent_before_build=not (temp/'main.pdf').exists()
started=time.time()
cmd=['uv','run','python','-B','C:/Users/87287/.agents/skills/latex-paper-en/scripts/compile.py',str(temp/'main.tex'),'--recipe','pdflatex-bibtex']
run=subprocess.run(cmd,cwd=temp,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf8',errors='replace')
(QA/'verifier-source-rebuild.log').write_text(run.stdout,encoding='utf8')
emitted=temp/'main.pdf'
result={'command':cmd,'source_zip_sha256':hashlib.sha256(source_zip.read_bytes()).hexdigest(),'delivered_pdf_sha256':hashlib.sha256((ROOT/'main.pdf').read_bytes()).hexdigest(),'build_root':str(temp),'exit_code':run.returncode,'packaged_pdf_removed_sha256':packaged_pdf_sha256,'output_absent_before_build':output_absent_before_build,'actual_emitted_PDF':str(emitted),'actual_emitted_exists':emitted.is_file(),'emitted_created_after_build_start':emitted.is_file() and emitted.stat().st_mtime>=started}
if emitted.is_file():
    original=fitz.open(ROOT/'main.pdf');rebuilt=fitz.open(emitted)
    log=(temp/'main.log').read_text(errors='replace')
    result.update(delivered_pages=len(original),rebuilt_pages=len(rebuilt),all_page_text_equal=len(original)==len(rebuilt) and all(x.get_text()==y.get_text() for x,y in zip(original,rebuilt)),all_page_geometry_equal=len(original)==len(rebuilt) and all(list(x.rect)==list(y.rect) for x,y in zip(original,rebuilt)),build_errors=[line for line in log.splitlines() if re.search('Overfull|undefined|multiply defined|Rerun to get|LaTeX Error|Missing character:',line,re.I)],shell_escape_disabled='write18 enabled' not in log,build_log_sha256=hashlib.sha256((temp/'main.log').read_bytes()).hexdigest())
result['passed']=run.returncode==0 and output_absent_before_build and result['emitted_created_after_build_start'] and result.get('rebuilt_pages')==10 and result.get('all_page_text_equal') and result.get('all_page_geometry_equal') and not result.get('build_errors') and result.get('shell_escape_disabled')
(QA/'verifier-package-rebuild.json').write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result,indent=2))
raise SystemExit(0 if result['passed'] else 1)
