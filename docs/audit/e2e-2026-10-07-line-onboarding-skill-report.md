# e2e-2026-10-07 · 产线接入与作业频道锻造 skill(aw-line-onboarding)开发与端到端验收报告

> 需求:①复核 Channel Agent 数据采集/下发 recipe 控制/IDD 诊断入库/KB 检索的全功能真实可行性(含 MES API 与 PLC 协议集成);②基于平台架构做一个 skill——用户给 MES API 文档/PLC 协议接入文档/产线背景资料,自动接入产线(连接测试、上下限完备)、自动创建节点/绑定/配方,并按作业场景(闭环优化找工艺区间/纯数据分析诊断/工艺稳定性微调)自动创建最佳适配频道;③多专家讨论 → 计划 → 开发 → 用例端到端测试。
> 结论:**全部落地并验收通过。** skill 已入库(skills/aw-line-onboarding/),五脚本辅助(scripts/onboarding/),用例 E2E 五阶段全绿(9/9→12/12→6/6→19/19→Agent 腿闭合)。

---

## 1. 阶段一:能力实证(回答"是否真实可行")

**可行,全链路均有本日实测证据(非推断):**

| 能力 | 实证 |
| --- | --- |
| 数据采集 | 五协议活读:Modbus TCP 227.0(8 点/分)、Modbus RTU 4.5、OPC-UA 18.62、MQTT 55.4、HTTP 0.12;tsdb 落库可查 |
| 数据控制(下发) | R2 大考:五要素提案 ap-68eebebe → HITL 批准(choice=0)→ 整批下发 rr-f4a4d929 → PLC 回读 z2/z3=227 精确命中 → 熔体 192→207.8 收敛;台账锚点可溯 |
| IDD 诊断+KB | sentinel_screen/watch 全窗分析;经验文档 exp-e96d71b3b177 入库(keep);KB 检索 5 案佐证提案 |
| 产线管理 | 线启停/批次运行门(无活动批次拒试验)/四层限界(量程∩参数∩产品∩配方)/单步上限 fail-closed/权限 v2(直写禁用,必须绑配方)/权限 v3(线域 grant) |
| MES API 集成 | 目录 mes_catalog(3 点位,读/写/史能力)→ 实时读(8.23/55)→ **实写回环**:recipe_trial→HITL 批准→mes-rest 驱动落值 55→60 |
| 治理门(负向全对) | Agent 直写节点被权限 v2 拒;无活动批次 trial 被运行门拒;越界写被量程层拒;超单步被 param 层拒 |

## 2. 阶段二:四专家并行讨论(结论摘要)

- **专家A·平台盘点**:7 类 dcw 驱动 + daq 侧同构;`test-driver` 连接测试端点两侧齐备;`dcw/params access` 一键建点;配方四层限界+单步上限在 param-limits.ts 统一校验;trial 仅 Agent 工具面(REST 无)。缺口:无批量导入 API、driverConfig 字段文档化低、无驱动目录 API。
- **专家B·skill 形态**:仓库约定 `skills/<name>/SKILL.md`(scripts/test-aw-skills.mjs 校验:须引 ≥6 个 aw_* MCP 工具、编号步骤≥4 等);脚本与指令分工=「脚本做确定性 REST,指令做文档理解」;幂等用指纹标签;驱动字段提取清单逐驱动给出。
- **专家C·场景剧本**:三个场景完整设计(拓扑/治理档/绑定/插件/种子任务/KPI/回退),并确认模板 instantiate 承载大部分配置,缺口(idd 插件开关/节点绑定/种子任务)由 skill 后置步骤补。
- **专家D·验收设计**:**film-line/cast-film-physics/biax-line 是整包替换型预设,验收禁用**;injection-line 增量共存(11 DCW+14 DAQ,端口与演示线全隔离);模拟器 `GET /api/nodes/:id/export` 可导出每信号 driver+driverConfig(充当"协议文档");7 步验收剧本与 <15min 预算。

## 3. 阶段三:最佳实践计划(综合四专家,已按此实现)

1. **skill 定位**:`aw-line-onboarding` 为顶层编排——"从文档到可作业频道";与既有 `aw-node-bind`(节点深潜)、`aw-opt-channel`(AML 双模式闭环)互补并互相引用。
2. **分工铁律**:AI 读文档生成 driverConfig(缺字段必问不猜);逐点操作走 aw_* MCP 工具;批量供给/验收走 scripts/onboarding 五脚本(吃配置 JSON,不理解文档)。
3. **五阶段工作流**:连通性预检(未全绿不供给)→ 产线供给(线+节点+上下限+stepLimit+配方,指纹幂等)→ 场景化频道锻造(三场景决策矩阵)→ 六组验收 → 治理红线与回滚。
4. **三场景矩阵**(optimize/diagnose/tuning):模板(controlPolicy)、绑定面(manual/auto、只读零写)、插件(idd+rag)、种子任务、KPI/守恒判据、回退路径逐一固化进 SKILL.md。

## 4. 阶段四:交付物

| 文件 | 说明 |
| --- | --- |
| `skills/aw-line-onboarding/SKILL.md` | 主指令:输入识别(五类文档分型)/驱动字段提取清单表/三场景决策矩阵/六步工作流/红线与回滚/验收清单;校验器 82 PASS/0 FAIL |
| `scripts/onboarding/lib.mjs` | 登录/api/断言计数/指纹幂等/受保护资源硬拦(ln-d7e0a2a2)/轮询器 |
| `scripts/onboarding/test-connection.mjs` | 逐驱动连通性预检(五协议+mes-rest),任一红即退 1 |
| `scripts/onboarding/provision-line.mjs` | 建线+DCW/DAQ 节点(量程/stepLimit/templateRef)+产品+配方,幂等复用,可选开跑;输出 JSON 摘要 |
| `scripts/onboarding/forge-channel.mjs` | 模板实例化(按 scenario 选默认)→团队插件→Agent 绑定($RECIPE/$DAQ:name 引用)→线域授权→种子任务 |
| `scripts/onboarding/verify-line.mjs` | V1 数采落库(五协议滑动窗)~V6 受保护线零扰动,六组断言 |

开发中依实况修正的契约(已固化进脚本,亦是平台接入知识):**节点必绑模板**(dcw/daq templateRef 必填,语义映射规则入 SKILL.md);**配方必归属产品**(脚本自动建默认产品);**采样由批次驱动**(逐产线运行门:未开跑的线零采样——供给脚本提供 startLine);**响应信封** `{data.test}`(test-driver);**V3 探针必须写前实时取值**(开批次后引擎驱动 SP,配置期探针会过期;只写命令点回退用 journal 锚点值)。

## 5. 阶段五:用例端到端(注塑验收线,五协议)

**用例**:把 plc-node-simulator 的 injection-line(机筒 Modbus TCP:16052/模具 RTU:15052/注塑 OPC-UA:5843/冷却水 MQTT:18830/检测 HTTP:4010-sim-http)当作"用户给了协议文档的新产线",从 export 提取 9 个点位(4 SP 写控+5 PV 数采),走完 skill 全流程:

| 阶段 | 结果 |
| --- | --- |
| S1 预设 | injection-line 增量应用:5 原有设备原样保留 + 5 台 inj-* 新设备;事先快照场景 aw-accept-045030 |
| S2 连通性 | **9/9**(五协议全部读到真实值:240/40/85/24/31.28) |
| S3 供给 | **12/12**:线 ln-902bc976 + 4 dw + 5 dn + 产品 pd-64487ead + 配方 rc-ce3894ed;二次运行全部走复用(幂等实证) |
| S4 锻造 | **6/6**:频道 66daef02(chtpl-generic-optimize-default 四人剧组)+ idd/rag 插件开启 + 3 绑定(worker:2 绑配方 manual、worker:0 绑 MeltTemp/PartWeight daq auto)+ 种子任务(budget 60min) |
| S5 验收 | **19/19**:V1 五节点采样落库(开批次即出数)·V2 四点越界全拒(报"超出节点工艺安全量程")·V3 四点合法写回环(读回一致:192→199/60→64/75→80/25→27)·V4 配方在册·V5 绑线/4 成员/插件生效·V6 **15 条写锚点全落新线,受保护演示线零外溢** |
| S6 Agent 腿 | 绑定 worker 发起 recipe_trial(+7=单步上限)→ HITL 卡 ap-5c0dcbe6 → 批准 → **PLC 回读 199 精确命中** |
| S7 自主演练(加分项) | 新频道 omp 剧组自主分解种子任务为 3 子任务:知识调优工程师完成"机理知识检索与五要素调优提案"(kb_agent QDCVR 四轮检索),并在取数窗为空时**主动拒绝提案**("未收到数据判读前不得凭空定步幅")——治理纪律经频道提示词完整传导;演示线1 熔体 208.1 健康 |

**期间被平台治理正确拦截的四类误操作**(验收的另一半价值):越界写(量程层)、超单步跳变(param 层)、60s 写间隔限速、配置期探针过期——全部 fail-closed 且报错指明约束层。

## 6. 使用方法(用户视角)

```
# 把协议文档给助手并说场景,例如:
# "这是注塑线的 Modbus/OPC-UA 点位表(附件),帮我接入并建一个闭环优化找工艺区间的频道"
# 助手执行 aw-line-onboarding skill:
node scripts/onboarding/test-connection.mjs conn.json     # 阶段2 连通性
node scripts/onboarding/provision-line.mjs provision.json # 阶段3 供给(输出 id 摘要)
node scripts/onboarding/forge-channel.mjs  forge.json     # 阶段4 场景频道(引用 $RECIPE/$DAQ:名)
node scripts/onboarding/verify-line.mjs    verify.json    # 阶段5 六组验收(19 断言)
```

## 7. 残留与建议

- **trial 无 REST 端点**:候选试验仅 Agent 工具面(脚本验收用 HITL apply 替代);建议平台补 `POST /dcw/recipes/:id/trial`。
- **驱动字段无目录 API**:driverConfig 字段说明散在源码/表单;SKILL.md 已内置字段表,建议平台补 `GET /api/workshop/dcw/driver-catalog`。
- **daq 模板语义有限**:9 内置模板无"克重/流量"类;本验收以最近标量模板代配,长期建议自定义模板落库。
- 模拟器 mqtt 命令点只写不可读(read 返 null)——verify 的锚点回退已兼容;真实设备如有回读寄存器建议配 readMap。

## 8. 门禁汇总

skill 校验器 82/0 · eslint(onboarding) 0 错 · L1 44/44(收尾抽测) · E2E S2~S6 全绿(9/9,12/12,6/6,19/19,Agent 腿闭合) · 受保护演示线零扰动(V6=15:0)。
