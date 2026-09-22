"""Recrop only authentic UI regions from user-provided aw_working.png.

All visible UI pixels are preserved; labels around the crops are new, corrected
editorial annotations, not modified experimental observations.
"""
from pathlib import Path
import hashlib,json
from PIL import Image
import fitz
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

OUT=Path(__file__).resolve().parent
SOURCE=OUT/'aw_working-source.png'
EXPECTED='bd6665837c3d09f8431ba2df0031348fefba3a134c5550802e965eee9d56fea9'
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==EXPECTED
im=Image.open(SOURCE).convert('RGB')
# Coordinates reference the supplied 5556 x 3228 image, not recreated UI.
CROPS=[(188,475,2713,1360),(2848,477,5409,1060),
       (190,1853,2735,2913),(2844,1850,5407,2222)]
TITLES=['(a) Provision protocol nodes','(b) Configure node and plant context',
        '(c) Deploy the team','(d) Inspect intervention records']
NOTES=[['Node runtimes: driver and sampling cadence.','Shown drivers: mock and Modbus TCP.'],
       ['Displayed range: 150–200 °C; hold: 5 s.','Device association is not member authority.'],
       ['A lead and workers are deployed as members.','Node access requires explicit bindings.'],
       ['The UI records kept and superseded changes.','A judgment is separate from physical rollback.']]
COLORS=['#267681','#416A99','#74568D','#AD8129']
plt.rcParams.update({'font.family':'Times New Roman','font.size':8,'pdf.fonttype':42,'ps.fonttype':42})
fig=plt.figure(figsize=(7.16,3.40),facecolor='white')
ax=fig.add_axes([0,0,1,1],xlim=(0,7.16),ylim=(0,3.4));ax.axis('off')
positions=[(.05,1.73),(3.64,1.73),(.05,.06),(3.64,.06)]
records=[]
for i,((x,y),box,title,notes,color) in enumerate(zip(positions,CROPS,TITLES,NOTES,COLORS)):
    w,h=3.47,1.59
    ax.add_patch(Rectangle((x,y),w,h,facecolor='white',edgecolor='#B8C2C8',linewidth=.55))
    ax.add_patch(Rectangle((x,y+h-.29),w,.29,facecolor='#F3F6F7',edgecolor='none'))
    ax.plot([x,x+w],[y+h,y+h],color=color,lw=1.4)
    ax.text(x+.08,y+h-.145,title,color=color,va='center',fontsize=8.3,fontweight='bold')
    crop=im.crop(box);crop_path=OUT/f'ui-crop-{i+1}.png';crop.save(crop_path)
    area=(x+.075,y+.40,w-.15,.86)
    ratio=crop.width/crop.height; width=min(area[2],area[3]*ratio);height=width/ratio
    xa=area[0]+(area[2]-width)/2;ya=area[1]+(area[3]-height)/2
    ia=fig.add_axes([xa/7.16,ya/3.4,width/7.16,height/3.4]);ia.imshow(crop,interpolation='none');ia.axis('off')
    for k,line in enumerate(notes): ax.text(x+.075,y+.29-k*.145,line,fontsize=8,va='center',color='#202931')
    records.append({'panel':i+1,'crop_xyxy':box,'crop_sha256':hashlib.sha256(crop_path.read_bytes()).hexdigest(),'source_ui_pixels_modified':False})
# Static metadata for repeat generation.
pdf=OUT/'fig-operational-walkthrough.pdf'
fig.savefig(pdf,metadata={'CreationDate':None,'ModDate':None,'Author':None})
plt.close(fig)
doc=fitz.open(pdf);page=doc[0]
page.get_pixmap(matrix=fitz.Matrix(300/72,300/72),alpha=False).save(OUT/'fig-operational-walkthrough.png')
spans=[s for b in page.get_text('dict')['blocks'] for l in b.get('lines',[]) for s in l['spans']]
assert all(page.rect.contains(fitz.Rect(s['bbox'])) for s in spans)
fonts=[{'name':f[3],'embedded':bool(doc.extract_font(f[0])[3])} for f in page.get_fonts(full=True)]
assert all(f['embedded'] for f in fonts)
manifest={'source':'aw_working-source.png','source_sha256':EXPECTED,'original_size':im.size,
          'purpose':'Running-software walkthrough; not physical validation or an additional benchmark trial.',
          'panels':records,'annotations':'Rewritten to distinguish node associations, member bindings and judgment from actuation.',
          'size_inches':[7.16,3.4],'annotation_font_pt_min':8,'fonts':fonts,
          'output_pdf_sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),
          'reproduce':'python paper/tii/SUBMISSION-IEEE-TII/figures/walkthrough/make_walkthrough.py'}
(OUT/'walkthrough-provenance.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Written',pdf)
