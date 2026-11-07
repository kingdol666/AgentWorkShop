"""Generate an object-editable diagrams.net version from the frozen-data CSVs.

The publication PDF comes from render_figure5.py. This editable schematic uses
individual labels, markers, axes and data points. It is not a linked chart:
regenerate it from CSV after changing data and check figure/caption consistency.
"""
from pathlib import Path
import csv, xml.etree.ElementTree as ET
P=Path(__file__).resolve().parent
rows=list(csv.DictReader((P/'endpoints.csv').open(encoding='utf-8',newline='')))
a=list(csv.DictReader((P/'window_ablation.csv').open(encoding='utf-8',newline='')))
assert len(rows)==30 and len(a)==24
ns='http://www.w3.org/1999/xhtml'
mx=ET.Element('mxfile',host='app.diagrams.net',version='24.7.17',type='device')
d=ET.SubElement(mx,'diagram',id='figure5',name='Figure 5')
model=ET.SubElement(d,'mxGraphModel',dx='1100',dy='700',grid='1',gridSize='10',page='1',pageScale='1',pageWidth='1032',pageHeight='660',background='#ffffff')
root=ET.SubElement(model,'root');ET.SubElement(root,'mxCell',id='0');ET.SubElement(root,'mxCell',id='1',parent='0')
i=1
INK='#202b34';BLUE='#23415A';AMBER='#B56B24';TEAL='#167D86';GRID='#D7DDE0'
def cell(text,x,y,w,h,style):
 global i
 i+=1;c=ET.SubElement(root,'mxCell',id=str(i),value=text,style=style,vertex='1',parent='1');ET.SubElement(c,'mxGeometry',x=str(x),y=str(y),width=str(w),height=str(h),**{'as':'geometry'});return c
base='html=0;whiteSpace=wrap;overflow=hidden;fontFamily=Times New Roman;fontSize=18;fontColor='+INK+';'
def txt(t,x,y,w,h=25,align='left',bold=False): cell(t,x,y,w,h,base+'strokeColor=none;fillColor=none;align='+align+';verticalAlign=middle;spacing=0;'+('fontStyle=1;' if bold else ''))
def box(x,y,w,h,fill,stroke='none',shape='rectangle'):cell('',x,y,w,h,'shape='+shape+';fillColor='+fill+';strokeColor='+stroke+';strokeWidth=1.6;')
def line(x,y,w,h,color):box(x,y,w,h,color)
def circle(x,y):box(x-6,y-6,12,12,'#ffffff',BLUE,'ellipse')
def square(x,y):box(x-6,y-6,12,12,AMBER,AMBER)
txt('(a) Simulator endpoints',20,5,500,bold=True)
txt('No-write: 60 s; final-five-sample mean',20,34,460)
txt('Scripted: endpoint after scenario-specific steps',530,34,480)
scenes=[('injection','Injection mass (g)',32.5,.35,(30.8,33.1),[31,32,33]),('wwtp','Dissolved oxygen (mg/L)',3.4,.6,(0,4.35),[0,2,4]),('anneal','Anneal hardness (HV)',95,6,(86,138),[90,110,130])]
for j,(scene,title,target,tol,lim,ticks) in enumerate(scenes):
 left=70+j*330;top=108;width=255;height=174
 tx=lambda value:left+(value-lim[0])/(lim[1]-lim[0])*width
 txt(title,left-15,75,width+30,25,'center',True)
 box(tx(target-tol),top,tx(target+tol)-tx(target-tol),height,'#f0f5f5')
 for val in ticks:
  x=tx(val);line(x,top,1,height,GRID);txt(str(val),x-24,top+height+3,48,25,'center')
 line(tx(target),top,2,height,TEAL);line(left,top,1.5,height,INK);line(left,top+height,width,1.5,INK)
 for seed in range(42,47):
  y=top+18+(seed-42)*34
  txt(str(seed)+('†' if seed==42 and scene in ('injection','wwtp') else ''),left-40,y-12,35,24,'right')
  for cond in ('C0','C1'):
   found=[r for r in rows if r['scene']==scene and r['condition']==cond and int(r['seed'])==seed];assert len(found)==1
   r=found[0];assert float(r['target'])==target and float(r['tol'])==tol
   x=tx(float(r['pv'])); circle(x,y-5) if cond=='C0' else square(x,y+5)
 if j==0:txt('Seed',5,190,50,24)
circle(60,323);txt('No-write',75,310,110);square(220,323);txt('Scripted',235,310,100)
box(370,315,18,15,'#f0f5f5');line(378,315,2,15,TEAL);txt('Target band and center',395,310,240)
txt('† No-write seed 42 in injection and wastewater began from residual states.',20,345,990)
txt('(b) Process-window ablation',20,375,500,bold=True)
xs=[460,520,625,685,790,850]
for idx,x in enumerate(xs): txt('Below' if idx%2==0 else 'Above',x-29,439,58,25,'center')
for rep in range(3):txt('Repetition '+str(rep+1),xs[rep*2]-15,410,120,25,'center')
txt('HTTP 200 / 6',905,439,105,25,'right')
arms=[('full','Full guard'),('no-interlock','Window check removed'),('no-readback','Readback check removed'),('ungated','Window + readback removed')]
for ai,(arm,label) in enumerate(arms):
 y=480+ai*31;txt(label,20,y-12,380)
 count=0
 for rep in range(1,4):
  for ki,kind in enumerate(('below-window','above-window')):
   vals=[r for r in a if r['arm']==arm and int(r['rep'])==rep and r['kind']==kind];assert len(vals)==1
   status=vals[0]['status'];assert status in ('200','400');x=xs[(rep-1)*2+ki]
   if status=='200':square(x,y);count+=1
   else:circle(x,y)
 assert count==({'full':0,'no-interlock':6,'no-readback':0,'ungated':6}[arm]);txt(f'{count}/6',940,y-12,70,25,'right')
txt('Open circle: HTTP 400 (rejected)   |   Filled square: HTTP 200',20,605,980)
txt('HTTP status does not independently establish a driver call.',20,628,980)
ET.ElementTree(mx).write(P/'fig5-editable.drawio',encoding='utf-8',xml_declaration=True)
print('Native editable diagrams.net objects:',i-1)
