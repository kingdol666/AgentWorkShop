from pathlib import Path
import xml.etree.ElementTree as ET
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.lines import Line2D

OUT=Path(__file__).resolve().parent
P={'ink':'#233441','navy':'#23415A','teal':'#167D86','amber':'#B56B24','pale':'#F0F6F7','blue':'#F0F4F8','warm':'#FCF3E8','line':'#AABBC4','white':'#FFFFFF','gray':'#576B76'}
plt.rcParams.update({'font.family':'serif','font.serif':['Times New Roman','Times','DejaVu Serif'],'pdf.fonttype':42,'ps.fonttype':42,'svg.fonttype':'none'})

class Diagram:
 def __init__(self,name,H):self.name=name;self.W=720;self.H=H;self.shapes=[];self.edges=[]
 def box(self,id,x,y,w,h,title,sub='',fill='white',edge='line',dash=False):
  self.shapes.append(dict(id=id,x=x,y=y,w=w,h=h,title=title,sub=sub,fill=fill,edge=edge,dash=dash))
 def text(self,id,x,y,w,h,text,color='navy',size=10,bold=False):
  self.shapes.append(dict(id=id,x=x,y=y,w=w,h=h,title=text,sub='',fill='none',edge='none',color=color,size=size,bold=bold))
 def edge(self,id,points,color='teal',dash=False):self.edges.append(dict(id=id,points=points,color=color,dash=dash))
 def save(self):
  fig,ax=plt.subplots(figsize=(7.16,7.16*self.H/self.W));fig.subplots_adjust(0,0,1,1);ax.set_xlim(0,self.W);ax.set_ylim(self.H,0);ax.axis('off')
  for e in self.edges:
   pts=e['points']; col=P[e['color']];ls=(0,(4,3)) if e['dash'] else 'solid'
   for a,b in zip(pts[:-2],pts[1:-1]): ax.add_line(Line2D([a[0],b[0]],[a[1],b[1]],color=col,lw=.9,linestyle=ls))
   ax.add_patch(FancyArrowPatch(pts[-2],pts[-1],arrowstyle='-|>',mutation_scale=7.5,color=col,lw=.9,linestyle=ls,shrinkA=0,shrinkB=0))
  for s in self.shapes:
   x,y,w,h=(s[k] for k in ('x','y','w','h'))
   if s['fill']!='none':
    ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=0,rounding_size=5',ec=P[s['edge']],fc=P[s['fill']],lw=.75,linestyle=(0,(4,3)) if s['dash'] else 'solid'))
   if s['sub']:
    ax.text(x+w/2,y+h*.31,s['title'],ha='center',va='center',color=P['navy'],fontsize=9.5,fontweight='bold',linespacing=1.06)
    ax.text(x+w/2,y+h*.70,s['sub'],ha='center',va='center',color=P['ink'],fontsize=9.1,linespacing=1.12)
   else: ax.text(x+w/2,y+h/2,s['title'],ha='center',va='center',color=P[s.get('color','navy')],fontsize=s.get('size',9.5),fontweight='bold' if s.get('bold') else 'normal',linespacing=1.12)
  for ext in ['pdf','svg','png']:fig.savefig(OUT/(self.name+'.'+ext),dpi=600)
  plt.close(fig)
  mx=ET.Element('mxfile',host='app.diagrams.net',version='24.7.17');dg=ET.SubElement(mx,'diagram',name=self.name,id=self.name)
  graph=ET.SubElement(dg,'mxGraphModel',dx='1000',dy='700',grid='1',gridSize='10',guides='1',tooltips='1',connect='1',arrows='1',fold='1',page='1',pageScale='1',pageWidth=str(self.W),pageHeight=str(self.H),math='0',shadow='0');root=ET.SubElement(graph,'root');ET.SubElement(root,'mxCell',id='0');ET.SubElement(root,'mxCell',id='1',parent='0')
  for e in self.edges:
   style=f"edgeStyle=none;html=0;strokeColor={P[e['color']]};strokeWidth=1.3;endArrow=block;endFill=1;endSize=6;"+('dashed=1;dashPattern=4 3;' if e['dash'] else '')
   pts=e['points']
   def bound(pt):
    x,y=pt
    for q in self.shapes:
     if q['fill']=='none': continue
     a,b,w,h=(q[k] for k in ('x','y','w','h'))
     if (a<=x<=a+w and y in (b,b+h)) or (b<=y<=b+h and x in (a,a+w)): return q['id']
    return None
   source,target=bound(pts[0]),bound(pts[-1]); attrs={}
   if source: attrs['source']=source
   if target: attrs['target']=target
   cell=ET.SubElement(root,'mxCell',id=e['id'],value='',style=style,edge='1',parent='1',**attrs);g=ET.SubElement(cell,'mxGeometry',relative='1',**{'as':'geometry'})
   ET.SubElement(g,'mxPoint',x=str(pts[0][0]),y=str(pts[0][1]),**{'as':'sourcePoint'});ET.SubElement(g,'mxPoint',x=str(pts[-1][0]),y=str(pts[-1][1]),**{'as':'targetPoint'})
   if len(pts)>2:
    ar=ET.SubElement(g,'Array',**{'as':'points'})
    for p in pts[1:-1]: ET.SubElement(ar,'mxPoint',x=str(p[0]),y=str(p[1]))
  for s in self.shapes:
   fill=s['fill'];edge=s['edge'];plain=fill=='none'; value=s['title']+('\n'+s['sub'] if s['sub'] else '')
   color=P[s.get('color','navy')]; style=f"rounded={'0' if plain else '1'};whiteSpace=wrap;html=0;align=center;verticalAlign=middle;fontFamily=Times New Roman;fontSize={14 if not plain else round(s.get('size',10)*1.38)};fontColor={color};"
   style+=('fillColor=none;strokeColor=none;' if plain else f"fillColor={P[fill]};strokeColor={P[edge]};strokeWidth=1.1;arcSize=8;")
   if s.get('dash'):style+='dashed=1;dashPattern=4 3;'
   if s.get('bold'):style+='fontStyle=1;'
   cell=ET.SubElement(root,'mxCell',id=s['id'],value=value,style=style,vertex='1',parent='1');ET.SubElement(cell,'mxGeometry',x=str(s['x']),y=str(s['y']),width=str(s['w']),height=str(s['h']),**{'as':'geometry'})
  ET.ElementTree(mx).write(OUT/(self.name+'.drawio'),encoding='utf-8',xml_declaration=True)

d=Diagram('fig4_route_governance',390)
d.text('boundsheading',15,2,690,25,'CONFIGURED VALUE BOUNDS',size=10,bold=True)
d.box('online',10,38,225,74,'Online node write','intersection of hard, baseline,\nproduct and active-recipe limits',fill='blue',edge='navy')
d.box('replacement',247,38,225,74,'Replacement recipe','intersection of hard, baseline,\nand product limits only',fill='white',edge='line')
d.box('trial',484,38,225,74,'Trial override','additionally checked against\napplicable recipe window',fill='warm',edge='amber')
d.text('routesheading',10,123,700,23,'ROUTE-SPECIFIC APPROVAL AND EXECUTION',size=10,bold=True)
d.box('single',10,164,135,63,'Single-node','write',fill='blue',edge='navy')
d.box('singleapproval',165,164,135,63,'Approval','if required',fill='warm',edge='amber')
d.box('singlecheck',320,164,155,63,'Route checks','binding and\napplicable grant',fill='white',edge='teal')
d.box('recipe',10,263,135,63,'Recipe','trial / apply',fill='blue',edge='navy')
d.box('recipeapproval',165,263,135,63,'Approval','if required',fill='warm',edge='amber')
d.box('recipecheck',320,263,155,63,'Route checks','authority, context\nand recipe scope',fill='white',edge='teal')
d.box('controller',515,196,145,100,'Shared controller','range; applicable step,\ninterval and hold checks',fill='pale',edge='teal')
d.box('io',677,211,33,70,'I/O',fill='white',edge='teal')
for tag,y in [('s',195),('r',294)]:
 d.edge(tag+'a',[(145,y),(165,y)]);d.edge(tag+'b',[(300,y),(320,y)])
d.edge('sfinal',[(475,195),(495,195),(495,221),(515,221)])
d.edge('rfinal',[(475,294),(495,294),(495,271),(515,271)])
d.edge('dispatch',[(660,246),(677,246)])
d.text('foot',20,347,680,24,'Pre-dispatch denial stops the affected operation or parameter.',color='gray',size=9.1)
d.save()
from shutil import move as movefile
package=OUT.parents[1]
for ext in ('pdf','svg','png'):
 movefile(OUT/f'fig4_route_governance.{ext}', package/'figures'/f'fig4.{ext}')
print('Generated Fig. 4 and refreshed package export in',OUT)
