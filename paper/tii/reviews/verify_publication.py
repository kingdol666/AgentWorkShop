"""Read-only manuscript checks plus rendered review artifacts. No LaTeX repair."""
import argparse, json, re, hashlib
from pathlib import Path
import fitz
from PIL import Image, ImageOps, ImageDraw

ap=argparse.ArgumentParser()
ap.add_argument('--expected-pages', type=int, default=11)
ap.add_argument('--render', action='store_true')
args=ap.parse_args()
root=Path(__file__).resolve().parents[1]
out=root/'reviews'/'final'
out.mkdir(parents=True, exist_ok=True)
doc=fitz.open(root/'main.pdf')
text='\n'.join(p.get_text() for p in doc)
log=(root/'main.log').read_text(encoding='utf-8', errors='replace')
aux=(root/'main.aux').read_text(encoding='utf-8', errors='replace')
expected=['fig:intro','fig:arch','fig:teamloop','fig:walkthrough','fig:clbench','fig:e1a']
labels={label:re.search(r'\\newlabel\{'+re.escape(label)+r'\}\{\{(\d+)\}\{(\d+)\}',aux) for label in expected}
figure_order={k: {'number': int(v.group(1)), 'page': int(v.group(2))} if v else None for k,v in labels.items()}
fonts=[]
seen=set()
for page in doc:
    for font in page.get_fonts(full=True):
        if font[0] in seen: continue
        seen.add(font[0]); info=doc.extract_font(font[0])
        fonts.append({'name':font[3],'type':font[2],'embedded':bool(info[3])})
assets=[]
for name in ['fig1-intro','fig2-architecture','fig3-channel-loop','fig4-workflow','fig5-closedloop','fig6-ablation']:
    stem=root/'figures'/'publication'/name
    a={'name':name,'formats':{ext:stem.with_suffix(ext).exists() for ext in ['.html','.svg','.pdf','.png']}}
    if stem.with_suffix('.pdf').exists():
        f=fitz.open(stem.with_suffix('.pdf'))
        a['mm']=[round(f[0].rect.width/72*25.4,2),round(f[0].rect.height/72*25.4,2)]
        sizes=[sp['size'] for b in f[0].get_text('dict')['blocks'] if 'lines' in b for line in b['lines'] for sp in line['spans'] if sp['text'].strip()]
        a['min_vector_text_pt']=round(min(sizes),2) if sizes else None
        a['sha256_pdf']=hashlib.sha256(stem.with_suffix('.pdf').read_bytes()).hexdigest()
    assets.append(a)
issues=[]
if len(doc)!=args.expected_pages: issues.append(f'page count {len(doc)} != {args.expected_pages}')
if any(not v for v in labels.values()): issues.append('missing figure label')
if [figure_order[k]['number'] if figure_order[k] else None for k in expected]!=list(range(1,7)): issues.append('figure numbering not 1..6')
for pattern in ['undefined references','undefined citations','Citation .* undefined','Reference .* undefined','Overfull \\hbox','Overfull \\vbox']:
    # Overfull warnings are checked literally below (TeX backslash is not a regex escape).
    if pattern.startswith('Overfull'): continue
    if re.search(pattern,log,re.I): issues.append(pattern)
for kind in ['Overfull \\hbox','Overfull \\vbox']:
    if kind in log: issues.append(kind)
if any(not x['embedded'] for x in fonts): issues.append('unembedded fonts')
if any(not all(a['formats'].values()) for a in assets): issues.append('missing figure export format')
for token in ['XXXX','First Author','Second Author','[ILLUSTRATION TO BE GENERATED']:
    if token in text: issues.append('visible placeholder: '+token)
report={'pages':len(doc),'expected_pages':args.expected_pages,'figure_order':figure_order,'fonts':fonts,'assets':assets,'issues':issues,'pdf_sha256':hashlib.sha256((root/'main.pdf').read_bytes()).hexdigest(),'scope':'Mechanical checks, not scientific validity or submission certification.'}
(out/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
if args.render:
    thumbs=[]
    for i,page in enumerate(doc):
        pix=page.get_pixmap(matrix=fitz.Matrix(1.6,1.6),alpha=False)
        file=out/f'page-{i+1:02}.png'; pix.save(file)
        im=Image.open(file).convert('RGB'); im.thumbnail((306,410))
        tile=Image.new('RGB',(326,444),'#e8e8e8'); tile.paste(im,((326-im.width)//2,20))
        ImageDraw.Draw(tile).text((12,426),f'Page {i+1}',fill='black');thumbs.append(tile)
    cols=4; rows=(len(thumbs)+cols-1)//cols
    sheet=Image.new('RGB',(cols*326,rows*444),'#d2d2d2')
    for i,im in enumerate(thumbs): sheet.paste(im,((i%cols)*326,(i//cols)*444))
    sheet.save(out/'page-contact-sheet.png')
print(json.dumps(report,indent=2))
raise SystemExit(1 if issues else 0)
