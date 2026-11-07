from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, ElementTree
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib as mpl
mpl.rcParams.update({'font.family':'Times New Roman','pdf.fonttype':42,'svg.fonttype':'none'})
OUT=Path(__file__).resolve().parent
NAVY='#23415A'; TEAL='#167D86'; AMBER='#B56B24'; TEXT='#263442'; LIGHT='#F3F6F8'; TLIGHT='#F0F8F7'; ALIGHT='#FCF5EE'; GREY='#65727D'
class Diagram:
 def __init__(self,name,w,h):
  self.name=name;self.w=w;self.h=h;self.items=[];self.n=2
 def box(self,x,y,w,h,text,edge=NAVY,fill='white',font=9.5,bold=False):self.items.append(('box',x,y,w,h,text,edge,fill,font,bold))
 def label(self,x,y,w,h,text,font=9.5,color=TEXT,bold=False):self.items.append(('label',x,y,w,h,text,font,color,bold))
 def arrow(self,points,color=NAVY,dashed=False):self.items.append(('arrow',points,color,dashed))
 def save(self):
  fig=plt.figure(figsize=(self.w/72,self.h/72));ax=fig.add_axes([0,0,1,1]);ax.set(xlim=(0,self.w),ylim=(self.h,0));ax.axis('off')
  mx=Element('mxfile',{'host':'app.diagrams.net','version':'24.7.17'});d=SubElement(mx,'diagram',{'name':self.name,'id':self.name});m=SubElement(d,'mxGraphModel',{'dx':str(self.w),'dy':str(self.h),'grid':'1','gridSize':'5','page':'1','pageScale':'1','pageWidth':str(self.w),'pageHeight':str(self.h),'background':'#ffffff'});root=SubElement(m,'root');SubElement(root,'mxCell',{'id':'0'});SubElement(root,'mxCell',{'id':'1','parent':'0'})
  for item in self.items:
   id=str(self.n);self.n+=1
   if item[0]=='box':
    _,x,y,w,h,t,c,f,s,b=item
    ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=0,rounding_size=2',linewidth=.8,edgecolor=c,facecolor=f));ax.text(x+w/2,y+h/2,t,ha='center',va='center',fontsize=s,color=TEXT,fontweight='bold' if b else 'normal',linespacing=1.04)
    style=f'rounded=1;arcSize=5;whiteSpace=wrap;html=0;strokeColor={c};fillColor={f};fontColor={TEXT};fontFamily=Times New Roman;fontSize={s};fontStyle={1 if b else 0};align=center;verticalAlign=middle;strokeWidth=1;'
    cell=SubElement(root,'mxCell',{'id':id,'value':t,'style':style,'vertex':'1','parent':'1'});SubElement(cell,'mxGeometry',{'x':str(x),'y':str(y),'width':str(w),'height':str(h),'as':'geometry'})
   elif item[0]=='label':
    _,x,y,w,h,t,s,c,b=item;ax.text(x+w/2,y+h/2,t,ha='center',va='center',fontsize=s,color=c,fontweight='bold' if b else 'normal',linespacing=1.04)
    style=f'text;whiteSpace=wrap;html=0;strokeColor=none;fillColor=none;fontColor={c};fontFamily=Times New Roman;fontSize={s};fontStyle={1 if b else 0};align=center;verticalAlign=middle;'
    cell=SubElement(root,'mxCell',{'id':id,'value':t,'style':style,'vertex':'1','parent':'1'});SubElement(cell,'mxGeometry',{'x':str(x),'y':str(y),'width':str(w),'height':str(h),'as':'geometry'})
   else:
    _,pts,c,dash=item
    for a,b in zip(pts[:-2],pts[1:-1]): ax.plot([a[0],b[0]],[a[1],b[1]],color=c,lw=.8,ls='--' if dash else '-')
    a,b=pts[-2:];ax.add_patch(FancyArrowPatch(a,b,arrowstyle='-|>',mutation_scale=6,shrinkA=0,shrinkB=0,linewidth=.8,color=c,linestyle='--' if dash else '-'))
    style=f'edgeStyle=none;rounded=0;html=0;endArrow=block;endFill=1;strokeColor={c};strokeWidth=1;'+('dashed=1;' if dash else '')
    cell=SubElement(root,'mxCell',{'id':id,'value':'','style':style,'edge':'1','parent':'1'});g=SubElement(cell,'mxGeometry',{'relative':'1','as':'geometry'});SubElement(g,'mxPoint',{'x':str(pts[0][0]),'y':str(pts[0][1]),'as':'sourcePoint'});SubElement(g,'mxPoint',{'x':str(pts[-1][0]),'y':str(pts[-1][1]),'as':'targetPoint'});
    if len(pts)>2:
     arr=SubElement(g,'Array',{'as':'points'})
     for q in pts[1:-1]:SubElement(arr,'mxPoint',{'x':str(q[0]),'y':str(q[1])})
  ElementTree(mx).write(OUT/(self.name+'.drawio'),encoding='utf-8',xml_declaration=True)
  fig.savefig(OUT/(self.name+'.pdf'));fig.savefig(OUT/(self.name+'.svg'));fig.savefig(OUT/(self.name+'.png'),dpi=600);plt.close(fig)

f=Diagram('fig1_cast_film',252,143)
f.box(7,3,238,29,'Cast-film context: line / product / recipe / run',font=9.7,fill=LIGHT)
f.arrow([(65,32),(65,39)],NAVY);f.arrow([(187,32),(187,39)],TEAL)
f.box(7,40,116,42,'Control node\nline speed  ·  m/min\nMQTT write',fill=LIGHT,font=9.5)
f.box(129,40,116,42,'Measurement node\nfilm thickness  ·  µm\nMQTT read',edge=TEAL,fill=TLIGHT,font=9.5)
f.box(7,90,72,43,'Command\noutcome',font=9.5,fill='white')
f.box(84,90,78,43,'Optional setpoint\nreadback',font=9.5,fill='white')
f.box(167,90,78,43,'Later process\nobservation\n(thickness)',edge=TEAL,font=9.2)
f.arrow([(65,82),(65,86),(43,86),(43,90)],NAVY)
f.arrow([(65,82),(65,86),(123,86),(123,90)],NAVY)
f.arrow([(187,82),(187,86),(206,86),(206,90)],TEAL)
f.save()

from shutil import move as movefile
package=OUT.parents[1]
for ext in ('pdf','svg','png'):
 movefile(OUT/f'fig1_cast_film.{ext}', package/'figures'/f'fig1.{ext}')
print('Generated Fig. 1 and refreshed package export.')
