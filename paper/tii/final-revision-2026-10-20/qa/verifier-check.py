"""Independent, read-only delivery audit. Writes only verifier-* audit outputs."""
from __future__ import annotations
import collections
import csv
import hashlib
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
import pymupdf as fitz

QA = Path(__file__).resolve().parent
HERE = QA.parent
PAPER = HERE.parent / 'SUBMISSION-IEEE-TII'
REPO = HERE.parents[2]
checks = []

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check(name, passed, details):
    checks.append(dict(name=name, passed=bool(passed), details=details))
    print(('PASS ' if passed else 'FAIL ') + name + ': ' + str(details)[:500])

def plain(s):
    return re.sub(r'(?<!\\)%[^\n]*', '', s)

def primitives(obj, path=''):
    if isinstance(obj, dict):
        for k,v in obj.items():
            yield from primitives(v,path+'/'+str(k))
    elif isinstance(obj,list):
        for i,v in enumerate(obj):
            yield from primitives(v,path+'/'+str(i))
    elif obj is None or isinstance(obj,(int,float,bool)):
        yield path,type(obj).__name__,obj
    elif isinstance(obj,str):
        try: embedded=json.loads(obj)
        except (ValueError,TypeError): return
        if isinstance(embedded,(list,dict)):
            yield from primitives(embedded,path+'/embedded-json')

def original(row):
    name=row['public_path']
    if name.startswith('code/recorded-commit/'):
        return subprocess.check_output(['git','show',row['source_revision']+':'+row['source_path']],cwd=REPO)
    if name.startswith('code/recorded-simulator/'):
        return subprocess.check_output(['git','show',row['source_revision']+':'+row['source_path'].removeprefix('plc-node-simulator/')],cwd=REPO/'plc-node-simulator')
    return Path(row['source_absolute']).read_bytes()

sources={p.relative_to(PAPER).as_posix():p.read_text(encoding='utf-8') for p in [PAPER/'main.tex',*sorted((PAPER/'sections').glob('*.tex'))]}
combined='\n'.join(plain(s) for s in sources.values())
pdfbytes=(PAPER/'main.pdf').read_bytes()
doc=fitz.open(stream=pdfbytes,filetype='pdf')
check('ten_nonblank_letter_pages',len(doc)==10 and all(p.get_text().strip() and abs(p.rect.width-612)<.05 and abs(p.rect.height-792)<.05 for p in doc),len(doc))
check('PDF_below_40MB',len(pdfbytes)<40*1024*1024,len(pdfbytes))
check('IEEEtran_and_body_geometry',r'\documentclass[journal]{IEEEtran}' in combined and not re.search(r'\\usepackage(?:\[[^]]*\])?\{geometry\}|\\linespread|\\(?:setlength|addtolength)\s*\{\\(?:textwidth|textheight|baselineskip|oddsidemargin|evensidemargin)\}',combined),'journal class; no body type/margin overrides')
abstract=re.search(r'\\begin\{abstract\}(.*?)\\end\{abstract\}',sources['main.tex'],re.S).group(1)
words=re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*",abstract)
check('abstract_150_250_single_paragraph',150<=len(words)<=250 and '\n\n' not in abstract.strip(),len(words))
cited={k.strip() for group in re.findall(r'\\cite\{([^}]+)\}',combined) for k in group.split(',')}
bbl=(PAPER/'main.bbl').read_text(encoding='utf-8')
printed=set(re.findall(r'\\bibitem(?:\[[^]]+\])?\{([^}]+)\}',bbl))
check('citation_resolution',cited==printed,dict(cited=len(cited),printed=len(printed),missing=sorted(cited-printed),unused=sorted(printed-cited)))
log=(PAPER/'main.log').read_text(encoding='utf-8',errors='replace')
errors=re.findall(r'[^\n]*(?:Overfull|undefined|multiply defined|Rerun to get|LaTeX Error|Missing character:)[^\n]*',log,re.I)
check('build_log',not errors,errors)
text='\f'.join(p.get_text() for p in doc)
check('references_no_question_marks','??' not in text,text.count('??'))
private=re.compile(r'87287|Diane Williams|AgentWorkShop|kingdol|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]codes[\\/]|github\.com/(?:ABO(?:/|\b)|[^/\s]+/AgentWorkShop)',re.I)
check('anonymous_PDF',not private.search(text+' '+str(doc.metadata)) and doc.metadata.get('author','') in ('','Anonymous Authors'),doc.metadata.get('author'))
resources={r[0]:r for p in doc for r in p.get_fonts(full=True)}
missing_fonts=[r[3] for x,r in resources.items() if not doc.extract_font(x)[3]]
check('all_PDF_fonts_embedded',not missing_fonts,dict(font_count=len(resources),missing=missing_fonts))
bounds=[]; fig_sizes=[]; pages=[]
for number,page in enumerate(doc,1):
    spans=[s for b in page.get_text('dict')['blocks'] if b['type']==0 for line in b['lines'] for s in line['spans'] if s['text'].strip()]
    for s in spans:
        r=fitz.Rect(s['bbox'])
        if not (page.rect + (-.5,-.5,.5,.5)).contains(r):
            bounds.append(dict(page=number,text=s['text'],bbox=list(r)))
        if 'Arial' in s['font'] or 'DejaVuSans' in s['font']:
            fig_sizes.append(s['size'])
    pages.append(dict(page=number,chars=len(page.get_text()),images=len(page.get_images(full=True)),fonts=len(page.get_fonts(full=True))))
    page.get_pixmap(matrix=fitz.Matrix(1.5,1.5),alpha=False).save(QA/f'verifier-page-{number:02d}.png')
check('text_within_page',not bounds,bounds)
check('placed_figure_font_floor',fig_sizes and min(fig_sizes)>=8.95,dict(minimum_pdf_bp=min(fig_sizes) if fig_sizes else None))
figures=[]
for options,name in re.findall(r'\\includegraphics(?:\[([^]]*)\])?\{([^}]+)\}',combined):
    p=PAPER/name
    with fitz.open(p) as f:
        page=f[0]; spans=[s for b in page.get_text('dict')['blocks'] if b['type']==0 for line in b['lines'] for s in line['spans'] if s['text'].strip()]
        rows=page.get_fonts(full=True)
        figures.append(dict(path=name,sha256=sha(p.read_bytes()),width_in=page.rect.width/72,height_in=page.rect.height/72,minimum_font=min(s['size'] for s in spans),raster_objects=len(page.get_images(full=True)),fonts_embedded=all(f.extract_font(r[0])[3] for r in rows),vector_drawings=len(page.get_drawings())))
check('six_vector_figures',len(figures)==6 and all(f['minimum_font']>=8.99 and f['raster_objects']==0 and f['fonts_embedded'] and f['vector_drawings']>0 for f in figures),figures)
expected={'fig-architecture-2026.pdf':(7.16,3.15),'fig-runtime-2026.pdf':(3.5,3.55)}
check('Figs1_2_exact_geometry',all(abs(f['width_in']-expected[Path(f['path']).name][0])<.005 and abs(f['height_in']-expected[Path(f['path']).name][1])<.005 for f in figures if Path(f['path']).name in expected),expected)
check('no_visible_placeholders',not re.search(r'\bTODO\b|\bFIXME\b|\[Evidence needed',combined),'source scan')
with zipfile.ZipFile(HERE/'baseline-source.zip') as baseline:
    diffs=[]
    for name,current in sources.items():
        old=baseline.read(name).decode('utf-8').replace('\r\n','\n')
        for kind,pattern in [('labels',r'\\label\{[^}]+\}'),('equations',r'\\begin\{equation\}.*?\\end\{equation\}')]:
            if re.findall(pattern,plain(old),re.S)!=re.findall(pattern,plain(current),re.S): diffs.append((name,kind))
    check('protected_labels_equations_unchanged',not diffs,diffs)
    check('experiment_macros_unchanged',plain(baseline.read('resources/results-macros.tex').decode()).split()==plain((PAPER/'resources/results-macros.tex').read_text()).split(),'baseline source comparison')
    check('bibliography_unchanged',baseline.read('resources/refs.bib')==(PAPER/'resources/refs.bib').read_bytes(),'byte comparison')

package_results=[]; privacy_hits=[]
for package,manifest_name in [('IEEE-TII-manuscript-source.zip','DELIVERY-MANIFEST.json'),('IEEE-TII-anonymous-evidence.zip','EVIDENCE-DELIVERY.json')]:
    path=HERE/package; manifest=json.loads((HERE/manifest_name).read_text())
    with zipfile.ZipFile(path) as z:
        entries=z.namelist(); crc=z.testzip(); goodhash=sha(path.read_bytes())==manifest['sha256']
        if package.startswith('IEEE-TII-manuscript'):
            hash_rows=manifest['files']; embedded=json.loads(z.read('FILE-MANIFEST.json'))['files']
            mismatch=[n for n,h in hash_rows.items() if sha(z.read(n))!=h]
            mismatch.extend(n for n,h in embedded.items() if sha(z.read(n))!=h)
            check('source_package_citations_and_urls_preserved',z.read('resources/refs.bib')==(PAPER/'resources/refs.bib').read_bytes() and z.read('main.bbl')==(PAPER/'main.bbl').read_bytes(),'bibliography and rendered references byte-identical')
            check('source_package_current_active_content',all(z.read(n)==(PAPER/n).read_bytes() for n in [*sources,'main.pdf','resources/results-macros.tex','resources/refs.bib','main.bbl',*[f['path'] for f in figures]]),'active content byte comparison')
        else:
            hash_rows=json.loads(z.read('FILES.json'))['files']; mismatch=[n for n,r in hash_rows.items() if sha(z.read(n))!=r['sha256'] or len(z.read(n))!=r['bytes']]
            check('evidence_exact_entry_set',set(entries)==set(hash_rows)|{'FILES.json'},len(entries))
        for name in entries:
            data=z.read(name)
            if name.lower().endswith('.pdf'):
                with fitz.open(stream=data,filetype='pdf') as dd: content=' '.join(p.get_text() for p in dd)+' '+str(dd.metadata)
            else: content=data.decode('utf-8',errors='replace')
            patterns=[('identity_path',private),('private_key',re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),('JWT',re.compile(r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}')),('openai_key',re.compile(r'sk-(?:proj-)?[A-Za-z0-9_-]{24,}'))]
            for category,pattern in patterns:
                if pattern.search(content): privacy_hits.append(dict(package=package,path=name,category=category))
        package_results.append(dict(package=package,files=len(entries),sha256=sha(path.read_bytes()),crc_ok=crc is None,manifest_hash_ok=goodhash,mismatches=mismatch))
check('package_CRC_hashes_and_manifests',all(p['crc_ok'] and p['manifest_hash_ok'] and not p['mismatches'] for p in package_results),package_results)
check('bounded_public_package_privacy',not privacy_hits,privacy_hits)

private_rows=json.loads((HERE/'INTERNAL-EVIDENCE-PROVENANCE.json').read_text())['sources']
public_rows={r['path']:r for r in json.loads((HERE/'evidence/MANIFEST.json').read_text())['source_files']}
original_errors=[]; numeric_errors=[]; numeric_fields=0; csv_fields=0
with zipfile.ZipFile(HERE/'IEEE-TII-anonymous-evidence.zip') as z:
    for row in private_rows:
        name=row['public_path']; data=original(row); delivered=z.read(name); public=public_rows[name]
        if sha(data)!=row['original_sha256'] or sha(data)!=public['original_sha256'] or sha(delivered)!=public['delivered_sha256']: original_errors.append(name)
        ext=Path(name).suffix
        if ext in ('.json','.jsonl'):
            a=data.decode('utf-8-sig'); b=delivered.decode('utf-8-sig')
            aa=json.loads(a) if ext=='.json' else [json.loads(line) for line in a.splitlines() if line.strip()]
            bb=json.loads(b) if ext=='.json' else [json.loads(line) for line in b.splitlines() if line.strip()]
            ap=list(primitives(aa)); bp=list(primitives(bb)); numeric_fields+=len(ap)
            if ap!=bp:numeric_errors.append(name)
        elif ext=='.csv':
            aa=list(csv.reader(io.StringIO(data.decode('utf-8-sig'))));bb=list(csv.reader(io.StringIO(delivered.decode('utf-8-sig'))))
            if len(aa)!=len(bb) or any(len(x)!=len(y) for x,y in zip(aa,bb)):numeric_errors.append(name)
            for a,b in zip(aa,bb):
                for x,y in zip(a,b):
                    if re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?',x):
                        csv_fields+=1
                        if x!=y:numeric_errors.append(name)
check('all_176_original_artifacts_unchanged',len(private_rows)==176 and not original_errors,dict(files=len(private_rows),errors=original_errors))
check('redaction_preserves_numeric_boolean_nulls',not numeric_errors,dict(JSON_primitive_fields=numeric_fields,CSV_numeric_cells=csv_fields,errors=numeric_errors))

report=dict(scope='Independent technical and delivery audit; no novelty or journal-acceptance judgement',pdf_sha256=sha(pdfbytes),passed=all(c['passed'] for c in checks),checks=checks,pages=pages,figures=figures,packages=package_results)
(QA/'verifier-independent-check.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
(QA/'verifier-manuscript.txt').write_text(text,encoding='utf-8')
print('VERDICT', 'PASS' if report['passed'] else 'FAIL', report['pdf_sha256'])
raise SystemExit(0 if report['passed'] else 1)
