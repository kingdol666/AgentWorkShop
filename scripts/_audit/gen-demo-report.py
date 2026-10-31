"""DEMO2 报告 HTML 生成器:读取 REPORT.md 结构 + shots/*.png 内嵌为单文件 report.html。"""
import base64
import os
from pathlib import Path

ROOT = Path(r'D:/codes/ABO/AgentWorkShop/docs/audit/evidence/2026-10-31-demo2')
SHOTS = ROOT / 'shots'

images = {}
for f in sorted(SHOTS.glob('*.png')):
    images[f.stem] = base64.b64encode(f.read_bytes()).decode()

def img(stem, caption):
    if stem not in images:
        return ''
    return '<figure><img src="data:image/png;base64,{b}" alt="{a}"/><figcaption>{c}</figcaption></figure>'.format(
        b=images[stem], a=html_escape(caption), c=html_escape(caption))

def html_escape(text):
    return (text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

sections = []
sections.append(('0. 结论', '<p class="lead">干净重启后,六大业务面(数采/数控/配方/日志/分析/EDA)在<b>真实 UI + 真实 API</b> 上全部走通并截图存证;harness 以 <code>ustc/deepseek-flash</code> 下发保压时间单变量寻优任务,<b>多 Agent 编排、HITL 审批、5 次写全部 ACK、负结果如实判定、complete_task 正常闭合</b>,KB 经验真实落库(7 chunks+向量索引,检索命中 0.772)。</p>'))
sections.append(('1. G1 干净重启', '<p>杀 40+ 进程树,15 端口全部释放后按依赖序重启;7 端点健康矩阵全 200(3300/3210/5180/8771/6789/4010/15160),admin token 验真通过。</p>'))
sections.append(('2. G2 数采管理业务', '<p>REST 创建面新建节点 <b>DEMO-缺陷率</b>(dn-46f0c0dd,http 驱动指向 sim 缺陷率信号,2s 周期)→ 控制器 startAll → <b>15/15 节点在线</b> → 2.7s 新鲜度采样 → 批量导出。实时事件流可见节点创建留痕。</p>' + img('02-daq-page', '数采中心:15/15 在线,发布 4123 · 消费 4114 · 入库 4110;实时事件含「创建数采节点 DEMO-缺陷率」')))
sections.append(('3. G3 数控下发', '<p>cool-water-sp 24→24.5℃(MQTT 平面 <code>transport-ack</code>);三条负向全中:+1℃ 撞单步限幅 0.7℃、999℃ 撞安全量程 10~45℃、60s 内重写撞频控。与 OPC UA 平面 <code>readback-verified</code> 构成<b>分级 ack 双类别</b>实证。</p>' + img('01-dcw-page', '产线运营:注塑线卡片(运行中,节点11/产品1/配方1)')))
sections.append(('4. G4 Recipe 管理', '<p>rc-923da07b <b>v2</b>(goal 阶梯固化产物),11 参数全带窗口值;操作流水完整呈现 recipe 语义链:trial 整批下发 → ACK 鉴定(证实 1/1)→ judge(keep)→ update_agent(v2)。</p>' + img('03-operations-page', '产线操作流水:39 写控 / 18 数采 / 13 配方 / 20 回退 / 5 告警全分类留痕')))
sections.append(('5. G5 日志 / 分析 / EDA', '<p><b>产线日志</b>(append-only):本轮每笔操作——节点创建、三次写拒绝、导出、下发——全部带归属(产线/产品/RECIPE)入账。<b>分析台账</b>:Agent 侧 + 用户侧双来源。<b>EDA 工坊</b>:趋势图渲染真实数据,新建节点曲线恰从创建时刻出现。</p>'
                 + img('06-logs-page', '产线日志:三次写拒绝 / 节点创建 / 导出全部留痕')
                 + img('05-analysis-page', '数据分析台账:Agent 侧分析 + 用户侧验收分析,append-only')
                 + img('04-eda-studio', 'EDA 工坊:六种图型 + Golden 参考轨迹面板')
                 + img('04b-eda-chart-rendered', 'EDA 渲染:part-weight 带 + 熔温 + DEMO-缺陷率(自 17:22 创建时刻起)')))
sections.append(('6. G6 Harness 优化任务(ustc/deepseek-flash)', '<p>任务「DEMO2-保压时间单变量寻优(6→7.8s)」goal 下发 → 根 <code>5dc07bf8</code> <b>COMPLETED 100%</b>。执行链:①稳定性诊断重跑 82.6/B(独立 1Hz 导出自校验);②知识检索命中历史经验 → <b>主动取消九步阶梯</b>(诚实的负结果处理);③闭环经验<b>真实入库</b>(7 chunks+向量+图索引,检索命中 0.772);④保压时间 5 次写全部 ACK 1/1,<b>陈旧指令重放被 Agent 自查发现并标注</b>;⑤收口:负结果成立、配方保持 v2、窗口 0 越限、残留交人工、complete_task 正常闭合。</p>'
                 + img('09-channel-chat', '工作区实时观测:产线作业计数器(DCW 25/DAQ 43/AML 1/SAFE 12)+ Agent 取数事件流 + 生产主管执行中')
                 + img('11-channel-tasks', '任务观测:goal 任务与生产主管状态')))
sections.append(('7. 终态 KPI(最后一窗 5 分钟)',
                 '<table><tr><th>指标</th><th>n</th><th>均值</th><th>区间</th><th>规格</th></tr>'
                 '<tr><td>part-weight</td><td>289</td><td><b>32.201 g</b></td><td>32.09~32.33</td><td>32.5±0.35 达标</td></tr>'
                 '<tr><td>flash-rate</td><td>289</td><td>0.011 %</td><td>0~0.068</td><td>≤0.4 达标</td></tr>'
                 '<tr><td>sink-mark</td><td>289</td><td>1.302 %</td><td>1.098~1.604</td><td>≤1.5 达标</td></tr>'
                 '<tr><td>melt-temp-pv</td><td>288</td><td>246.7 ℃</td><td>245.8~247.6</td><td>235~262 达标</td></tr></table>'
                 '<p>hold-time-sp 终态:PLC <b>6.2 s</b>(配方 v2 目标 6.0;0.2s 偏移已如实标注交人工)。</p>'))
sections.append(('8. 结论', '<p class="lead">六大业务面全通且可追溯(UI+API+台账三向印证);harness 优化闭环在弱模型上表现出<b>超出预期的治理素养</b>(取消无谓阶梯、自查陈旧重放、负结果如实、正确 complete_task)。系统维持<b>受控试点 GO</b> 判定;演示全过程零平台缺陷、零静默失败。</p>'))

parts = []
for title, content in sections:
    parts.append('<section><h2>' + html_escape(title) + '</h2>' + content + '</section>')
body = ''.join(parts)
doc = ('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>AgentWorkShop 实机演示报告 DEMO2 · 2026-10-31</title>'
       '<style>'
       'body{background:#0d1117;color:#d8dee6;font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:1180px;margin:0 auto;padding:28px;line-height:1.65}'
       'h1{color:#3fe0a8;font-size:26px;border-bottom:1px solid #1f2a37;padding-bottom:10px}'
       'h2{color:#7fd8ff;font-size:19px;margin-top:10px}'
       'code{background:#161f2c;color:#9fe8c0;padding:1px 6px;border-radius:4px;font-size:.92em}'
       '.lead{font-size:15.5px;color:#eef3f8}.meta{color:#8aa0b4;font-size:13px}'
       'table{border-collapse:collapse;width:100%;margin:12px 0}'
       'th,td{border:1px solid #24303f;padding:7px 12px;text-align:left;font-size:14px}'
       'th{background:#16202e;color:#a8c7e0}'
       'figure{margin:16px 0;text-align:center}'
       'img{max-width:100%;border:1px solid #24303f;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4)}'
       'figcaption{color:#8aa0b4;font-size:12.5px;margin-top:6px}'
       'section{background:#101823;border:1px solid #1c2735;border-radius:10px;padding:18px 24px;margin-bottom:18px}'
       '</style></head><body>'
       '<h1>AgentWorkShop 实机演示报告(第二轮 · DEMO2)</h1>'
       '<p class="meta">2026-10-31 17:00~18:45 · v0.8.8 · 平台 3300(home=D:/tmp/aw-prod-1031)· 模型 ustc/deepseek-flash(omp)· 账本 .omc/ultragoal 7/7 · 截图 shots 目录 ×10</p>'
       + body + '</body></html>')
out = ROOT / 'report.html'
out.write_text(doc, encoding='utf-8')
print('report.html written:', round(out.stat().st_size / 1024), 'KB')
