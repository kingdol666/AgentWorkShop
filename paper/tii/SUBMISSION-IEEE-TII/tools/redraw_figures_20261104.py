"""Draw Figures 4 and 5 using the manuscript's archived evidence.

The data loader for Figure 5 is kept in the existing 2026-11-04 script;
only its presentation is changed here. PDF and SVG exports remain vector.
"""
from pathlib import Path
import csv
import io
from zipfile import ZipFile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

PAPER = Path(__file__).resolve().parents[1]
RES = PAPER / 'resources'
BLUE, ORANGE, TEAL, INK = '#4477AA', '#D55E00', '#009E73', '#26323D'
NAVY, GRID, BAND = '#264A73', '#D7DDE2', '#E6F1E8'
plt.rcParams.update({'font.family': 'serif', 'font.serif': ['Times New Roman', 'Times', 'DejaVu Serif'],
                     'font.size': 8.5, 'pdf.fonttype': 42, 'ps.fonttype': 42,
                     'svg.fonttype': 'none', 'savefig.facecolor': 'white'})

def export(fig, name):
    for ext in ('pdf', 'svg', 'png'):
        path = RES / f'{name}.{ext}'
        fig.savefig(path, bbox_inches='tight', pad_inches=.035,
                    **({'dpi': 300} if ext == 'png' else {}))
        if ext == 'svg':
            content = path.read_text(encoding='utf-8')
            path.write_text('\n'.join(line.rstrip() for line in content.splitlines()) + '\n', encoding='utf-8')
    plt.close(fig)

def box(ax, x, y, w, h, label, *, fill='#F2F6F9', edge=NAVY, size=8.4, weight='normal'):
    ax.add_patch(FancyBboxPatch((x,y), w,h, boxstyle='round,pad=0.006,rounding_size=0.009',
                               facecolor=fill, edgecolor=edge, linewidth=.9, zorder=2))
    ax.text(x+w/2, y+h/2, label, ha='center', va='center', color=INK,
            fontsize=size, weight=weight, linespacing=1.12, zorder=3)

def arrow(ax, a, b, *, color=NAVY, style='-', width=.9):
    ax.add_patch(FancyArrowPatch(a,b, arrowstyle='-|>', mutation_scale=8,
                                color=color, linewidth=width, linestyle=style, zorder=1))

fig, ax = plt.subplots(figsize=(7.16, 3.0))
fig.subplots_adjust(0,0,1,1)
ax.set(xlim=(0,1), ylim=(0,1)); ax.axis('off')
ax.text(.02,.965,'ROUTE', color=NAVY, weight='bold', fontsize=8.5, va='top')
ax.text(.225,.965,'AUTHORIZATION', color=NAVY, weight='bold', fontsize=8.5, va='top')
ax.text(.453,.965,'ROUTE-SPECIFIC CHECK', color=NAVY, weight='bold', fontsize=8.5, va='top')
ax.text(.75,.965,'DISPATCH', color=NAVY, weight='bold', fontsize=8.5, va='top')
for y, route, check in [(.70,'Single-node\nwrite','Control-node binding\nand channel grant'),
                        (.45,'Recipe trial\nor apply','Active context, authority\nand recipe scope')]:
    box(ax,.02,y,.16,.14,route)
    box(ax,.225,y,.16,.14,'Approval\nif required', fill='#FCF4EC', edge=ORANGE)
    box(ax,.425,y,.22,.14,check,fill='#EFF6F6',edge='#117C83')
    arrow(ax,(.18,y+.07),(.225,y+.07)); arrow(ax,(.385,y+.07),(.425,y+.07))
    arrow(ax,(.645,y+.07),(.695,.68 if y > .6 else .56))
box(ax,.70,.48,.17,.31,'Shared controller\n\nRange checks\nStep and timing\nwhen applicable',weight='bold',size=8.2)
box(ax,.90,.54,.08,.19,'Driver\nI/O',fill='#F0F6F1',edge='#228833',weight='bold')
arrow(ax,(.87,.635),(.90,.635))
box(ax,.02,.15,.625,.16,'Configured bounds: engineering, baseline, product\n+ current recipe for online node writes', fill='#F7F8F9',edge='#687482',size=8.3)
arrow(ax,(.645,.23),(.735,.48),style='--',color='#687482')
ax.text(.02,.055,'Trial overrides may also be checked against the active recipe window.',fontsize=8.5,color=INK)
ax.text(.02,.005,'Failed pre-dispatch checks stop the affected operation or parameter.',fontsize=8.5,color=ORANGE)
export(fig,'fig4-governance-flowchart-20261104')

# Read the frozen evidence archive directly so the figure can be regenerated
# without depending on an earlier presentation script.
opt = []
with ZipFile(PAPER / 'Supplementary-File-S7-data-2026-11-04.zip') as archive:
    paths = sorted(n for n in archive.namelist() if n.startswith('01-paper-evidence/')
                   and '-optcontrol-' in n and n.endswith('-optimization-control.csv'))
    assert len(paths) == 10
    for path in paths:
        for row in csv.DictReader(io.StringIO(archive.read(path).decode('utf-8-sig'))):
            row['seed'] = int(row['seed'])
            for field in ('pv', 'target', 'tol'):
                row[field] = float(row[field])
            opt.append(row)
    abl = list(csv.DictReader(io.StringIO(archive.read(
        '01-paper-evidence/process-window-ablation.csv').decode('utf-8-sig'))))
assert len(opt) == len({(r['condition'], r['scene'], r['seed']) for r in opt}) == 30
in_band = lambda row: abs(row['pv'] - row['target']) <= row['tol']
assert sum(in_band(r) for r in opt if r['condition'] == 'C0') == 0
assert sum(in_band(r) for r in opt if r['condition'] == 'C1') == 15
forwarded = {}
for arm in ('full', 'no-interlock', 'no-readback', 'ungated'):
    rows = [r for r in abl if r['arm'] == arm and r['kind'] in ('above-window', 'below-window')]
    assert len(rows) == 6
    forwarded[arm] = sum(r['status'] == '200' for r in rows)
assert forwarded == {'full': 0, 'no-interlock': 6, 'no-readback': 0, 'ungated': 6}

fig = plt.figure(figsize=(7.16,3.92))
gs = fig.add_gridspec(2,3, height_ratios=[1.12,1], left=.07, right=.985, top=.88,
                      bottom=.10, wspace=.33, hspace=.60)
scenes = [('injection','Injection mass','g',32.5,.35,(30.8,33.1)),
          ('wwtp','Dissolved oxygen','mg/L',3.4,.6,(0,4.35)),
          ('anneal','Anneal hardness','HV',95,6,(86,138))]
for i,(scene,title,unit,target,tol,ylim) in enumerate(scenes):
    ax=fig.add_subplot(gs[0,i]); ax.set_title(title,fontsize=9,color=NAVY,weight='bold',pad=4)
    ax.axhspan(target-tol,target+tol,color=BAND,zorder=0)
    ax.axhline(target,color=TEAL,lw=.85,ls='--')
    for condition, color, marker, shift in [('C0',BLUE,'o',-.10),('C1',ORANGE,'s',.10)]:
        rows = [next(r for r in opt if r['condition']==condition and r['scene']==scene and r['seed']==s)
                for s in range(42,47)]
        ax.scatter([s+shift for s in range(42,47)],[r['pv'] for r in rows],
                   s=22,c=color,marker=marker,edgecolor='white',linewidth=.45,zorder=3)
    ax.set(xlim=(41.5,46.5),ylim=ylim,xticks=range(42,47),xlabel='Seed',ylabel=unit)
    ax.tick_params(labelsize=8.5); ax.grid(axis='y',color=GRID,lw=.5)
    ax.spines[['top','right']].set_visible(False)
handles=[Line2D([0],[0],marker='o',color=BLUE,linestyle='',label='No-write control'),
         Line2D([0],[0],marker='s',color=ORANGE,linestyle='',label='Scripted policy'),
         Line2D([0],[0],color=TEAL,ls='--',label='Target center and band')]
fig.legend(handles=handles,loc='upper center',bbox_to_anchor=(.5,.995),ncol=3,
           frameon=False,fontsize=8.5,columnspacing=1.6,handlelength=1.3)

ax=fig.add_subplot(gs[1,:]); ax.set_xlim(-.58,6.55); ax.set_ylim(-.65,3.65); ax.axis('off')
ax.text(-.58,3.84,'Process-window ablation: individual targeted requests',
        fontsize=9,color=NAVY,weight='bold',va='bottom')
labels=['Full guard','Window check removed','Readback check removed','Window + readback removed']
arms=['full','no-interlock','no-readback','ungated']
for x,label in enumerate(['Below 1','Above 1','Below 2','Above 2','Below 3','Above 3']):
    ax.text(x+.15,3.47,label,ha='center',va='bottom',fontsize=8.5,color=INK)
for y,(arm,label) in zip([3,2,1,0],zip(arms,labels)):
    ax.text(-.12,y,label,ha='right',va='center',fontsize=8.6,color=INK)
    for rep in [1,2,3]:
        for j,kind in enumerate(['below-window','above-window']):
            rows=[r for r in abl if r['arm']==arm and int(r['rep'])==rep and r['kind']==kind]
            assert len(rows)==1
            is_forwarded=rows[0]['status']=='200'
            assert is_forwarded or rows[0]['status']=='400'
            ax.scatter((rep-1)*2+j+.15,y,s=38,marker='s' if is_forwarded else 'o',
                       color=ORANGE if is_forwarded else TEAL,edgecolor='white',linewidth=.5)
    count=forwarded[arm]
    ax.text(6.2,y,f'{count}/6',ha='left',va='center',fontsize=8.6,color=INK)
ax.text(2.55,-.53,'Circles: rejected    Squares: reached mock driver',ha='center',fontsize=8.5,color=INK)
export(fig,'fig5-evaluation-matrix-20261104')
print('Generated vector Figures 4 and 5; raw-data assertions passed.')
