# S7 历史证据离线复算手册

复核日期：2026-11-19。仅重算本地归档中的记录，不连接网络、平台、模拟器或设备，不重放任何写入请求。下方命令可直接在 Git Bash 中执行；需要 Python 3.12（本次为 3.12.7），仅用标准库。

## 输入、完整性与来源

- 输入：本目录 `supplementary/Supporting-Evidence-S7-20261112.zip`；与 `../TII-SUBMISSION-PACKAGE-FINAL/supplementary/` 和 `../TII-SUBMISSION-PACKAGE-20261112/supplementary/` 的同名 ZIP 逐字节一致（19,954,381 B；SHA-256 `42c522ae51b6cdf1ac861f52e2022f2e4f53d1ff53b4f3433c86c5599b0794a3`）。外层 290 个成员，除清单自身外 289/289 与 `00-metadata/MANIFEST-SHA256.txt` 相符。这是输入一致性，不是对历史采集的认证。
- 归档 `tools/recalculate_e6.py` 已作为文本检查，未执行。它只取 `paired-summary.csv`，不积分；且读取 `condition`/`scenario`，实表列名为 `arm`/`scene`，直接运行不能复现有效对数。以下代码从 `samples.csv` 重算，事后才与汇总核对。`tools/source-snapshot/e6-paired.mjs` 中 `computeMetrics` 与样本写出逻辑仅作静态参考；运行段会使用历史服务，因此未执行。核查时少量文件曾隔离到单独的临时目录，仅作数据文本读取，核查后删除；下方命令不解包，嵌套 ZIP 也仅在内存中读取。不要复用历史 `reproCmd` 或运行归档脚本。
- E6 所选批 `01-quantitative/e6/selected-post-pilot-batch/run.json`：`202611062020-e6-paired`，报告 Git `e5398281`，UTC 结束 `2026-11-06T21:47:03.940Z`，块 `2..12/12`。`plan.json` 冻结时间 `2026-11-06T18:37:54.561Z`，置 `sha256=null` 后紧凑序列化重算得 `e9ba4b47ccc07fcf65ed0fe381ad1366ced767b43b0bed71071de336a84acff0`，与计划及运行记录一致。
- `tools/source-snapshot/e6-paired.mjs` 与 `scenarios.mjs` 的归档 LF 字节用 `\n%%\n` 连接，SHA-256 为 `05cb89cc075b4180a3ca1430bd25c19ed09640ae2c3879aeb2695b5da532fc0d`；只将 `scenarios.mjs` 恢复为 CRLF，再连接，得运行记录自报 `b0b826cd0b7e48c9353361ad23fe39b4f81e02e43f0ac27eb94185ded41f96a9`。本地 Git 对象 `88134efadf204244b6881da8bd02e82b48db5c25` 中的 `bench/experiment/e6-paired.mjs`、`bench/lib/scenarios.mjs` 与对应 LF 快照逐字节一致；这只是候选来源匹配，不证明当时执行或部署的字节，也没有完整的服务/模拟器镜像和配置。
- 下文 `core:`、`followup:` 分别表示外层 `07-source-archives/S7-core.zip`、`07-source-archives/S7-followup.zip` 内的文件。外层清单覆盖嵌套 ZIP 的现存字节；嵌套旧清单并非全部匹配：core 50/66、followup 16/17、`S7-audit-20261108.zip` 30/32、`S7-e6-e7-2026-11-07.zip` 142/145。core 和 followup 本文所用的映射及守卫原始记录通过内层核对；E6/E7 子包的 3 处差异在 `run.json`（包括 E6 所选批及 pilot）；所选批的 22 个样本文件、配对 CSV 和 run JSON 与外层对应成员逐字节一致，不计作重复试验。审计子包的 28 个早期 E6 文件与外层对应成员一致。不能从清单推断旧版未变更或恢复缺失证据。

## E6：保留窗口、IAE 和无效对

C0 为不写入，C1 为确定性脚本策略。对每臂由 `bucket_at` 与 `offset_s` 恢复并校验 `t0`，核对 `reset.json` 的初值、设定点异常和错误标志；按候选算法对 `[-2,H+2]` 内样本排序，要求至少 10 点、首点不晚于 2 s、末点不早于 `H−2`。相邻间隔 ≤5 s 时，从 `ceil(t_left)+1` 起插入严格早于右端的整秒线性插值点；间隔 >5 s 标记无效，不插值。只取 `[0,H]` 内点并检查点数至少为 `0.9H`（不是连续采样覆盖率）；在保留点的 `|PV−目标|` 上做梯形积分，不外推到 `0` 或 `H`。无效臂的原有算法仍会对相邻保留点做梯形求和（可能跨大缺口），因此其 IAE 仅用于逐字段对账，不进入配对差或中位数。每臂先按历史口径保留三位小数，再算 `ΔIAE = C0−C1`。

| 场景 | 名义 H | 目标 / 容差 | 初值窗 | 有效对 | ΔIAE 中位；范围 |
|---|---:|---|---|---:|---|
| 注塑 `injection` | 180 s | 32.5 ± 0.35 g | [30.75, 31.75] g | 3/3 | 165.165；162.535–195.169 g·s |
| 废水 `wwtp` | 240 s | 3.4 ± 0.6 mg/L | [−0.1, 0.6] mg/L | 3/4 | 615.605；611.670–630.980 (mg/L)·s |
| 退火 `anneal` | 240 s | 95 ± 6 HV | [131.7, 137.7] HV | 3/4 | 8000.450；7930.200–8084.150 HV·s |

`01-quantitative/e6/selected-post-pilot-batch/<块>/<臂>/samples.csv` 是数值输入。下表窗为实际积分首末时间（秒），而非名义窗口。22/22 臂的复算 IAE 和有效标记均与同臂 `metrics.json` 及 `paired-summary.csv` 一致。所有保留批臂均通过初值和两端检查；有效臂窗内点数分别为 180 或 240。

| 记录块 ID | C0 积分窗 (s) | C1 积分窗 (s) | C0 IAE | C1 IAE | ΔIAE / 判定 |
|---|---:|---:|---:|---:|---|
| `block-02-wwtp-seed43` | 0.674–239.674 | 0.945–239.945 | 763.170 | 147.565 | 615.605 |
| `block-03-anneal-seed43` | 0.926–239.926 | 0.617–239.617 | 9497.350 | 1567.150 | 7930.200 |
| `block-04-injection-seed44` | 0.256–179.256 | 0.876–179.876 | 224.050 | 58.885 | 165.165 |
| `block-05-wwtp-seed44` | 0.924–239.924 | 1.000–239.493 | 759.340 | 147.670 | 611.670 |
| `block-06-anneal-seed44` | 0.856–239.856 | 0.040–239.040 | 9481.900 | 1481.450 | 8000.450 |
| `block-07-injection-seed45` | 0.588–179.588 | 0.932–179.932 | 223.015 | 60.480 | 162.535 |
| `block-08-wwtp-seed45` | 0.248–239.248 | 0.792–240.000 | 763.015* | 179.725 | 无效：C0 150.248→159.248 s，缺口 9 s，窗内 232 点 |
| `block-09-anneal-seed45` | 0.385–239.385 | 0.948–239.948 | 9488.150 | 1404.000 | 8084.150 |
| `block-10-injection-seed46` | 0.159–179.159 | 0.447–180.000 | 223.585 | 28.416 | 195.169 |
| `block-11-wwtp-seed46` | 0.154–240.000 | 1.000–239.158 | 764.141 | 133.161 | 630.980 |
| `block-12-anneal-seed46` | 1.000–240.000 | 1.000–240.000 | 9504.392* | 1017.338 | 无效：C0 11.534→17.534 s，缺口 6 s，窗内 235 点 |

\* 仅为存档数值重算，不是有效估计。两臂同时有效才计一对，故 **9/11 有效，9/9 有效对的 ΔIAE 为正**，不是 9/12。原便利 `report.md` 及 `run.json:perScene` 把两组无效对计入，不能用其废水/退火 4/4 或中位数。

早期 `earlier-batch`：`block-02-wwtp-seed43`、`block-03-anneal-seed43`、`block-05-wwtp-seed44`、`block-06-anneal-seed44` 没有曲线，两臂复位失败；`block-07-injection-seed45` 只有 C1 复位记录。早期 `block-04-injection-seed44` 两臂则有效，独立积分为 223.020 / 29.700 g·s，差 193.320 g·s；后批同场景、同 seed 为 165.165 g·s，不能当成独立重复，没有可核验的重启或择批规则。Seed 43 注塑 `block-01-injection-seed43` 不并入：`pilot` 只有 C1 复位；`pilot2`–`pilot5` 的 ΔIAE 分别为 −0.215、0.000、−0.440、163.240 g·s，run ID 按序 `202611061905-e6-paired`、`202611061914-e6-paired`、`202611061937-e6-paired`、`202611061959-e6-paired`。`pilot2`–`pilot4` 的 C1 无记录写入，后两次记录超时；`pilot5` 是随附勘误单列的试跑。类别、单位和批次均不合并；无写入不是 PID/MPC 基线；这是小样本探索性仿真，不能证明 LLM 或物理产线效果，也不做显著性、优越性或泛化判断。

## 场景—协议映射重数

按 `(scene, protocol, nodeId, signal)` 去重数配置端点，按记录中 `probeClass`、HTTP 状态及响应码重数；合法含 `legal` 与 `boundary`，不计 `restore`。仅对带数值的合法回读从 `readback`/`value`/`tolerance` 独立校验。以下分场景使用 `02-governance/scene-protocol/retained/scenario-protocol-probes.csv`，run `20261106180144-scenario-probes`（seed 42；窗宽比例 0.8；自报 harness `83922926eeca72eb`）。

| 场景 | 端点 | Modbus TCP / RTU / OPC UA / MQTT / HTTP | 合法受理 | 结构拒绝 | 配方窗拒绝 | 可用回读一致 |
|---|---:|---|---:|---:|---:|---:|
| 注塑 | 11 | 5 / 2 / 3 / 1 / 0 | 44/44 | 44/44 | 22/22 | 44/44 |
| 废水 | 7 | 1 / 3 / 2 / 1 / 0 | 28/28 | 28/28 | 14/14 | 28/28 |
| 退火 | 7 | 3 / 2 / 1 / 1 / 0 | 28/28 | 28/28 | 14/14 | 28/28 |
| 双向拉伸 | 30 | 20 / 1 / 8 / 0 / 1 | 120/120 | 119/119 | 60/60 | 116/116 |
| 合计 | **55** | **29 / 8 / 14 / 3 / 1** | **220/220** | **219/219** | **110/110** | **216/216** |

603 行 = 165 普通合法 + 55 合法边界 + 219 结构 + 110 配方窗 + 54 收尾。合法受理为 HTTP 200/`accept`；结构拒绝为 HTTP 400/`NODE_RANGE_EXCEEDED`；配方窗拒绝为 HTTP 400/`RECIPE_LIMIT_EXCEEDED`。双向拉伸 OPC UA 节点 `dw-cb63367d` 仅 3 条结构记录；不能把 219/219 写成 220/220。HTTP 节点 `dw-1aa61f25` 的四条合法记录没有回读（`legal` 三条、`boundary` 一条），应分开报告 216/220 有回读、216/216 有回读者一致，不把缺失当一致或失败。

| 归档批/记录 ID | 可用数据和重数结果（不合并） |
|---|---|
| `20261101121221-scenario-probes` | `core:01-paper-evidence/scenario-protocol-probes-20261101121221.csv`，493 行；55 端点，220/220、219/219、216/216；未收集窗记录（不是 0%）。自报 `da627d21` / `a66769851fa03de5`。 |
| `20261105060237-scenario-probes` | `followup:20261105060237-scenario-probes/scenario-protocol-probes.csv`，603 行；上述三项和配方窗 110/110 均与 11-06 保留批计数相同，但为不同记录；自报 `3f30a146` / `047818ab79d61b83`。 |
| `20261106173851-scenario-probes` | `02-governance/scene-protocol/early-failed-window60/`，配方窗 60/110（仅双向拉伸拒绝预期命中）；50 个窗刺激返回 HTTP 200。 |
| `20261106174659-scenario-probes` | `02-governance/scene-protocol/early-failed-window96/`，配方窗 96/110（退火 0/14）；14 个窗刺激返回 HTTP 200。 |

早期两失败批均有相同的 55 端点、220/220 合法、219/219 结构及 216/216 可用回读计数，不能被保留批抹去。另 `core:02-c3-pilot-negative/false-pass-run.json` 的 `20261102103125-scenario-probes` 虽标 `pass=true`，但场景数为 0、各分母为 0，不能纳入；S7 叙述另有被排除的单一流延薄膜批，本表不把叙述中的 24/24/20 当本次原始行重数。映射和判定共用配置，仅说明测试到的模拟器/API 路径；完整计划矩阵不齐，基准态计数也不能证明生产态节拍、步长或保持窗执行。

## 守卫记录重数

- **工艺窗四臂消融。** `core:01-paper-evidence/process-window-ablation.csv`（同目录 `process-window-ablation-run.json` 的 `env.startedAt=2026-11-01T10:35:19.207Z`，`da627d21`）；以及外层 `02-governance/e1-guard-fixture/e1-lite.csv`（同目录 `run.json` 的 `env.startedAt=2026-11-06T17:06:52.093Z`，`e5398281`）。均为 seed 42、每臂 3 次、`configHash=3a57e722d4764b98`；run JSON 未给独立 `runId`，以时间及成员路径识别。每份 CSV 384 条请求 = 72 负例 + 36 名义合法 + 36 边界 + 240 计时请求。下表是**各批分别**得到的同一组计数；不把计时项或 JSON 中 12 条分组汇总行加入分母。边界预期由 `arm × value` 独立判定：205 受理，205.1/174.9 仅在有工艺窗的两臂预期拒绝。

| 臂 | 负例 HTTP 400 | 其中结构探针拒绝 | 窗违规 HTTP 200 | 合法误拦 | 边界符合 |
|---|---:|---:|---:|---:|---:|
| `full` | 18/18 | 12/12 | 0/6 | 0/9 | 9/9 |
| `no-interlock` | 12/18 | 12/12 | 6/6 | 0/9 | 9/9 |
| `no-readback` | 18/18 | 12/12 | 0/6 | 0/9 | 9/9 |
| `ungated` | 12/18 | 12/12 | 6/6 | 0/9 | 9/9 |

这是 mock 驱动、基准态 HTTP 观察，HTTP 200 不能重标为驱动到达、实际执行或写入日志；逐请求驱动/服务器台账未归档。未施加回读失配，不辨认回读守卫的贡献。

- **生产语义分支。** 外层 `02-governance/e4-production-guards/e4-defense-layers.csv`，`20261106181553-production-guards`：基线值 189 受理（200）；5/5 个预期分支码命中：L5 `429 WRITE_INTERVAL_NOT_ELAPSED`、L4 `409 STEP_LIMIT_EXCEEDED`、L2 `400 NODE_RANGE_EXCEEDED`、L3 `400 RECIPE_LIMIT_EXCEEDED`、L6 `429 WRITE_FREQUENT`。`core:01-paper-evidence/production-guards.csv`（`20261101113644-production-guards`）基线值 190，亦为 5/5。外层 `e4-production-guards-older/`（`20261106181124-production-guards`）基线值 190；5 个负例均为非 200，但仅 4/5 命中预期分支：L5 返回 `WRITE_FREQUENT`、未隔离出节拍拒绝，归档判定未通过。这些是单次分支夹具，不是生产拒绝率。
- **回读故障。** `02-governance/e5-readback-fault/readback-mismatch.json`（`20261106173845-readback-mismatch`，节点 `dw-9d7f2f39`）及 `followup:20261105060514-readback-mismatch/readback-mismatch.json`（`20261105060514-readback-mismatch`，节点 `dw-ce8da5f5`）各有 3 条：基线 209→209、恢复 251→251，均 `200/ok=true/readback-verified`；故障 230→251，`200/ok=false/unverified`，命令差 21 > 容差 0.7。另一次读取同一模拟节点也为 251，故 `independentDelta=0`，并非命令差，也不是硬件独立观察。两批不合并为可靠性估计。
- **审批与授权。** `core:01-paper-evidence/approval-gate-run.json`（`20261101121436-approval-gate`）结构化 4 条：手动通过前后 202→204.8、延迟 10593 ms；手动拒绝 216→216、544 ms；自动 202→204.8、10071 ms 及 216→218.8、10073 ms。脚本模拟决策，自动臂标签与实际起点不能构成匹配对，不代表人审或因果效应。`core:01-paper-evidence/authorization-run.json`（`20261101121415-authorization`）结构化 3 条：未绑定、跨节点各拒一条，绑定对照受理一条；三条 HTTP 均为 200，按应用层 `got` 判断。选 JSON 而非直接数这两份旧 CSV 的物理行，后者在文本字段内含换行。

以上只涵盖 S7 中可以定位的历史记录；没有重新采集数据、评估真实设备安全，或声称验证了 E7 的服务端流水。

## 执行命令（标准库、只读 ZIP）

```bash
ZIP='D:/codes/ABO/AgentWorkShop/paper/tii/TII-SUBMISSION-PACKAGE-DAQ-REPRO/supplementary/Supporting-Evidence-S7-20261112.zip'
python -I -X utf8 - "$ZIP" <<'PY'
from collections import Counter, defaultdict
from decimal import Decimal as D
from hashlib import sha256
from io import BytesIO, StringIO
from math import ceil, floor, fsum
from pathlib import Path
from statistics import median
from zipfile import ZipFile
import csv, json, sys

H = lambda data: sha256(data).hexdigest()
J = lambda arc, name: json.loads(arc.read(name))
def C(arc, name):
    return list(csv.DictReader(StringIO(arc.read(name).decode('utf-8-sig'))))

def e6(z, path, plan):
    names = set(z.namelist())
    blocks = sorted({n[len(path):].split('/')[0] for n in names if n.startswith(path+'block-')})
    summary = {(r['block'],r['arm']): r for r in C(z,path+'paired-summary.csv')} if path+'paired-summary.csv' in names else {}
    assert len(summary) == (len(C(z,path+'paired-summary.csv')) if summary else 0)
    totals, by_scene = Counter(), defaultdict(list)
    matched = 0
    print('\nE6', path, J(z,path+'run.json')['runId'] if path+'run.json' in names else '')
    for block in blocks:
        _, block_id, scene, seed = block.split('-')
        spec = plan['scenes'][scene]; T = spec['horizonS']; lo, hi = spec['initWindow']
        edge, max_gap = plan['edgeTolS'], plan['maxGapS']
        totals[scene] += 1; arms = {}
        for arm in ('C0','C1'):
            p = f'{path}{block}/{arm}/'
            reset = J(z,p+'reset.json') if p+'reset.json' in names else {}
            if p+'samples.csv' not in names:
                print(block, arm, 'no samples', 'fatal reset' if 'fatal' in reset else reset.get('initOk'))
                continue
            reset_ok = reset['initOk'] and lo <= reset['initPv'] <= hi and not (reset['spBad'] or reset['errors'])
            raw = C(z,p+'samples.csv')
            clocks = {int(r['bucket_at'])-int(D(r['offset_s'])*1000) for r in raw}
            assert len(clocks) == 1
            zero = clocks.pop()
            points = sorted(((int(r['bucket_at'])-zero)/1000,float(r['value'])) for r in raw)
            assert len({t for t,v in points}) == len(points)
            pts = [(t,v) for t,v in points if -edge <= t <= T+edge]
            assert len(pts) >= 10  # all archived arms with trajectories met this minimum
            grid, gaps = [], []
            for (a,u),(b,v) in zip(pts,pts[1:]):
                grid.append((a,u)); dt = b-a
                if dt > max_gap:
                    gaps.append(tuple(round(x,3) for x in (a,b,dt))); continue
                grid.extend((t,u+(v-u)*(t-a)/dt) for t in range(ceil(a)+1,ceil(b)))
            grid.append(pts[-1])
            win = [(t,abs(v-spec['target'])) for t,v in grid if 0 <= t <= T]
            valid = bool(reset_ok and pts[0][0] <= edge and pts[-1][0] >= T-edge and len(win) >= 0.9*T and not gaps)
            area = fsum((b-a)*(u+v)/2 for (a,u),(b,v) in zip(win,win[1:]))
            iae = D(floor(area*1000+0.5))/1000
            met, row = J(z,p+'metrics.json'), summary[str(int(block_id)),arm]
            assert row['scene'] == scene and row['seed'] == seed[4:]
            assert iae == D(str(met['iae'])) == D(row['iae']) and valid == met['valid'] == (row['valid']=='true')
            arms[arm] = iae,valid; matched += 1
            print(block,arm,'IAE',f'{iae:.3f}','window',win[0][0],win[-1][0],'points',len(win),'valid',valid,'gaps',gaps)
        if len(arms)==2 and all(valid for _,valid in arms.values()):
            delta = arms['C0'][0]-arms['C1'][0]
            by_scene[scene].append(delta); print('pair',block,f'{delta:.3f}')
    for scene, ds in by_scene.items():
        print('summary',scene,len(ds),totals[scene],median(ds),min(ds),max(ds),sum(d>0 for d in ds))
    print('arms matched',matched)

def matrix(z, name, run):
    rs = C(z,name)
    print('\nmatrix',J(z,run)['runId'],name,len(rs),Counter(r['probeClass'] for r in rs))
    for scene in sorted({r['scene'] for r in rs}):
        rr = [r for r in rs if r['scene']==scene]
        eps = {(r['protocol'],r['nodeId'],r['signal']) for r in rr}
        legal = [r for r in rr if r['probeClass'] in ('legal','boundary')]
        struct = [r for r in rr if r['probeClass']=='structural']
        window = [r for r in rr if r['probeClass']=='window']
        read = [r for r in legal if r['readback']!='']
        checks = [(legal,lambda r:r['status']=='200' and r['got']=='accept'),
                  (struct,lambda r:r['status']=='400' and r['code']=='NODE_RANGE_EXCEEDED'),
                  (window,lambda r:r['status']=='400' and r['code']=='RECIPE_LIMIT_EXCEEDED'),
                  (read,lambda r:abs(D(r['readback'])-D(r['value'])).quantize(D('.0001'))<=D(r['tolerance']))]
        print(scene,len(eps),Counter(p for p,_,_ in eps),[(sum(test(r) for r in grp),len(grp)) for grp,test in checks])
        if scene=='biax':
            print('missing readback',[(r['nodeId'],r['probeClass'],r['value']) for r in legal if r['readback']==''])
            print('structural count <4',[(n,k) for n,k in Counter(r['nodeId'] for r in struct).items() if k<4])

def ablation(z, name, run):
    rs = C(z,name); env = J(z,run)['env']; print('\nablation',name,env['startedAt'],len(rs))
    for arm in ('full','no-interlock','no-readback','ungated'):
        rr = [r for r in rs if r['arm']==arm]
        neg = [r for r in rr if r['case']=='attack']
        window = [r for r in neg if r['kind'] in ('above-window','below-window')]
        hard = [r for r in neg if r not in window]
        legal = [r for r in rr if r['case']=='legit']
        edge = [r for r in rr if r['case']=='boundary']
        expected = lambda r: '400' if D(r['value'])!=205 and arm in ('full','no-readback') else '200'
        print(arm,[(sum(test(r) for r in grp),len(grp)) for grp,test in (
            (neg,lambda r:r['status']=='400'),(hard,lambda r:r['status']=='400'),
            (window,lambda r:r['status']=='200'),(legal,lambda r:r['status']!='200'),
            (edge,lambda r:r['status']==expected(r)))])

def production(z, name, run):
    expected = {'L2':'NODE_RANGE_EXCEEDED','L3':'RECIPE_LIMIT_EXCEEDED','L4':'STEP_LIMIT_EXCEEDED',
                'L5':'WRITE_INTERVAL_NOT_ELAPSED','L6':'WRITE_FREQUENT'}
    rr = C(z,name); print('production',J(z,run)['runId'],[(r['layer'],r['value'],r['status'],r['code']) for r in rr],
                          sum(r['code']==expected.get(r['layer']) for r in rr),'/5')

def readback(z, name):
    d = J(z,name); print('readback',d['runId'],d['node']['id'],d['tolerance'])
    for r in d['steps']:
        print(r['step'],r['status'],r['ok'],r['ack'],r['value'],r['driverReadback'],r['independentRead'],
              r['driverReadback']-r['value'],r['independentRead']-r['driverReadback'])

archive = Path(sys.argv[1]); digest = H(archive.read_bytes()); print('SHA-256',digest)
assert digest == '42c522ae51b6cdf1ac861f52e2022f2e4f53d1ff53b4f3433c86c5599b0794a3'
with ZipFile(archive) as z:
    manifest = [line.split('  ',1) for line in z.read('00-metadata/MANIFEST-SHA256.txt').decode().splitlines() if line]
    names = z.namelist(); assert len(set(names)) == len(names) == 290
    assert {p for _,p in manifest} == set(names)-{'00-metadata/MANIFEST-SHA256.txt'}
    assert len(manifest)==289 and all(H(z.read(p))==h for h,p in manifest)
    print('outer members verified',len(manifest))
    prefix = '01-quantitative/e6/'; plan = J(z,prefix+'plan.json')
    plan_hash = H(json.dumps(plan|{'sha256':None},separators=(',',':'),ensure_ascii=False).encode())
    run = J(z,prefix+'selected-post-pilot-batch/run.json')
    assert plan_hash==plan['sha256']==run['planSha256']; print('plan hash',plan_hash)
    a,b = [z.read('tools/source-snapshot/'+n) for n in ('e6-paired.mjs','scenarios.mjs')]
    print('candidate LF',H(b'\n%%\n'.join((a,b))))
    h = H(b'\n%%\n'.join((a,b.replace(b'\n',b'\r\n')))); assert h==run['harnessHash']; print('candidate mixed LF/CRLF',h)
    for batch in ('selected-post-pilot-batch','earlier-batch','pilot','pilot2','pilot3','pilot4','pilot5'):
        e6(z,prefix+batch+'/',plan)
    gov = '02-governance/'; src = '07-source-archives/'
    for batch in ('retained','early-failed-window60','early-failed-window96'):
        p = gov+'scene-protocol/'+batch+'/'
        matrix(z,p+'scenario-protocol-probes.csv',p+'run.json')
    ablation(z,gov+'e1-guard-fixture/e1-lite.csv',gov+'e1-guard-fixture/run.json')
    for batch in ('e4-production-guards','e4-production-guards-older'):
        p = gov+batch+'/'
        production(z,p+'e4-defense-layers.csv',p+'run.json')
    readback(z,gov+'e5-readback-fault/readback-mismatch.json')
    with ZipFile(BytesIO(z.read(src+'S7-core.zip'))) as c:
        p = '01-paper-evidence/'
        matrix(c,p+'scenario-protocol-probes-20261101121221.csv',p+'scenario-protocol-probes-run.json')
        ablation(c,p+'process-window-ablation.csv',p+'process-window-ablation-run.json')
        production(c,p+'production-guards.csv',p+'production-guards-run.json')
        d = J(c,p+'approval-gate-run.json'); print('approval',d['runId'],[(r['arm'],r['decision'],r['executed'],r['before'],r['after'],r['latencyMs']) for r in d['rows']])
        d = J(c,p+'authorization-run.json'); print('authorization',d['runId'],[(r['case'],r['status'],r['expect'],r['got']) for r in d['rows']])
        d = J(c,'02-c3-pilot-negative/false-pass-run.json'); print('excluded empty matrix',d['runId'],len(d['scenes']),d['totals'],d['pass'])
    with ZipFile(BytesIO(z.read(src+'S7-followup.zip'))) as f:
        p = '20261105060237-scenario-probes/'
        matrix(f,p+'scenario-protocol-probes.csv',p+'run.json')
        readback(f,'20261105060514-readback-mismatch/readback-mismatch.json')
    for n in ('S7-core.zip','S7-followup.zip','S7-audit-20261108.zip','S7-e6-e7-2026-11-07.zip'):
        with ZipFile(BytesIO(z.read(src+n))) as q:
            ns = set(q.namelist())
            if 'manifest.json' in ns:
                pairs = [(r['path'],r['sha256']) for r in J(q,'manifest.json')['files']]
            elif 'SHA256SUMS.json' in ns:
                pairs = list(J(q,'SHA256SUMS.json').items())
            else:
                pairs = [(p,h) for h,p in (ln.split(maxsplit=1) for ln in q.read('SHA256SUMS.txt').decode().splitlines() if ln)]
            print('inner manifest',n,sum(p in ns and H(q.read(p))==h for p,h in pairs),'/',len(pairs))
PY
```
