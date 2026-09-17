"""Rebuild publication HTML + inline SVG sources. Writes only beside this file.
Run: python paper/tii/figures/publication/build_figures.py
Then: node paper/tii/figures/publication/export_figures.mjs
Dependencies: Python Pillow + fonttools; Node Playwright (local or Codex runtime).
"""
from pathlib import Path
import base64, io, json, html, hashlib
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools import subset
ROOT=Path(__file__).resolve().parent
ASSETS=ROOT.parent/'walkthrough'
INK='#202B33'; GRAY='#58656F'; LINE='#AAB5BC'; BLUE='#285D8F'; TEAL='#196C70'; RED='#9B3B3B'; LIGHT='#F3F6F8'
def esc(s): return html.escape(str(s))
def font_data(name):
    p=ROOT/name
    if not p.exists():
        font=TTFont(Path('C:/Windows/Fonts')/('calibrib.ttf' if 'bold' in name else 'calibri.ttf'))
        opt=subset.Options(); opt.flavor='woff2'; sub=subset.Subsetter(options=opt)
        sub.populate(unicodes=list(range(32,127))+[176,181,183,215,8211,8212,8217,8592,8594,8596,8722,8804,8805,916,931])
        sub.subset(font); font.flavor='woff2'; font.save(p)
    return base64.b64encode(p.read_bytes()).decode()
FONT=font_data('publication-regular.woff2'); BOLD=font_data('publication-bold.woff2')
STYLE=f'''@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{FONT}) format('woff2');font-weight:400}}@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{BOLD}) format('woff2');font-weight:700}}text{{font-family:Publication,sans-serif;font-size:11.3px;fill:{INK};font-variant-numeric:tabular-nums}}'''
class Figure:
    def __init__(self,name,w,h,title):
        self.name,self.w,self.h,self.title=name,w,h,title;self.s=[]
    def raw(self,s):self.s.append(s)
    def rect(self,x,y,w,h,fill='white',stroke=LINE,rx=3):self.raw(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="0.8"/>')
    def text(self,x,y,s,size=11.3,color=INK,bold=False,anchor='start'):
        self.raw(f'<text x="{x}" y="{y}" style="font-size:{size}px;fill:{color};font-weight:{700 if bold else 400}" text-anchor="{anchor}">{esc(s)}</text>')
    def lines(self,x,y,lines,**kw):
        for i,s in enumerate(lines):self.text(x,y+i*14,s,**kw)
    def path(self,d,color=GRAY,dash=False,arrow=True,width=1.2):self.raw(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"'+(' stroke-dasharray="4 3"' if dash else '')+(f' marker-end="url(#{color[1:]})"' if arrow else '')+'/>')
    def box(self,x,y,w,h,title,lines=(),color=BLUE,fill='white'):
        self.rect(x,y,w,h,fill,color);self.text(x+8,y+16,title,12.4,color,True);self.lines(x+8,y+32,lines)
    def label(self,x,y,s,color=GRAY):self.text(x,y,s,11.3,color)
    def image(self,file,crop,x,y,w,h):
        im=Image.open(ASSETS/file).convert('RGB').crop(crop);b=io.BytesIO();im.save(b,format='PNG');data=base64.b64encode(b.getvalue()).decode()
        self.raw(f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,{data}"/>')
    def save(self):
        defs=''.join(f'<marker id="{c[1:]}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" fill="{c}"/></marker>'for c in [GRAY,BLUE,TEAL,RED,INK])
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w/4}mm" height="{self.h/4}mm" viewBox="0 0 {self.w} {self.h}" role="img" aria-labelledby="title"><title id="title">{esc(self.title)}</title><defs><style>{STYLE}</style>{defs}</defs><rect width="100%" height="100%" fill="white"/>'+''.join(self.s)+'</svg>'
        (ROOT/(self.name+'.svg')).write_text(svg,encoding='utf-8')
        (ROOT/(self.name+'.html')).write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><title>{esc(self.title)}</title><style>@page{{size:{self.w/4}mm {self.h/4}mm;margin:0}}html,body{{margin:0;padding:0;width:{self.w/4}mm;height:{self.h/4}mm;background:white}}svg{{display:block}}*{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style><body>{svg}</body></html>',encoding='utf-8')
        return {'name':self.name,'width_mm':self.w/4,'height_mm':self.h/4,'min_label_pt':11.3*.25*72/25.4}
figs=[]
f=Figure('fig1-intro',724,188,'Illustrative integration patterns and explicit node/team binding')
for x,title,c in [(4,'(a) Illustrative application-specific integration',GRAY),(370,'(b) AgentWorkShop: explicit binding',TEAL)]:
    f.rect(x,4,350,176,'white',LINE);f.text(x+9,22,title,12.4,c,True)
f.box(14,41,90,43,'Agent', ['proposal'],GRAY)
f.box(135,41,106,43,'Application', ['integration glue'],GRAY)
f.box(272,41,72,43,'Plant', ['PLC / I/O'],GRAY)
f.path('M104 62H133');f.path('M241 62H270')
f.label(42,103,'Advisory output or tailored actuation interface')
f.path('M308 86V125H25V86',GRAY,True);f.label(111,121,'application-defined feedback')
f.lines(15,148,['Scope, approval and records depend on the application.', 'Illustrative pattern; not a claim about all prior systems.'])
f.box(380,41,90,43,'Channel', ['lead + workers'],TEAL)
f.box(499,41,106,43,'Node binding', ['read / write scope'],TEAL)
f.box(634,41,76,43,'DAQ / DCW', ['plant nodes'],TEAL)
f.path('M470 62H497',BLUE);f.path('M605 62H632',TEAL)
f.label(405,103,'Manual approval or auto policy → checked write')
f.path('M672 86V125H390V86',TEAL,True);f.label(438,121,'readback (if available) + attributed record',TEAL)
f.lines(380,148,['Shared logical IDs connect intent, node and outcome.', 'Agent verdict is recorded separately from compensation.'])
figs.append(f.save())

f=Figure('fig2-architecture',724,260,'Platform process, binding bridge, and external boundaries')
for x,w,title,sub in [(4,232,'Operator UI / TUI + twin renderer','UI → API writes; renderer displays state'),(246,230,'REST / WebSocket + A2A','shared authenticated entry points'),(486,234,'MCP interface','read-oriented subset; not all host tools')]:
    f.box(x,4,w,39,title,[sub],GRAY)
f.rect(4,57,716,129,LIGHT,LINE);f.text(13,72,'PLATFORM PROCESS',11.3,GRAY,True)
f.box(14,81,202,95,'Agent orchestrator',['harness adapters · team channels','lead / workers · tasks · memory','host tools + scoped dispatch','shared node / team / run IDs'],BLUE)
f.box(259,81,207,95,'Binding + approval bridge',['node semantics · read/write scope','manual / auto policy · approvals','agent-write admission + readback','records · separate backstop'],TEAL)
f.box(509,81,201,95,'Industrial supervisor',['DAQ runtimes + gateway sweep','DCW dispatch + protocol drivers','alarms · line / recipe / run state','device-twin state publication'],TEAL)
f.path('M216 113H257',BLUE);f.text(237,103,'intent',11.3,BLUE,False,'middle')
f.path('M466 113H507',TEAL);f.text(487,103,'write',11.3,TEAL,False,'middle')
f.path('M509 159H468',GRAY,True);f.path('M259 159H218',GRAY,True)
f.path('M120 43V55',GRAY);f.path('M361 43V55',GRAY);f.path('M603 43V55',GRAY)
f.box(4,208,204,36,'External CLI engines',['separate processes; containment external'],BLUE)
f.box(240,208,242,36,'Separate persistent stores',['platform DB · time series · objects · audit'],GRAY)
f.box(516,208,204,36,'Plant / protocol boundary',['physical devices or seeded scenarios'],TEAL)
f.path('M104 176V206',BLUE);f.path('M118 208V178',GRAY,True);f.path('M361 186V206',GRAY,True);f.path('M610 176V206',TEAL);f.path('M627 208V178',GRAY,True)
f.text(373,200,'Logical IDs; not atomic storage',11.3,GRAY)
f.text(5,257,'Solid: request / control · Dashed: observation / record flow · PLC safety and hard real-time control remain external.',11.3,GRAY)
figs.append(f.save())

f=Figure('fig3-channel-loop',724,316,'Central Channel with four explicitly bound nodes and separate admission, observation, verdict, and compensation')
f.box(4,4,208,65,'Independent human',['manual approval','pause / intervene · escalation'],GRAY)
f.box(250,4,466,65,'3  Agent-write admission → driver path',['bound scope · availability · manual approval / auto policy','agent guardrails · hard range + active recipe window'],TEAL)
f.path('M212 35H248',GRAY)
f.box(4,86,208,56,'Thickness · DAQ · µm',['bound read','process observation'],TEAL)
f.box(4,157,208,56,'Pressure · DAQ · MPa',['bound read','process observation'],TEAL)
f.box(250,100,220,113,'CHANNEL',['lead + workers · task tree','shared memory','explicit bindings per node','read / write scope','manual / auto write policy'],BLUE,LIGHT)
f.box(514,86,202,56,'Heater · DCW · °C',['bound write','driver / register readback*'],TEAL)
f.box(514,157,202,56,'Screw · DCW · rpm',['bound write','driver / register readback*'],TEAL)
f.path('M212 118H248',TEAL);f.path('M212 189H248',TEAL)
f.text(220,83,'1 / 5 Observe',11.3,TEAL)
f.path('M360 100V71',BLUE);f.text(371,87,'2 Propose',11.3,BLUE)
f.path('M708 69V77H722V183H718',TEAL);f.path('M722 112H718',TEAL)
f.text(593,81,'4 Write',11.3,TEAL)
f.path('M514 128H472',GRAY,True);f.path('M514 194H472',GRAY,True)
f.text(480,150,'feedback*',11.3,GRAY)
f.box(4,242,208,49,'Independent auto backstop',['eligible records · bounded recovery','separate system evaluation'],GRAY)
f.box(250,242,220,49,'6  Agent submits verdict',['dcw_judge records verdict only','does not compute or actuate'],BLUE)
f.box(514,242,202,49,'7  Separate compensation',['authorized re-dispatch via checks','not an effect of dcw_judge'],RED)
f.path('M360 213V240',BLUE)
f.path('M108 213V240',GRAY,True)
f.path('M470 264H512',RED,True)
f.path('M108 291V296H615V293',RED,True)
f.text(4,311,'* Register readback if available; process observation is separate. Recipe / heartbeat checks are source-specific.',11.3,GRAY)
figs.append(f.save())

f=Figure('fig4-workflow',724,208,'Archived console details: commissioning, device association, team deployment, and optimization records')
# Two rows preserve actual screenshot detail at publication scale. Labels remain outside crops.
for x,y,num,title,sub in [(4,3,'1','Create / connect','Node / protocol'),(370,3,'2','Device association','Archived node configuration'),(4,106,'3','Team deployment','Lead / workers'),(370,106,'4','Optimization records','Outcome + actor')]:
    f.rect(x,y,350,96,'white',LINE);f.text(x+8,y+17,num+'  '+title,12.4,TEAL,True);f.text(x+8,y+34,sub,11.3,GRAY)
# No retyped UI, invented readouts, or overlays. Association is not agent capability binding.
f.image('p1-addnode.png',(1020,0,1380,115),12,48,108,35)
f.image('p1-driver.png',(586,251,1250,399),126,46,220,49)
f.text(379,55,'Process range',11.3,GRAY);f.text(552,55,'Bound device',11.3,GRAY)
f.image('p2-binding.png',(590,234,902,296),379,65,145,29)
f.image('p2-binding.png',(1320,204,1660,324),552,57,155,40)
f.image('p3-team.png',(48,216,720,452),120,128,227,71)
f.text(12,173,'Archived team',11.3,GRAY);f.text(12,188,'definition',11.3,GRAY)
f.image('p4-records.png',(0,76,780,214),379,147,333,51)
figs.append(f.save())

# Quantitative figures never fall back to the historical aggregate plots.
p=ROOT/'benchmark-data.json'
if p.exists():
    data=json.loads(p.read_text(encoding='utf-8-sig'))
    assert data['schema_version']==1
    d=data['fig5'];assert len(d['seeds'])==3
    f=Figure('fig5-closedloop',352,280,'Fixed-controller per-evaluation objective trajectories for three seeds')
    f.text(4,15,'Fixed-controller loop · no LLM',12.4,INK,True)
    x0,x1,y0,y1=43,337,62,201
    X=lambda v:x0+(x1-x0)*v/2
    Y=lambda v:y1-(v-60)/32*(y1-y0)
    for val in [60,70,80,90]:
        yy=Y(val);f.path(f'M{x0} {yy}H{x1}',LINE,False,False,.6);f.text(x0-6,yy+4,str(val),11.3,GRAY,False,'end')
    f.path(f'M{x0} {y0}V{y1}H{x1}',GRAY,False,False)
    f.text(4,51,'Objective J',11.3,GRAY)
    ref=d['reference']['value'];yy=Y(ref)
    f.path(f'M{x0} {yy}H{x1}',GRAY,True,False,1)
    f.text(337,51,f'Offline grid reference W* = {ref:.3f}',11.3,GRAY,False,'end')
    for idx,(seed,c,dash) in enumerate(zip(d['seeds'],[TEAL,BLUE,RED],[False,True,False])):
        traj=seed['trajectory'];assert [t['iter'] for t in traj]==[0,1,2]
        mean=sum(t['J'] for t in traj[-2:])/2
        assert abs(mean-seed['J_end'])<1e-8 and abs(mean/ref-seed['ratio'])<1e-8
        path='M'+'L'.join(f'{X(t["iter"])} {Y(t["J"])}' for t in traj)
        f.path(path,c,dash,False,1.35)
        for t in traj:
            x,y=X(t['iter']),Y(t['J'])
            if idx==0:f.raw(f'<circle cx="{x}" cy="{y}" r="2.7" fill="white" stroke="{c}" stroke-width="1.2"/>')
            elif idx==1:f.rect(x-2.6,y-2.6,5.2,5.2,'white',c,0)
            else:f.raw(f'<path d="M{x} {y-3.2}l3.1 5.6h-6.2Z" fill="white" stroke="{c}" stroke-width="1.1"/>')
        lx=46+idx*102;f.path(f'M{lx} 28h17',c,dash,False,1.4);f.text(lx+22,32,f'Seed {seed["seed"]}',11.3,c)
    for it in range(3):f.text(X(it),216,str(it),11.3,GRAY,False,'middle')
    f.text(191,232,'Closed-loop iteration',11.3,GRAY,False,'middle')
    lo=min(s['ratio']for s in d['seeds']);hi=max(s['ratio']for s in d['seeds'])
    f.text(4,252,'J_end = mean of evaluations at iterations 1 and 2.',11.3,INK)
    f.text(4,269,f'J_end / W* = {lo:.3f}–{hi:.3f}; not a final-point ratio.',11.3,INK)
    figs.append(f.save())
    d=data['fig6'];assert d['repetitions_per_arm']==3
    f=Figure('fig6-ablation',352,288,'Fixed six-attack rejection counts and three paired latency quantiles per arm')
    f.text(4,14,'(a) Rejected / 6 fixed seeded attacks',12.4,INK,True)
    f.text(4,29,'Same count in each of 3 repetitions; no CI.',11.3,GRAY)
    names=['Full','No interlock','No readback','Both disabled'];expected=[6,4,6,4]
    xs=[70,148,226,304]
    for a,x,name,n in zip(d['arms'],xs,names,expected):
        assert len(a['repetitions'])==3
        assert all(r['attack']['rejected']==n and r['attack']['attempted']==6 for r in a['repetitions'])
        f.text(x,46,name,11.3,INK,False,'middle')
        for i in range(6):
            xx=x-29+i*11.5
            f.rect(xx,55,8,9,TEAL if i<n else 'white',TEAL,0)
        f.text(x,80,f'{n}/6',12.4,TEAL,True,'middle')
    f.text(4,98,'Hard range retained in every arm; seed 42; mock drivers.',11.3,GRAY)
    f.path('M4 106H348',LINE,False,False,.7)
    f.text(4,122,'(b) Write latency · 3 paired p50 / p95 points',12.4,INK,True)
    f.raw(f'<circle cx="10" cy="136" r="2.6" fill="{BLUE}"/>');f.text(18,140,'p50',11.3,BLUE)
    f.raw(f'<circle cx="59" cy="136" r="2.6" fill="white" stroke="{BLUE}" stroke-width="1.2"/>');f.text(67,140,'p95',11.3,BLUE)
    f.text(108,140,'line joins the same repetition',11.3,GRAY)
    Y=lambda v:244-(v-100)/70*92
    for val in [100,120,140,160]:
        yy=Y(val);f.path(f'M40 {yy}H345',LINE,False,False,.6);f.text(34,yy+3,str(val),11.3,GRAY,False,'end')
    f.text(4,155,'ms',11.3,GRAY)
    for a,x,name in zip(d['arms'],xs,names):
        for i,r in enumerate(a['repetitions']):
            xx=x+(i-1)*12;lo,hi=Y(r['p50_ms']),Y(r['p95_ms'])
            f.path(f'M{xx} {lo}V{hi}',BLUE,False,False,.9)
            f.raw(f'<circle cx="{xx}" cy="{lo}" r="2.6" fill="{BLUE}"/><circle cx="{xx}" cy="{hi}" r="2.6" fill="white" stroke="{BLUE}" stroke-width="1.1"/>')
        f.text(x,260,name,11.3,INK,False,'middle')
    f.text(4,281,'Complete frozen baseline; no latency-equivalence claim.',11.3,GRAY)
    figs.append(f.save())
(ROOT/'figure-manifest.json').write_text(json.dumps({'figures':figs,'font':'Calibri, embedded subset (regular/bold)','data_sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None,'screenshot_sources':['walkthrough/p1-addnode.png','walkthrough/p1-driver.png','walkthrough/p2-binding.png','walkthrough/p3-team.png','walkthrough/p4-records.png']},indent=2),encoding='utf-8')
print('Built',', '.join(x['name'] for x in figs))

NOTES={
'fig1-intro':('Integration patterns','Conceptual illustration, informed by the manuscript. The left panel is a limited illustrative pattern, not a universal claim about prior systems.'),
'fig2-architecture':('System architecture','Manuscript system architecture. The platform process is distinct from CLI engines, persistent stores and the plant. Shared logical IDs do not imply atomic persistence.'),
'fig3-channel-loop':('Channel-centered loop','Manuscript mechanism flow, with independent human control and backstop. Agent verdict recording is distinct from compensation. Source-specific write checks remain explicit.'),
'fig4-workflow':('Archived console details','Original crops from figures/walkthrough: p1-addnode, p1-driver, p2-binding, p3-team and p4-records. Device association is not agent capability binding. These archived UI details do not establish a new successful deployment or experiment.'),
'fig5-closedloop':('Fixed-controller closed loop','Source: benchmark-data.json → fig5; archived run bench/results/20260914152838-fwg/run.json. Three seeds, per-evaluation J; J_end is the mean of iterations 1 and 2. W* is an offline finite-grid reference, not a global bound. No LLM controller.'),
'fig6-ablation':('Governance ablation','Source: benchmark-data.json → fig6; complete frozen run-e1lite-4arm baseline, three repetitions per arm, seed 42, mock drivers. Attack counts are the fixed six-case pattern; latency marks are each repetition’s raw p50/p95 pair. Hard range remains enabled. No nine-repetition aggregates, confidence intervals or equivalence claim.')}
cards=[]
for item in figs:
    name=item['name'];title,note=NOTES[name]
    links=' · '.join(f'<a href="{name}.{ext}">{label}</a>' for ext,label in [('html','HTML + inline SVG'),('svg','SVG'),('pdf','Vector PDF'),('png','PNG (300 dpi)')])
    cards.append(f'<section id="{name}"><header><h2>{esc(name)} — {esc(title)}</h2><p class="dimensions">{item["width_mm"]:g} × {item["height_mm"]:g} mm</p></header><nav aria-label="{esc(name)} file formats">{links}</nav><div class="preview"><a href="{name}.html" aria-label="Open {esc(name)} source preview"><img src="{name}.svg" alt="{esc(title)}" style="width:{item["width_mm"]}mm" loading="lazy"></a></div><p class="source">{esc(note)}</p></section>')
gallery=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publication figures — AgentWorkShop</title><style>
@font-face{{font-family:Publication;src:url(publication-regular.woff2)}}@font-face{{font-family:Publication;src:url(publication-bold.woff2);font-weight:700}}
:root{{color-scheme:light}}*{{box-sizing:border-box}}body{{margin:0;background:#EDF0F2;color:{INK};font:17px/1.5 Publication,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:32px 24px}}h1{{font-size:28px;margin:0 0 8px}}h2{{font-size:20px;margin:0}}p{{margin:8px 0 0}}.intro{{max-width:880px;margin-bottom:28px}}a{{color:{BLUE};text-underline-offset:3px}}a:focus-visible{{outline:3px solid {TEAL};outline-offset:4px}}section{{margin:0 0 24px;padding:20px;background:white;border:1px solid #CAD2D8;border-radius:4px}}header{{display:flex;justify-content:space-between;gap:20px;align-items:baseline}}.dimensions{{white-space:nowrap;color:{GRAY}}}nav{{margin:8px 0 16px}}.preview{{padding:20px;background:#EDF0F2;overflow-x:auto}}.preview a{{display:block;width:fit-content;max-width:100%}}.preview img{{display:block;max-width:100%;height:auto;background:white}}.source{{max-width:950px;color:#46545F;font-size:16px}}footer{{font-size:15px}}code{{font-size:.9em;overflow-wrap:anywhere}}@media(max-width:640px){{main{{padding:20px 12px}}section{{padding:14px}}header{{display:block}}.preview{{padding:10px}}h1{{font-size:25px}}}}
</style></head><body><main><h1>Publication figures</h1><div class="intro"><p>Six authoritative figure sources and exports for the IEEE manuscript. Previews share a neutral background; figure pages themselves are white. Click a preview to open its self-contained HTML.</p><p>Nominal screen sizing follows the print width (display calibration varies). Open SVG or PDF to zoom without loss. Diagram labels: embedded Calibri, approximately 8 pt. Figure 4 retains original raster UI crops inside a vector frame.</p><p><a href="benchmark-data.json">Benchmark data contract</a> · <a href="figure-manifest.json">Dimensions and provenance</a> · <a href="export-qa.json">Export checks</a> · <a href="README.md">Rebuild instructions</a></p></div>{''.join(cards)}<footer>Generated locally from build_figures.py. No external fonts, scripts or services. Data contract is maintained separately by the scientist.</footer></main></body></html>'''
(ROOT/'index.html').write_text(gallery,encoding='utf-8')
