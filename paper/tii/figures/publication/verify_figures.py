"""Verify publication exports, embedding, provenance hash, and gallery links."""
from pathlib import Path
import json,hashlib,re
import fitz
from PIL import Image,ImageOps,ImageDraw
R=Path(__file__).resolve().parent
m=json.loads((R/'figure-manifest.json').read_text())
assert len(m['figures'])==6
assert hashlib.sha256((R/'benchmark-data.json').read_bytes()).hexdigest()==m['data_sha256']
qa=json.loads((R/'export-qa.json').read_text());assert all(not x['errors'] and not x['outside'] and not x['text_overlaps'] for x in qa)
report=[]
for f in m['figures']:
    n=f['name'];doc=fitz.open(R/(n+'.pdf'));assert len(doc)==1
    p=doc[0];w,h=p.rect.width*25.4/72,p.rect.height*25.4/72
    assert abs(w-f['width_mm'])<.4 and abs(h-f['height_mm'])<.4
    fonts=[]
    for font in p.get_fonts():
        blob=doc.extract_font(font[0]);assert len(blob[3])>0
        fonts.append({'name':font[3],'embedded_bytes':len(blob[3])})
    assert fonts and len(p.get_drawings())>0
    images=len(p.get_images());assert images==0 or n=='fig4-workflow'
    png=Image.open(R/(n+'.png'))
    report.append({'name':n,'pages':1,'actual_pdf_mm':[round(w,3),round(h,3)],'fonts':fonts,'vector_paths':len(p.get_drawings()),'raster_images':images,'png_pixels':list(png.size)})
for link in re.findall(r'(?:href|src)="([^"]+)"',(R/'index.html').read_text(encoding='utf-8')):
    assert (R/link).exists(),link
# Contact sheet uses a common scale for the four double-column figures.
canvas=Image.new('RGB',(1500,2500),'#EDF0F2');draw=ImageDraw.Draw(canvas);y=18
for f in m['figures'][:4]:
    n=f['name'];im=ImageOps.contain(Image.open(R/(n+'.png')),(1450,635))
    draw.text((25,y),f'{n}  |  {f["width_mm"]:g} x {f["height_mm"]:g} mm',fill='#202B33');y+=25
    canvas.paste(im,(25,y));y+=im.height+30
for i,f in enumerate(m['figures'][4:]):
    n=f['name'];im=ImageOps.contain(Image.open(R/(n+'.png')),(690,570));x=25+740*i
    draw.text((x,y),f'{n}  |  {f["width_mm"]:g} x {f["height_mm"]:g} mm',fill='#202B33');canvas.paste(im,(x,y+25))
canvas.crop((0,0,1500,min(2500,y+615))).save(R/'contact-sheet.png')
(R/'verification.json').write_text(json.dumps({'status':'passed','figures':report,'gallery_links':'all local targets exist','data_hash':'matches manifest'},indent=2))
print(json.dumps(report,indent=2))
