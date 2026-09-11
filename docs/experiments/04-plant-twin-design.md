# 数字孪生试验台方案 · 挤出流延薄膜产线物理模型（plc-node-simulator 升级计划）

> 日期：2026-09-09 · 关联：`docs/experiments/00-MASTER-PLAN.md`（E1–E6）、`bench/README.md`（AW-IndustrialBench）
> 回答的问题：**没有真实产线数据时，能否用 plc-node-simulator 的数字孪生模拟验证 AgentWorkShop 的算法架构并产出 TII 级实验？——可以，本方案给出"模拟什么、怎么模拟、数据怎么生产"的完整设计。**

---

## 0. 可行性判断（先给结论）

| 问题 | 判断 |
|---|---|
| 模拟 PLC 通信 + 数采/数控/检测节点 + 绑定 + Agent 操控 | ✅ **已具备**。五协议从站与主项目全链路 e2e 已打通（`scripts/e2e-integration.mjs`），SP 写回灌（writebackTarget）就是"真实 PLC 控制语义" |
| 下发控制 → 产线对应响应 → 工艺/检测参数联动改变 | ⚠️ **部分具备**。单回路一阶惯性 PV→SP 收敛已有；跨回路是瞬时表达式，**缺纯滞后、缺动态耦合、缺质量/能量守恒因果** |
| 找最佳 Recipe / 最佳工艺窗口 | ✅ 适合。且模拟器有个真实产线没有的杀手锏：**最优窗口可以由模型离线预计算成 ground truth**，Agent 找到的窗口能与真值定量对比——这比真实产线的实验还可控 |
| 数字孪生验证对 TII 是否够 | ✅ **够，但要补一块**：模型校准节（说明参数来源：文献典型值 + 一阶参数辨识），加一台真设备 HIL（E6）兜底。审稿人接受 "high-fidelity simulation testbed"，只歧视 "ad-hoc simulation" |

**结论：可行。核心增量 = 在 plc-node-simulator 中新增「工艺模型层 plant-model」**，让所有信号值不再是独立策略生成，而是从一个物理状态方程组积分出来。

---

## 1. 模拟什么场景：挤出流延薄膜产线（Cast-Film Extrusion）

选它的理由：① 与模拟器现有「薄膜产线预设」语义对齐，改动最小；② 流延挤出是文献最充分的连续工艺之一（一阶惯性 + 纯滞后 + MIMO 耦合三要素齐全，教科书级）；③ 因果链丰富且**可写进论文的物理公式简单可信**；④ 天然有"工艺参数 → 检测参数"两层（熔体工艺量 + 在线测厚/CCD 品质量），完全覆盖你要求的三类数据。

### 1.1 因果结构图（这是整个孪生的灵魂）

```
控制量(DCW 写)                     过程状态(物理方程积分)                 采集量(DAQ 读)
─────────────                     ────────────────────                 ─────────────
T1 加热区SP  ──┐
T2 加热区SP  ──┼─→ 熔体温度 Tm  ←── 一阶惯性×3 + 区间热传导 + 纯滞后 τm  ──→ 熔体温度计 (℃)
T3 加热区SP  ──┘        │
                        │ 粘度 μ = A·exp(B/Tm)  (Arrhenius, 温度↑粘度↓)
螺杆转速SP N ──→ 熔体流量 Q = k·N·ρ·(1/μ 缩放) ──→ 熔体压力 P = Q/Kp(一阶+滞后) ──→ 熔体压力计 (MPa)
                        │                                              ──→ (压力波动统计)
牵引线速SP v ──┐        │
口模间隙SP  g ──┴→ 膜厚 h = C·Q/(v·ρ)   (质量守恒: 流量被线速拉成膜)      ──→ 在线测厚仪 (μm)
                        │                                              ──→ 厚度横向轮廓 profile
                        └→ 品质(检测帧): CCD 缺陷率 = α·(Tm−T*)² + β·Var(P) ──→ CCD 缺陷率 (%)
                                         晶点数 = f(Tm 过高)                ──→ 晶点计数 (个/m²)
```

关键的真实物理耦合（论文里最有说服力的三条）：
1. **温度↔压力负耦合**：升温 → 粘度按 Arrhenius 指数下降 → 同转速下流量↑ → 但熔体泵送特性使压力响应含负向分量——单看直觉会调反，Agent 必须靠数采证据理解；
2. **质量守恒定厚**：h = C·Q/(v·ρ)，转速与线速**联合**决定厚度——单变量调不到最优，逼出多变量协调（T3 场景）；
3. **纯滞后 τ**：物料从模口到测厚仪有输送延迟（按线速计算 τ = L/v，**控制量改变时滞后本身会变**）——这是真实工艺最难的部分，也是区分"能闭环"和"只会瞎调"的试金石。

### 1.2 完整节点/信号映射表（对接 AgentWorkShop 的建库清单）

| 节点 | 类型 | 协议 | 寄存器/变量 | 量程 | 单位 |
|---|---|---|---|---|---|
| zone1-sp / zone2-sp / zone3-sp | DCW | Modbus TCP | 40021/23/25 | 120–260 | ℃ |
| screw-speed-sp | DCW | OPC UA | ns=2;s=AW.N.Sp | 50–200 | rpm |
| line-speed-sp | DCW | MQTT | aw/sim/lineSp | 20–120 | m/min |
| die-gap-sp | DCW | HTTP | /api/diegap | 0.5–2.0 | mm |
| melt-temp | DAQ | Modbus TCP | 40001 | 0–300 | ℃ |
| melt-pressure | DAQ | OPC UA | ns=2;s=AW.P | 0–30 | MPa |
| film-thickness | DAQ | MQTT | aw/sim/thick | 0–200 | μm |
| thickness-profile | DAQ(帧) | HTTP | /api/profile | — | 多点轮廓 |
| ccd-defect-rate | DAQ(帧) | HTTP | /api/ccd | 0–100 | % |
| gels-count | DAQ | Modbus RTU | 40001 | 0–500 | 个/m² |

（每节点配套语义卡：含义/单位/安全量程/配方窗口——喂给 Agent 的就是这些，不是寄存器。）

---

## 2. 怎么模拟：plant-model 引擎层设计

### 2.1 架构：在现有引擎旁边加一层，不动协议层

```
现在:  每信号独立策略(sine/first-order/expression) ──→ 协议暴露
改后:  DCW 写入 → writeback(已有) ──→ plant-model.step(dt)   ← 唯一新增
                                        │ 欧拉积分状态方程组
                                        └──→ 覆写各 DAQ 信号值 ──→ 协议暴露(不变)
```

源码锚点（plc-node-simulator）：
- `src/server/engine/plant-model.ts`（**新增**，纯函数：状态 {Tm1..Tm3, P, Q, h} + 控制输入 + dt → 新状态，带 transport-delay 环形缓冲）
- `src/server/runtime.ts` 每 tick 调 `plantModel.step()`（在信号推进之前，用模型输出覆写绑定信号的当前值）
- `src/server/presets.ts` 新增 `cast-film-physics` 预设（设备+信号+模型参数一键生成）
- `src/shared/types.ts` 增加 `plantModel` 配置段（参数全部可配，见 2.3）
- 既有 first-order 策略与表达式保留——plant-model 未启用的信号照旧，**向后兼容**

### 2.2 状态方程（写进论文 §Model 的公式）

每 tick（dt=500ms，欧拉积分）：

```
(1) 加热区温度   dTm_i/dt = (Tsp_i − Tm_i)/τT + k_heat·(Tm_{i−1} − Tm_i)/τT   i=1..3, τT≈90s
(2) 熔体温度     Tm = Tm_3(t − τm)，τm ≈ 20s（螺杆输送混合滞后）
(3) 粘度         μ = μ0·exp(B·(1/Tm − 1/Tm0))，B≈2200K（Arrhenius，文献典型值）
(4) 熔体流量     Q = kn·N·(μ0/μ)^0.4   （转速正比，温度通过粘度部分补偿）
(5) 熔体压力     dP/dt = (Q/Kp − P)/τP，τP≈8s（泵送腔一阶）
(6) 膜厚         h = C·Q/(v·ρ_solid)，经测量段延迟 τh = L/v（v 变则 τh 变）
(7) 厚度轮廓     profile(x) = h·(1 − κ·x̂²)·(1 + g 偏差项 + 噪声)，x̂∈[−1,1]
(8) 缺陷率       defect = clip(α·((Tm−T*)/10)² + β·σ_P + γ·max(0, Tm−255)² , 0, 100)
(9) 晶点         gels = clip(δ·max(0, Tm−250)²·0.1 + Poisson 噪声, 0, 500)
扰动: 进料温度慢漂移(随机游走, 影响 τT 有效值 5%)、电源波动(乘性噪声 0.5%)
```

参数全部落在文献典型范围（TII 论文模型节可引用挤出教材），并留一组「校准旋钮」：对真实设备做一阶阶跃响应辨识拟合 τT/τP/Kp——**即使没有产线，用公开数据集或教材曲线图数字化拟合也可写"parameter identification"一节**。

### 2.3 可信度三件套（决定审稿人买不买账）

1. **物理一致性验收测试**（加进 `npm test`）：阶跃 T2 SP +20℃ → Tm 在 3τT 内收敛且超调 <5%；N +20rpm → h 上升幅度 = 模型解析解 ±2%；v +10% → τh 反比缩短且 h 下降 9.1%（=1/1.1）；关掉 T3 加热 → Tm 缓慢下降且 P 先升后降（粘度效应滞后）——**这些断言就是"模型符合真实物理规律"的证明**，直接可引用为论文实验。
2. **确定性 seed**：高斯噪声用可播种 PRNG，bench 重复实验可复现。
3. **模型-真值对账导出**：plant-model 每 tick 把**真实状态值**（未加噪）与**协议暴露值**（加噪后）写双列 JSONL——评测时用真值列当 ground truth，加噪列才是 Agent 看到的世界。

---

## 3. 数据怎么生产（数采 / 数控 / 检测全覆盖）

| 数据类别 | 生产机制 | 落点 |
|---|---|---|
| 工艺数采 | Tm/P/v 等由状态方程积分 + 传感器噪声 + 标定(scale/offset) | AgentWorkShop DAQ → Timescale（`daq` 五维打标） |
| 检测数采 | 厚度轮廓/CCD 帧走既有 daq_frames 管线（模板 sink → MinIO） | `daq_frames` 表 + 对象存储 |
| 数控 | Agent dcw_control → 真实协议写模拟器寄存器 → writeback → 模型下一 tick 响应 | `dcw-writes.json` + decision_log |
| 检测/判定 | Agent daq_query 取窗口统计 → dcw_judge keep/rollback | RecipeRollBackManager + 越限兜底 |
| 工况标签 | plant-model 的真值流（未加噪状态 + 当前最优窗口） | bench 的 ground truth 文件 |

**运行工况脚本**（模拟"真实生产"的时间结构，避免恒定工况的假）：预热段（冷态→工艺窗口 15min）→ 稳产段（窗口内 + 慢漂移）→ 换批段（recipe 切换 → 过渡动态）→ 扰动段（进料波动/加热器衰减 10%——模拟设备老化）。这四段就是 E1–E5 的标准试验时序。

## 4. 怎么找最佳 Recipe / 工艺窗口（闭环目标设计）

**目标函数（Agent 的任务，也是评分标准）**：
```
maximize  J = w1·达标率( |h−50μm|≤2 ) + w2·(1−defect%) − w3·能耗(∝N²) − w4·切换代价
约束:  Tm∈[195,225]℃, P≤22MPa(安全), 各 SP∈配方窗口(联锁), v≤120(设备上限)
```

**两阶段验证法（方案的核心优势）**：
1. **离线真值**：对模型做网格搜索/解析优化，得到全局最优窗口 W*（例如 Tm=212℃, N=120rpm, v=85m/min 时 J 最大）——孪生独有，真实产线做不到；
2. **在线寻优**：Agent 团队从次优起点出发，经 N 轮「dcw_control → daq_query → dcw_judge → recipe_update」收敛；
3. **评分**：Agent 收敛窗口 W_agent 与 W* 的距离、J(W_agent)/J(W*)、收敛轮数、越界次数、回退次数——**全部可量化，直接进论文表格**（对应 bench T1/T3 任务 + 新增 T6 窗口寻优任务）。

## 5. 与 TII 实验矩阵的衔接

| 实验 | 孪生提供的增量 |
|---|---|
| E1 治理消融 | F5 越界写在孪生上有真实后果（压力超安全线 → 模型里 P 响应） |
| E2 调度 | 换批段的多目标协调对调度器构成真压力 |
| E3 记忆 | 预热段/换批段的动态记忆可复用 |
| E5 异常检测 | 慢漂移/加热器衰减扰动 = 天然的漂移检测数据集（带真值） |
| E6 HIL | 孪生先行，真设备只验证接口与单回路 |
| **新增 E7 窗口寻优** | W_agent vs W* 定量对比——孪生独有的实验，论文最亮的点 |

## 6. 实施排期（约 2 周，插在 P1 与 P2 之间可并行）

| 天 | 工作项 | 验收 |
|---|---|---|
| D1–3 | plant-model.ts 状态方程 + transport delay + 确定性 PRNG | 单测：§2.3 四条物理一致性断言通过 |
| D4–5 | runtime.ts 接线 + cast-film-physics 预设 + 真值/暴露双列导出 | 预设一键生成 → 主项目手动建 5 DAQ + 5 DCW + 配方 → 开跑见联动 |
| D6–7 | 跨项目 e2e 升级：写 screw-speed SP → 观察 P/h/defect 联动断言 | `e2e-integration.mjs` 新增 8 断言全绿 |
| D8–9 | 工况脚本四段时序 + 噪声/扰动参数化 + bench 对接（fixture 调用预设导出） | bench/W-castfilm 配置可跑 T1/T3 |
| D10 | 离线网格搜索 W* 工具（`scripts/offline-optimum.mjs`） | W* 报告 + 灵敏度热力图（论文图） |
| D11–14 | （机动）模型参数辨识节 + T6 任务模板 + E7 配置 | E7 冒烟 10 runs 通过 |

## 7. 局限性与论文话术（诚实声明反而加分）

- 模型是**集总参数**（lumped-parameter）一阶+滞后近似，不含空间分布动力学 → 论文写法："we adopt a first-order-plus-dead-time (FOPDT) MIMO model, the standard abstraction for supervisory-layer agent evaluation"；
- 噪声为高斯+慢漂移，未模拟脉冲型强非线性扰动 → 由故障注入器 F1–F6 补齐；
- 结论范围：验证**监督层算法架构**（治理/调度/记忆/寻优），不声称验证底层控制回路——这恰与主项目"监督层定位"声明完全自洽。
