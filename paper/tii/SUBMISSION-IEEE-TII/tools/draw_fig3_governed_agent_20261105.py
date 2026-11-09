from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle, Rectangle, Polygon
from matplotlib.lines import Line2D

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'resources'
STEM='fig3-governed-agent-runtime-20261105'
W,H=7.16,3.68
C={'ink':'#152B3C','navy':'#18384C','teal':'#17646A','teal2':'#32888A','orange':'#BB6A20','orange_light':'#FEF1E1','pale':'#F2F7F8','bluepale':'#EAF1F4','line':'#A7BDC7','white':'#FFFFFF','gray':'#526A76','red':'#9E4B30'}
plt.rcParams.update({'font.family':'serif','font.serif':['Times New Roman','Times','DejaVu Serif'],'font.size':8.5,'svg.fonttype':'none','pdf.fonttype':42,'ps.fonttype':42,'figure.facecolor':'white','savefig.facecolor':'white'})
fig,ax=plt.subplots(figsize=(W,H));fig.subplots_adjust(0,0,1,1);ax.set_xlim(0,W);ax.set_ylim(0,H);ax.axis('off');ax.set_aspect('equal')

def box(x,y,w,h,face='white',edge='line',r=.09,lw=.75,z=1,ls='solid'):
 p=FancyBboxPatch((x,y),w,h,boxstyle=f'round,pad=0,rounding_size={r}',facecolor=C.get(face,face),edgecolor=C.get(edge,edge),linewidth=lw,linestyle=ls,zorder=z);ax.add_patch(p);return p

def txt(x,y,s,size=8.4,color='ink',weight='normal',ha='center',va='center',ls=1.12,z=5,style='normal'):
 return ax.text(x,y,s,fontsize=size,color=C.get(color,color),fontweight=weight,ha=ha,va=va,linespacing=ls,zorder=z,style=style)

def arrow(points,color='teal',lw=1.15,ls='solid',z=3,head=6):
 # orthogonal polyline with final arrowhead
 for a,b in zip(points[:-2],points[1:-1]): ax.add_line(Line2D([a[0],b[0]],[a[1],b[1]],color=C[color],linewidth=lw,linestyle=ls,zorder=z,solid_capstyle='round'))
 ax.add_patch(FancyArrowPatch(points[-2],points[-1],arrowstyle='-|>',mutation_scale=head,linewidth=lw,linestyle=ls,color=C[color],shrinkA=0,shrinkB=0,zorder=z))

def line(points,color='teal',lw=1.1,z=3,ls='solid'):
 ax.add_line(Line2D([p[0] for p in points],[p[1] for p in points],color=C[color],linewidth=lw,linestyle=ls,zorder=z,solid_capstyle='round'))

def icon_context(x,y):
 for i in range(3): ax.add_patch(Circle((x+i*.095,y),.025,ec=C['teal'],fc='white',lw=1,zorder=5))
 line([(x-.03,y-.065),(x+.22,y-.065)],lw=1)

def icon_proposal(x,y):
 ax.add_patch(Rectangle((x-.085,y-.065),.17,.14,ec=C['teal'],fc='none',lw=1,zorder=5))
 for j in range(3): line([(x-.055,y+.035-j*.04),(x+.05,y+.035-j*.04)],lw=.7)

def icon_stack(x,y):
 for j in range(3):
  d=y+.055-j*.052
  ax.add_patch(Polygon([(x-.09,d),(x,d+.038),(x+.09,d),(x,d-.038)],closed=True,ec=C['teal'],fc='white',lw=.85,zorder=5))

def icon_approval(x,y):
 ax.add_patch(Rectangle((x-.07,y-.078),.14,.16,ec=C['orange'],fc='none',lw=1,zorder=5))
 line([(x-.045,y+.015),(x-.018,y-.01),(x+.045,y+.045)],'orange',1)

def icon_guard(x,y):
 for dy,dx in [(0.055,-.035),(0,.035),(-.055,-.02)]:
  line([(x-.09,y+dy),(x+.09,y+dy)],'teal',.8)
  ax.add_patch(Circle((x+dx,y+dy),.018,ec=C['teal'],fc='white',lw=.8,zorder=5))

def icon_driver(x,y):
 ax.add_patch(Rectangle((x-.082,y-.069),.164,.138,ec=C['teal'],fc='none',lw=1,zorder=5))
 line([(x-.045,y+.025),(x-.005,y),(x-.045,y-.025)],'teal',.9)
 line([(x+.01,y-.025),(x+.05,y-.025)],'teal',.9)

def icon_process(x,y):
 # Small process vessel with inlet, outlet, and level indication.
 box(x-.065,y-.068,.13,.135,'white','teal',.055,1.0,5)
 line([(x-.065,y+.005),(x+.065,y+.005)],'teal',.7)
 line([(x,y+.068),(x,y+.105)],'teal',1)
 line([(x-.11,y+.035),(x-.065,y+.035)],'teal',1)
 line([(x+.065,y-.035),(x+.11,y-.035)],'teal',1)
 line([(x-.04,y-.068),(x-.055,y-.095)],'teal',.8)
 line([(x+.04,y-.068),(x+.055,y-.095)],'teal',.8)

def card(x,w,title,subtitle,icon,outline='line',fill='white'):
 box(x,1.39,w,.83,fill,outline,.065,.8,z=2)
 icon(x+w/2,2.08)
 txt(x+w/2,1.89,title,8.7,'navy','bold',va='top',ls=1.02)
 txt(x+w/2,1.56,subtitle,8.4,'gray',va='center',ls=1.05)

# Evidence strip: readback and receipts are separate command-level evidence.
box(1.31,2.88,5.74,.64,'bluepale','bluepale',.10,.4)
box(1.31,2.88,1.33,.64,'teal','teal',.10,.4)
txt(1.43,3.36,'COMMAND',8.4,'white','bold',ha='left')
txt(1.43,3.13,'EVIDENCE',8.4,'white','bold',ha='left')
box(2.76,2.99,1.86,.42,'white','line',.055,.65)
txt(3.69,3.20,'Receipt / status\nwhere recorded',8.4,'navy',ls=1.03)
box(4.75,2.99,2.15,.42,'white','line',.055,.65,ls=(0,(3,2)))
txt(5.825,3.20,'Device readback  (optional)',8.4,'navy')

# Task / context left-side rail.
box(.04,.97,1.12,2.49,'pale','line',.10,.8)
txt(.60,3.27,'TASK',9.2,'navy','bold')
line([(.19,3.12),(1.01,3.12)],'line',.7)
icon_context(.46,2.94)
txt(.60,2.77,'Production\ncontext',8.8,'navy','bold',va='top',ls=1.05)
txt(.60,2.42,'line · product\nrecipe · run',8.4,'gray',ls=1.12)
line([(.21,2.18),(.99,2.18)],'line',.7)
txt(.60,2.02,'Objective',8.8,'navy','bold')
txt(.60,1.81,'process target',8.3,'gray')
box(.10,1.18,1.00,.40,'white','teal',.055,.7,ls=(0,(3,2)))
# Agent glyph uses two heads to encode the optional lead/worker grouping.
ax.add_patch(Circle((.19,1.46),.034,ec=C['teal'],fc='white',lw=.9,zorder=5))
ax.add_patch(Circle((.28,1.46),.034,ec=C['teal'],fc='white',lw=.9,zorder=5))
line([(.15,1.36),(.15,1.40),(.23,1.40),(.23,1.36)],'teal',.8)
line([(.24,1.36),(.24,1.40),(.32,1.40),(.32,1.36)],'teal',.8)
txt(.71,1.39,'Optional team\nlead + workers',8.4,'navy',ls=1.04)

# Dominant middle plane echoes the concept sketch without relying on its labels.
box(1.31,1.03,5.74,1.68,'pale','line',.10,.8)
box(1.31,2.42,5.74,.29,'teal','teal',.07,.4)
txt(1.47,2.565,'GOVERNED OPERATION PATH',8.8,'white','bold',ha='left')
txt(6.89,2.565,'application-level checks',8.4,'white',ha='right')

# Subtle surface bands group the governed route and the field side.
box(2.20,1.34,2.87,.99,'#E1EEF0','#E1EEF0',.08,.4,z=1.2)
box(5.10,1.34,1.82,.99,'#E8F2F0','#E8F2F0',.08,.4,z=1.2)
# Cards and horizontal flow.
cards=[(1.43,.72,'Propose','node · value',icon_proposal),(2.24,.72,'Dispatch','scope · policy',icon_stack),(3.08,.94,'Approval','if required',icon_approval),(4.15,.87,'Write guard','configured\nconstraints',icon_guard),(5.15,.69,'Driver','write',icon_driver),(6.00,.87,'Process','device / twin',icon_process)]
for x,w,t,s,i in cards: card(x,w,t,s,i,'orange' if t=='Approval' else 'line','orange_light' if t=='Approval' else 'white')
for left,right in [(2.15,2.24),(2.96,3.08),(4.02,4.15),(5.02,5.15),(5.84,6.00)]: arrow([(left,1.80),(right,1.80)],head=5.5,lw=1.0)
arrow([(1.16,1.80),(1.43,1.80)],head=5.5)
# Approval path states the scope and bypass without implying universal HITL.
txt(3.55,1.27,'recheck after approval',8.4,'orange',weight='bold')
txt(4.58,1.27,'when applicable',8.4,'gray')
# A visible bypass connects the dispatcher directly to the same guard.
arrow([(2.60,2.22),(2.60,2.28),(4.58,2.28),(4.58,2.22)],'teal',.95,'dashed',head=5)
txt(3.56,2.355,'no approval gate',8.4,'teal',va='center')
# Outcome records arise along the operation path; readback depends on the driver.
arrow([(1.60,2.71),(1.60,2.78),(3.69,2.78),(3.69,2.99)],'teal',.9,head=5)
line([(5.50,2.22),(5.50,2.78)],'teal',.9)
line([(5.50,2.78),(5.825,2.78)],'teal',.9)
arrow([(5.825,2.78),(5.825,2.99)],'teal',.9,head=5)
# pre-driver outcomes use precise wording; driver-stage failure may differ.
txt(1.48,1.13,'Pre-dispatch denial / decline / timeout: no driver call',8.4,'gray',ha='left')

# Independent evidence streams: process observation feeds the task goal check.
box(1.31,.17,5.74,.68,'bluepale','bluepale',.10,.4)
box(1.31,.17,1.33,.68,'teal','teal',.10,.4)
txt(1.43,.63,'PROCESS',8.4,'white','bold',ha='left')
txt(1.43,.40,'OBSERVATION',8.4,'white','bold',ha='left')
box(2.76,.27,1.79,.47,'white','line',.055,.65)
txt(3.655,.505,'DAQ observation\nwhen available',8.35,'navy',ls=1.02)
box(4.74,.27,1.93,.47,'white','line',.055,.65)
txt(5.705,.505,'Goal assessment\nnext turn or stop',8.35,'navy',ls=1.02)
arrow([(4.55,.505),(4.74,.505)],'teal',1.0,head=5)
# Down from device to observation; output to optional next agent task.
arrow([(6.44,1.39),(6.44,.92),(3.66,.92),(3.66,.74)],'teal',1.0,head=5)
arrow([(4.74,.36),(4.64,.07),(.60,.07),(.60,.97)],'teal',.9,'dashed',head=5)

for ext in ('pdf','svg','png'):
 fig.savefig(OUT/f'{STEM}.{ext}',dpi=350,facecolor='white')
 if ext == 'svg':
  svg = OUT/f'{STEM}.svg'
  svg.write_text('\n'.join(line.rstrip() for line in svg.read_text(encoding='utf-8').splitlines())+'\n', encoding='utf-8')
plt.close(fig)
print(OUT/f'{STEM}.pdf')
