"""Figure 5 from the frozen S7 evidence: endpoints and individual guard tests."""
from pathlib import Path
from zipfile import ZipFile
import csv
import io

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

PACKAGE = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent
ARCHIVE = PACKAGE / 'supplementary' / 'S7-core.zip'
OUT = PACKAGE / 'figures' / 'fig5'
INK = '#202B34'
BLUE = '#23415A'
ORANGE = '#B56B24'
GREEN = '#167D86'
GRID = '#D7DDE0'

plt.rcParams.update({
    'font.family': 'serif', 'font.serif': ['Times New Roman', 'Times', 'DejaVu Serif'],
    'font.size': 9.0, 'axes.labelsize': 9.0, 'xtick.labelsize': 9.0,
    'ytick.labelsize': 9.0, 'pdf.fonttype': 42, 'ps.fonttype': 42,
    'svg.fonttype': 'none', 'axes.linewidth': .7,
    'figure.facecolor': 'white', 'savefig.facecolor': 'white',
})

with ZipFile(ARCHIVE) as z:
    paths = sorted(p for p in z.namelist() if p.startswith('01-paper-evidence/')
                   and '-optcontrol-' in p and p.endswith('-optimization-control.csv'))
    assert len(paths) == 10
    endpoints = []
    for path in paths:
        for row in csv.DictReader(io.StringIO(z.read(path).decode('utf-8-sig'))):
            row['seed'] = int(row['seed'])
            for key in ('pv', 'target', 'tol'):
                row[key] = float(row[key])
            endpoints.append(row)
    ablation = list(csv.DictReader(io.StringIO(
        z.read('01-paper-evidence/process-window-ablation.csv').decode('utf-8-sig'))))

assert len(endpoints) == 30
assert len({(r['scene'],r['condition'],r['seed']) for r in endpoints}) == 30
assert {r['seed'] for r in endpoints} == set(range(42,47))
in_band = lambda r: abs(r['pv'] - r['target']) <= r['tol']
assert sum(in_band(r) for r in endpoints if r['condition'] == 'C0') == 0
assert sum(in_band(r) for r in endpoints if r['condition'] == 'C1') == 15

arms = ['full','no-interlock','no-readback','ungated']
matrix = {}
for arm in arms:
    for rep in (1,2,3):
        for kind in ('below-window','above-window'):
            rows = [r for r in ablation if r['arm']==arm and int(r['rep'])==rep and r['kind']==kind]
            assert len(rows)==1 and rows[0]['status'] in ('200','400')
            matrix[arm,rep,kind] = rows[0]['status'] == '200'
counts = {arm: sum(matrix[arm,rep,kind] for rep in (1,2,3)
                   for kind in ('below-window','above-window')) for arm in arms}
assert counts == {'full':0, 'no-interlock':6, 'no-readback':0, 'ungated':6}

fig = plt.figure(figsize=(7.16,4.18))
fig.text(.025,.975,'(a) Simulator endpoints',weight='bold',color=INK,fontsize=9,va='top')
fig.text(.025,.936,'No-write: 60 s; mean of final five samples',color=INK,fontsize=9.0,va='top')
fig.text(.52,.936,'Scripted: endpoint after scenario-specific steps',color=INK,fontsize=9.0,va='top')

scenes = [
    ('injection','Injection mass (g)',32.5,.35,(30.8,33.1),[31,32,33]),
    ('wwtp','Dissolved oxygen (mg/L)',3.4,.6,(0,4.35),[0,2,4]),
    ('anneal','Anneal hardness (HV)',95,6,(86,138),[90,110,130]),
]
gs = fig.add_gridspec(1,3,left=.068,right=.987,bottom=.54,top=.855,wspace=.32)
for idx,(scene,title,target,tol,xlim,xticks) in enumerate(scenes):
    ax=fig.add_subplot(gs[0,idx])
    ax.set_title(title,fontsize=9.0,color=INK,weight='bold',pad=5)
    ax.axvspan(target-tol,target+tol,facecolor='#F0F5F5',edgecolor='#B5C8C7',
               hatch='///',linewidth=0,zorder=0)
    ax.axvline(target,color=GREEN,linestyle='--',linewidth=.8,zorder=1)
    for condition,color,marker,offset in [('C0',BLUE,'o',-.13),('C1',ORANGE,'s',.13)]:
        rows = [next(r for r in endpoints if r['scene']==scene and r['condition']==condition
                     and r['seed']==s) for s in range(42,47)]
        assert all(r['target']==target and r['tol']==tol for r in rows)
        ax.scatter([r['pv'] for r in rows], [s+offset for s in range(42,47)], s=27,
                   facecolors='white' if condition=='C0' else color,
                   edgecolors=color, marker=marker, linewidths=1.0, zorder=3)
    ax.set_xlim(*xlim); ax.set_xticks(xticks); ax.set_ylim(46.55,41.45)
    ax.set_yticks(range(42,47))
    ax.set_yticklabels(['42†' if scene in ('injection','wwtp') else '42','43','44','45','46'])
    ax.grid(axis='x',color=GRID,lw=.5,zorder=0)
    ax.spines[['top','right']].set_visible(False)
    ax.tick_params(length=3,pad=2)
    if idx==0: ax.set_ylabel('Seed',labelpad=2)

fig.legend(handles=[
    Line2D([],[],marker='o',linestyle='',markerfacecolor='white',markeredgecolor=BLUE,
           markeredgewidth=1,markersize=5.2,label='No-write'),
    Line2D([],[],marker='s',linestyle='',markerfacecolor=ORANGE,markeredgecolor=ORANGE,
           markersize=5.2,label='Scripted'),
    Line2D([],[],color=GREEN,linestyle='--',linewidth=.8,label='Target center; hatched band'),
],loc='center left',bbox_to_anchor=(.04,.482),ncol=3,frameon=False,
   fontsize=9.0,handlelength=1.4,handletextpad=.4,columnspacing=1.0,borderpad=0)
fig.text(.025,.435,'† No-write seed 42 in injection and wastewater began from residual states.',
         fontsize=9.0,color=INK,va='center')

fig.text(.025,.386,'(b) Process-window ablation',weight='bold',color=INK,fontsize=9,va='center')
ax=fig.add_axes([.025,.092,.95,.265]); ax.set(xlim=(0,1),ylim=(0,1)); ax.axis('off')
centers = [.435,.495,.59,.65,.745,.805]
for rep in range(3):
    ax.text((centers[2*rep]+centers[2*rep+1])/2, .98, f'Repetition {rep+1}',
            ha='center',va='top',fontsize=9.0,color=INK)
    for j,label in enumerate(('Below','Above')):
        ax.text(centers[2*rep+j],.78,label,ha='center',va='center',fontsize=9.0,color=INK)
ax.text(.995,.78,'HTTP 200 / 6',ha='right',va='center',fontsize=9.0,color=INK)
labels=['Full guard','Window check removed','Readback check removed','Window + readback removed']
for y,arm,label in zip([.60,.42,.24,.06],arms,labels):
    ax.text(0,y,label,ha='left',va='center',fontsize=9.0,color=INK)
    for rep in (1,2,3):
        for j,kind in enumerate(('below-window','above-window')):
            passed = matrix[arm,rep,kind]
            ax.scatter(centers[(rep-1)*2+j],y,s=25,marker='s' if passed else 'o',
                       facecolors=ORANGE if passed else 'white',
                       edgecolors=ORANGE if passed else BLUE,linewidths=1.0)
    ax.text(.985,y,f'{counts[arm]}/6',ha='right',va='center',fontsize=9.0,color=INK)
fig.text(.025,.055,'Open circle: HTTP 400 (rejected)   |   Filled square: HTTP 200',
         fontsize=9.0,color=INK,va='center')
fig.text(.025,.021,'HTTP status does not independently establish a driver call.', fontsize=9.0,color=INK,va='center')

for ext in ('pdf','svg','png'):
    path = OUT.with_suffix('.'+ext)
    fig.savefig(path, **({'dpi':600} if ext=='png' else {}))
    if ext == 'svg':
        content = path.read_text(encoding='utf-8')
        path.write_text('\n'.join(line.rstrip() for line in content.splitlines()) + '\n', encoding='utf-8')
plt.close(fig)
with (DATA / 'endpoints.csv').open('w', newline='', encoding='utf-8') as f:
    writer=csv.DictWriter(f,fieldnames=['scene','condition','seed','pv','target','tol'],extrasaction='ignore'); writer.writeheader(); writer.writerows(endpoints)
with (DATA / 'window_ablation.csv').open('w', newline='', encoding='utf-8') as f:
    writer=csv.DictWriter(f,fieldnames=['arm','rep','kind','status'],extrasaction='ignore'); writer.writeheader(); writer.writerows(r for r in ablation if r['kind'] in ('below-window','above-window'))
print('Verified 30 endpoints; in-band C0/C1: 0/15, 15/15; guard counts:',counts)
