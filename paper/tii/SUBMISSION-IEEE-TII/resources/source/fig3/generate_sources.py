"""Create editable draw.io and OPML representations of the manuscript Fig. 3."""
from pathlib import Path
import re
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
TEAL = '#176268'
INK = '#173A50'
MUTED = '#52707D'
OUTLINE = '#A2B9C4'
PALE = '#E9F1F4'
AMBER = '#BD6819'

mx = ET.Element('mxfile', {'host': 'app.diagrams.net', 'agent': 'editable-source', 'version': '24.7.17'})
diagram = ET.SubElement(mx, 'diagram', {'id': 'governed-operation', 'name': 'Governed operation'})
model = ET.SubElement(diagram, 'mxGraphModel', {'dx': '1450', 'dy': '800', 'grid': '1', 'gridSize': '10',
                      'page': '1', 'pageScale': '1', 'pageWidth': '1440', 'pageHeight': '800', 'background': '#FFFFFF'})
root = ET.SubElement(model, 'root')
ET.SubElement(root, 'mxCell', {'id': '0'})
ET.SubElement(root, 'mxCell', {'id': '1', 'parent': '0'})

def node(key, label, x, y, w, h, style):
    # At 7.16 in / 1440 units, 23 units is approximately 8.2 pt.  This is
    # an estimate; actual draw.io PDF export must be verified after scaling.
    if label:
        style = re.sub(r'fontSize=(\d+(?:\.\d+)?);', lambda m: f'fontSize={max(23.0, float(m.group(1))):g};', style)
        if 'fontSize=' not in style:
            style += 'fontSize=23;'
    cell = ET.SubElement(root, 'mxCell', {'id': key, 'value': label, 'style': style, 'vertex': '1', 'parent': '1'})
    ET.SubElement(cell, 'mxGeometry', {'x': str(x), 'y': str(y), 'width': str(w), 'height': str(h), 'as': 'geometry'})

def edge(key, source, target, style='', points=()):
    cell = ET.SubElement(root, 'mxCell', {'id': key, 'value': '', 'edge': '1', 'parent': '1',
                         'source': source, 'target': target,
                         'style': f'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;strokeColor={TEAL};strokeWidth=2;endArrow=block;endFill=1;{style}'})
    geo = ET.SubElement(cell, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
    if points:
        arr = ET.SubElement(geo, 'Array', {'as': 'points'})
        for x, y in points:
            ET.SubElement(arr, 'mxPoint', {'x': str(x), 'y': str(y)})

base = f'rounded=1;arcSize=14;whiteSpace=wrap;html=0;strokeWidth=1.5;strokeColor={OUTLINE};fontColor={INK};fontFamily=Arial;'
panel = base + f'fillColor=#F2F7F8;align=center;'
card = base + 'fillColor=#FFFFFF;align=center;verticalAlign=middle;fontSize=18;'
title = f'rounded=1;arcSize=16;whiteSpace=wrap;html=0;strokeColor=none;fillColor={TEAL};fontColor=#FFFFFF;fontFamily=Arial;fontStyle=1;fontSize=19;align=left;spacingLeft=20;'
text = f'text;html=0;strokeColor=none;fillColor=none;fontColor={INK};fontFamily=Arial;whiteSpace=wrap;align=center;verticalAlign=middle;'

# Large, independently editable background and heading objects.
node('task-background', '', 15, 70, 205, 455, panel)
node('task-title', 'INPUTS', 35, 85, 165, 35, text + 'fontStyle=1;fontSize=23;')
node('task-context', 'Scene context\nline · product\nrecipe · run', 30, 145, 175, 105, card + 'fontSize=16;')
node('task-objective', 'User objective\nprocess target', 30, 270, 175, 75, card + 'fontSize=16;')
node('team', 'Optional\ncoordination\nlead + workers', 30, 370, 175, 110, card + f'dashed=1;dashPattern=4 3;strokeColor={TEAL};fontSize=16;')

node('evidence-background', '', 245, 35, 1120, 120, base + f'fillColor={PALE};strokeColor=none;')
node('evidence-title', 'COMMAND\nEVIDENCE', 245, 35, 220, 120, title)
node('receipt', 'Receipt / status\nwhere recorded', 485, 56, 235, 78, card + 'fontSize=16;')
node('status-boundary', 'Status alone does not\nconfirm device change', 738, 56, 250, 78, card + 'fillColor=#F5F8FA;fontSize=15;')
node('readback', 'Device readback\nwhen available', 1007, 56, 330, 78, card + 'dashed=1;dashPattern=4 3;fontSize=16;')

node('operation-background', '', 245, 195, 1120, 380, panel)
node('operation-header', 'GOVERNED OPERATION PATH', 245, 195, 1120, 52, title)
node('operation-subtitle', 'application-level checks', 1015, 204, 330, 30,
     text + 'fontColor=#FFFFFF;fontSize=15;align=right;')
node('governance-tint', '', 380, 277, 688, 176, base + 'fillColor=#E0EFF0;strokeColor=none;')
node('field-tint', '', 1070, 277, 275, 176, base + 'fillColor=#E6F2EE;strokeColor=none;')

steps = [
    ('propose', 'Propose\nnode /\nvalue', 260, 295, 110),
    ('dispatch', 'Dispatch\nscope ·\npolicy', 385, 295, 115),
    ('approval', 'Conditional\napproval', 515, 295, 135),
    ('revalidation', 'Revalidation', 790, 295, 140),
    ('guard', 'Write guard\napplicable\nconstraints', 940, 295, 120),
    ('driver', 'Driver\nwrite', 1075, 295, 105),
    ('process', 'Process\ndevice / twin', 1195, 295, 145),
]
for key, label, x, y, w in steps:
    st = card
    if key == 'approval':
        st += f'fillColor=#FFF1E2;strokeColor={AMBER};strokeWidth=2;'
    node(key, label, x, y, w, 145, st)
node('decision', 'Approved?', 655, 307.5, 120, 120,
     f'rhombus;whiteSpace=wrap;html=0;strokeWidth=2;strokeColor={AMBER};fillColor=#FFF1E2;fontColor={INK};fontFamily=Arial;fontSize=23;')
node('rejected', 'Stop / Rejected\nNo driver call', 660, 465, 205, 65,
     card + f'fillColor=#FFF1E2;strokeColor={AMBER};fontSize=23;')
node('decision-yes', 'Yes', 740, 290, 42, 26, text + f'fontColor={TEAL};fontSize=23;')
node('decision-no', 'No', 659, 428, 45, 26, text + f'fontColor={AMBER};fontSize=23;')
node('bypass-label', 'no approval gate', 593, 247, 190, 22, text + f'fontSize=23;fontColor={TEAL};')
node('driver-error', 'Driver-stage error: device may have changed; reconcile before retry', 280, 538, 1000, 24,
     text + f'fontColor={MUTED};fontSize=14;align=left;')

node('observation-background', '', 245, 620, 1120, 120, base + f'fillColor={PALE};strokeColor=none;')
node('observation-title', 'PROCESS\nOBSERVATION', 245, 620, 220, 120, title)
node('daq', 'DAQ observation\nwhen available', 485, 640, 340, 80, card)
node('assessment', 'Goal assessment\nnext turn or stop', 850, 640, 440, 80, card)

edge('e-task-propose', 'task-background', 'propose', 'exitX=1;exitY=0.65;entryX=0;entryY=0.5;', [(242, 366)])
for a, b in [('propose','dispatch'), ('dispatch','approval'), ('approval','decision'), ('decision','revalidation'), ('revalidation','guard'), ('guard','driver'), ('driver','process')]:
    edge(f'e-{a}-{b}', a, b, 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;')
edge('e-reject', 'decision', 'rejected', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', [(715, 450), (762, 450)])
edge('e-bypass', 'dispatch', 'guard', 'dashed=1;dashPattern=6 4;exitX=0.5;exitY=0;entryX=0.5;entryY=0;', [(442.5, 280), (1000, 280)])
edge('e-receipt', 'operation-header', 'receipt', 'exitX=0.12;exitY=0;entryX=0.5;entryY=1;', [(380, 170), (655, 170)])
edge('e-readback', 'driver', 'readback', 'exitX=0.5;exitY=0;entryX=0.5;entryY=1;', [(1127.5, 170), (1172, 170)])
edge('e-process-daq', 'process', 'daq', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', [(1267.5, 600), (655, 600)])
edge('e-daq-assessment', 'daq', 'assessment', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;')
edge('e-feedback', 'assessment', 'task-background', 'dashed=1;dashPattern=6 4;exitX=0.2;exitY=1;entryX=0.5;entryY=1;', [(920, 775), (117, 775)])
ET.indent(mx, space='  ')
ET.ElementTree(mx).write(HERE / 'fig3-editable.drawio', encoding='utf-8', xml_declaration=True)

# Diagnostic SVG preview from the same editable objects; orthogonal routing
# is approximated, because this is not the diagrams.net rendering engine.
S = '{http://www.w3.org/2000/svg}'
ET.register_namespace('', 'http://www.w3.org/2000/svg')
svg = ET.Element(S + 'svg', {'viewBox': '0 0 1440 800', 'width': '1440', 'height': '800'})
ET.SubElement(svg, S + 'rect', {'width': '1440', 'height': '800', 'fill': '#ffffff'})
defs = ET.SubElement(svg, S + 'defs')
mark = ET.SubElement(defs, S + 'marker', {'id': 'arrow', 'markerWidth': '8', 'markerHeight': '8',
    'refX': '7', 'refY': '4', 'orient': 'auto', 'markerUnits': 'strokeWidth'})
ET.SubElement(mark, S + 'path', {'d': 'M0,0 L8,4 L0,8 Z', 'fill': TEAL})
cells = {c.get('id'): c for c in root.findall('mxCell')}
def style_map(cell):
    return dict(part.split('=', 1) for part in cell.get('style', '').split(';') if '=' in part)
def rect(cell):
    g = cell.find('mxGeometry')
    return tuple(float(g.get(k, '0')) for k in ('x', 'y', 'width', 'height'))
for c in root.findall('mxCell'):
    if c.get('vertex') != '1':
        continue
    x, y, w, h = rect(c); st = style_map(c); label = c.get('value', '')
    fill = st.get('fillColor', 'none'); stroke = st.get('strokeColor', 'none')
    if fill != 'none' or stroke != 'none':
        a = {'x': str(x), 'y': str(y), 'width': str(w), 'height': str(h), 'rx': '12',
             'fill': fill, 'stroke': stroke, 'stroke-width': st.get('strokeWidth', '1.5')}
        if st.get('dashed') == '1': a['stroke-dasharray'] = '6 4'
        if c.get('style', '').startswith('rhombus;'):
            a.pop('x'); a.pop('y'); a.pop('width'); a.pop('height'); a.pop('rx')
            a['points'] = f'{x+w/2:g},{y:g} {x+w:g},{y+h/2:g} {x+w/2:g},{y+h:g} {x:g},{y+h/2:g}'
            ET.SubElement(svg, S + 'polygon', a)
        else:
            ET.SubElement(svg, S + 'rect', a)
    if label:
        lines = label.split('\n'); size = float(st.get('fontSize', 18))
        align = st.get('align', 'center'); px = x + 20 if align == 'left' else x + w - 20 if align == 'right' else x + w / 2
        a = {'x': str(px), 'y': str(y + h/2 - (len(lines)-1)*size*0.58),
             'fill': st.get('fontColor', INK), 'font-family': 'Arial, sans-serif', 'font-size': str(size),
             'text-anchor': {'left':'start', 'right':'end'}.get(align, 'middle'), 'dominant-baseline': 'middle'}
        if st.get('fontStyle') == '1': a['font-weight'] = 'bold'
        el = ET.SubElement(svg, S + 'text', a)
        for i, ln in enumerate(lines):
            ET.SubElement(el, S + 'tspan', {'x': str(px), 'dy': '0' if i == 0 else str(size*1.16)}).text = ln
for c in root.findall('mxCell'):
    if c.get('edge') != '1':
        continue
    st = style_map(c); a = rect(cells[c.get('source')]); b = rect(cells[c.get('target')])
    start = (a[0] + a[2]*float(st.get('exitX', '.5')), a[1] + a[3]*float(st.get('exitY', '.5')))
    end = (b[0] + b[2]*float(st.get('entryX', '.5')), b[1] + b[3]*float(st.get('entryY', '.5')))
    mid = [(float(p.get('x')), float(p.get('y'))) for p in c.findall('./mxGeometry/Array/mxPoint')]
    points = [start, *mid, end]
    orthogonal = [points[0]]
    for x, y in points[1:]:
        px, py = orthogonal[-1]
        if abs(px-x) > 0.1 and abs(py-y) > 0.1:
            orthogonal.append((x, py))
        orthogonal.append((x, y))
    points = orthogonal
    attr = {'points': ' '.join(f'{x:g},{y:g}' for x,y in points), 'fill': 'none',
            'stroke': TEAL, 'stroke-width': '2', 'marker-end': 'url(#arrow)'}
    if st.get('dashed') == '1': attr['stroke-dasharray'] = '8 5'
    ET.SubElement(svg, S + 'polyline', attr)
ET.ElementTree(svg).write(HERE / 'fig3-layout-preview.svg', encoding='utf-8', xml_declaration=True)

# OPML preserves semantic hierarchy only; cross-connections remain in draw.io.
opml = ET.Element('opml', {'version': '2.0'})
head = ET.SubElement(opml, 'head'); ET.SubElement(head, 'title').text = 'Fig. 3 governed operation'
body = ET.SubElement(opml, 'body')
top = ET.SubElement(body, 'outline', {'text': 'Fig. 3 — governed task-to-write operation', '_drawio_id': 'operation-background'})
branches = [
    ('Task', 'task-background', [('Production context: line, product, recipe, run', 'task-context'), ('Objective: process target', 'task-objective'), ('Optional team: lead and workers', 'team')]),
    ('Governed operation path', 'operation-header', [('Propose: node and value', 'propose'), ('Shared dispatch: scope and policy', 'dispatch'), ('Approval when required', 'approval'), ('Approved? Yes or No', 'decision'), ('Yes: route-specific revalidation after approval', 'revalidation'), ('No: stop or reject before driver call', 'rejected'), ('Write guard: configured constraints when applicable', 'guard'), ('Driver write', 'driver'), ('Process: device or twin', 'process'), ('Driver-stage error: device may have changed; reconcile before retry', 'driver-error'), ('No approval gate: bypass to write guard', 'bypass-label')]),
    ('Command evidence', 'evidence-title', [('Receipt or status, where recorded', 'receipt'), ('Status alone does not confirm device change', 'status-boundary'), ('Device readback, optional', 'readback')]),
    ('Process observation', 'observation-title', [('DAQ observation, when available', 'daq'), ('Goal assessment: next turn or stop', 'assessment')]),
]
for label, id_, children in branches:
    branch = ET.SubElement(top, 'outline', {'text': label, '_drawio_id': id_})
    for child, cid in children:
        ET.SubElement(branch, 'outline', {'text': child, '_drawio_id': cid})
ET.indent(opml, space='  ')
ET.ElementTree(opml).write(HERE / 'fig3-xmind.opml', encoding='utf-8', xml_declaration=True)
print('Wrote editable Fig. 3 sources')
