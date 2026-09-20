"""Build the AgentTeam demonstration four-panel figure (fig-agentteam-demo).

Same publication figure system as build_figures.py (embedded Calibri subset, mm-true
@page, print-color-adjust) but self-contained: crops come from the AgentTeam
demonstration run (paper/tii/figures/agentteam-demo/*.png, light console theme).

Panels (2 x 2, same geometry as fig4-workflow):
  1 Node connection      — five-protocol acquisition nodes, live PV rows
  2 AgentTeam deployment — group roster instantiated as channel members
  3 Goal dispatch        — task/goal composer with the optimization SOP
  4 Governed writes      — write history with ACK + convergence (53.6 -> 49.8 um)

Run:  python paper/tii/figures/publication/build_agentteam_demo.py
Then: node paper/tii/figures/publication/export_figures.mjs
"""
from pathlib import Path
import base64, io, json, html
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parent / 'agentteam-demo'
INK = '#202B33'; GRAY = '#58656F'; LINE = '#AAB5BC'; TEAL = '#196C70'


def esc(s):
    return html.escape(str(s))


def font_data(name):
    p = ROOT / name
    if not p.exists():
        font = TTFont(Path('C:/Windows/Fonts') / ('calibrib.ttf' if 'bold' in name else 'calibri.ttf'))
        opt = subset.Options(); opt.flavor = 'woff2'; sub = subset.Subsetter(options=opt)
        sub.populate(unicodes=list(range(32, 127)) + [176, 181, 183, 215, 8211, 8212, 8217, 8592, 8594, 8596, 8722, 8804, 8805, 916, 931])
        sub.subset(font); font.flavor = 'woff2'; font.save(p)
    return base64.b64encode(p.read_bytes()).decode()


FONT = font_data('publication-regular.woff2'); BOLD = font_data('publication-bold.woff2')
STYLE = (f'@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{FONT}) format(\'woff2\');font-weight:400}}'
         f'@font-face{{font-family:Publication;src:url(data:font/woff2;base64,{BOLD}) format(\'woff2\');font-weight:700}}'
         f'text{{font-family:Publication,sans-serif;font-size:11.3px;fill:{INK};font-variant-numeric:tabular-nums}}')


class Figure:
    def __init__(self, name, w, h, title):
        self.name, self.w, self.h, self.title = name, w, h, title; self.s = []

    def raw(self, s):
        self.s.append(s)

    def rect(self, x, y, w, h, fill='white', stroke=LINE, rx=3):
        self.raw(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="0.8"/>')

    def text(self, x, y, s, size=11.3, color=INK, bold=False, anchor='start'):
        self.raw(f'<text x="{x}" y="{y}" style="font-size:{size}px;fill:{color};font-weight:{700 if bold else 400}" text-anchor="{anchor}">{esc(s)}</text>')

    def image_frac(self, file, frac, x, y, w, h):
        """Embed a fractional crop (fx0, fy0, fx1, fy1) of an asset, aspect-preserved."""
        im = Image.open(ASSETS / file).convert('RGB')
        W, H = im.size
        box = (round(frac[0] * W), round(frac[1] * H), round(frac[2] * W), round(frac[3] * H))
        c = im.crop(box); b = io.BytesIO(); c.save(b, format='PNG')
        data = base64.b64encode(b.getvalue()).decode()
        self.raw(f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,{data}"/>')

    def save(self):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w / 4}mm" height="{self.h / 4}mm" '
               f'viewBox="0 0 {self.w} {self.h}" role="img" aria-labelledby="title">'
               f'<title id="title">{esc(self.title)}</title><defs><style>{STYLE}</style></defs>'
               f'<rect width="100%" height="100%" fill="white"/>' + ''.join(self.s) + '</svg>')
        (ROOT / (self.name + '.svg')).write_text(svg, encoding='utf-8')
        (ROOT / (self.name + '.html')).write_text(
            f'<!doctype html><html lang="en"><meta charset="utf-8"><title>{esc(self.title)}</title>'
            f'<style>@page{{size:{self.w / 4}mm {self.h / 4}mm;margin:0}}html,body{{margin:0;padding:0;'
            f'width:{self.w / 4}mm;height:{self.h / 4}mm;background:white}}svg{{display:block}}'
            f'*{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style><body>{svg}</body></html>',
            encoding='utf-8')
        return {'name': self.name, 'width_mm': self.w / 4, 'height_mm': self.h / 4, 'min_label_pt': 11.3 * .25 * 72 / 25.4}


# ── crops: fractional regions of the demonstration screenshots (light theme) ──
# fractional crops measured on the light-theme captures
C_NODE_ROW = (0.017, 0.2245, 1.0, 0.2625)      # step01: header + first acquisition row
C_MEMBERS = (0.747, 0.0745, 0.994, 0.3345)     # step05: members panel (lead / worker chips)
C_COMPOSER = (0.117, 0.762, 0.881, 0.998)      # step05: composer with goal + SOP
C_HISTORY = (0.0, 0.824, 1.0, 0.958)           # step09: write history rows (ACK)

f = Figure('fig-agentteam-demo', 724, 208,
           'AgentTeam demonstration on the cast-film twin: node connection, team deployment, goal dispatch, and governed writes')
for x, y, num, title, sub in [
    (4, 3, '1', 'Node connection', 'Five-protocol acquisition · live'),
    (370, 3, '2', 'AgentTeam deployment', 'Group roster → channel members'),
    (4, 106, '3', 'Goal dispatch', 'Task/goal composer → lead'),
    (370, 106, '4', 'Governed writes', 'ACK history · convergence'),
]:
    f.rect(x, y, 350, 96, 'white', LINE)
    f.text(x + 8, y + 17, num + '  ' + title, 12.4, TEAL, True)
    f.text(x + 8, y + 34, sub, 11.3, GRAY)

# 1 — acquisition node row (live value · trend · driver · running batch)
f.image_frac('step01-daq-nodes.png', C_NODE_ROW, 12, 42, 334, 50)
# 2 — deployed channel members (lead / worker chips)
f.image_frac('step05-goal-composer.png', C_MEMBERS, 379, 42, 196, 52)
f.text(588, 56, 'lead: opt-lead', 11.3, GRAY)
f.text(588, 74, 'worker: opt-executor', 11.3, GRAY)
f.text(588, 92, '(node bindings)', 11.3, GRAY)
# 3 — composer with goal + SOP
f.image_frac('step05-goal-composer.png', C_COMPOSER, 12, 142, 334, 52)
# 4 — write history with ACK (governed setpoint writes)
f.image_frac('step09-journal-records.png', C_HISTORY, 379, 142, 334, 52)

entry = f.save()

# upsert into the figure manifest so export_figures.mjs renders it
mp = ROOT / 'figure-manifest.json'
man = json.loads(mp.read_text(encoding='utf-8'))
man['figures'] = [x for x in man.get('figures', []) if x.get('name') != entry['name']] + [entry]
man.setdefault('screenshot_sources', []).append('agentteam-demo/step01,step05,step09 (AgentTeam demonstration run, light console theme)')
mp.write_text(json.dumps(man, indent=2), encoding='utf-8')
print('Built', entry['name'], f"{entry['width_mm']}x{entry['height_mm']}mm")
