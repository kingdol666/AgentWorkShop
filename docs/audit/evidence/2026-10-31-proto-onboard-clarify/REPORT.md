# AgentWorkShop 澄清门轮验收报告(proto-onboard-clarify)

**时间**:2026-10-31 22:50~23:5x · **平台**:v0.8.8 · 3300(温态 home,生产附加模式,全程零重启作业)
**输入文档**:docs/audit/2026-10-31-b3-blowline-protocol-manual.md(3# 吹瓶产线 BC-3 协议与工况手册 v1.4,6 项未决事项)
**路径**:aw-protocol-onboarding skill:**预检 → 蓝图 → 澄清门(本轮新增)→ 能力匹配 → 配置 → 模拟跑通 → 导出验收 → 真实作业轮**

---

## 0. 结论(一句话)

**「有不懂的一定问用户」这一约束已写入 skill 并实跑验证**:2 轮 8 问(文档缺口/系统必需/意图确认)全部由用户作答并逐条映射到配置字段;文档→模拟端点→线/节点/配方→镜像采集→双写侧写穿→导出五项核对全绿;真实作业轮按用户明确选择的本地 9B 模型执行(明知不推荐的选项,如实测试如实记录)。

## 1. 澄清门(本轮核心新增,US-1/US-4)✅

- **skill 升级**:`skills/aw-protocol-onboarding/SKILL.md` 与 `.agents/skills/aw-protocol-onboarding/SKILL.md` 两副本逐字一致(diff=0),新增 §1.5 澄清门(A 文档缺口/B 系统必需/C 意图确认三类;`clarifications[]` 带 `mapsTo` 字段映射;用户选不推荐项时如实执行并标注风险);路径/红线/验收清单同步更新。
- **实跑记录**(evidence/clarifications.json):8 问 2 轮——
  | # | 类 | 问题 | 答复 | 落字段 |
  | --- | --- | --- | --- | --- |
  | 1 | C | 用哪份文档 | 新编吹瓶线手册 v1.4 | blueprint.sourceDoc |
  | 2 | A(B-1) | 瓶坯温度采样周期 | 1s | daq intervalMs=1000 |
  | 3 | A(B-3) | 吹气 SP 单步上限 | 0.10 bar | dcw stepLimit=0.1 |
  | 4 | C(B-5) | 16 点向量一期接入? | 一期接入 | 新建向量模板 ct-0b39ab45+向量节点 |
  | 5 | C(B-6) | 线命名空间 | PROTO3-B3-* | line/nodes 命名 |
  | 6 | B | 执行模式 | manual+预授权批准 | channel executionMode=manual |
  | 7 | B | 作业模型 | **本地 9B(明知不推荐仍选)** | channel llm=lm-studio/qwen3.5-9b-64k |
  | 8 | A(B-4) | 写冷却 | 0s | dcw holdIntervalMs=0 |
- 无一项关键配置凭空假设;用户答复可逐条追溯到配置 JSON。

## 2. 文档 → 模拟端点 → 供给(US-2/US-5)✅

- 设备模拟器 `scripts/_audit/proto-b3-device-4021.mjs` 严格按合同:HTTP 4021(PV×2+向量+模头 SP 写回)+ MQTT 18830(2s 环境多字段同报文 + cmd 订阅→250ms 内确认报文)。
- 连通预检 **6/6**(向量点经 REST 不可预检——test-driver 不透传 signalKind,已写进 skill;由供给后 verify-mirror 覆盖)。
- provision **14/14**:测试线 `ln-5402968a`、6 DAQ(含 16 点向量 `dn-3d2dd37e`、独立回读点 `dn-df726c9e`)、2 DCW、产品/配方 `rc-f6db68db`、批次 `rr-17d8a079` 开跑、采集总控 running。

## 3. 镜像采集 + 写穿 + 导出(US-6)✅

- **verify-mirror**:5 读侧节点全 PASS(熔体压力/瓶坯温度/环境温度/环境湿度/16 点向量),独立回读点写后 **3/3 PASS**。
- **HTTP 写侧**:212→213 **readback-verified**(回读 213=写值,anchor anc-b65d50ca)。
- **MQTT 写侧**(上轮未覆盖面,本轮首次纳入合同):2.6→2.7 transport-ack(anchor anc-176a8d87)+ 设备确认报文 + **独立 DAQ 回读点采到 2.7**——合同 §7-4「仅 transport-ack 不判成功」以三方一致满足。
- **负向限界**:STEP_LIMIT_EXCEEDED ×2(吹气 0.2>0.1/模头 4>2)+ NODE_RANGE_EXCEEDED(3.5>3.0 预警线)+ WRITE_INTERVAL_NOT_ELAPSED(60s 写闸)全拒。
- **导出五项核对**(daqexp-20261031231549-bb7802):值(回读 2.6/2.7 与设备确认一致)/量(环境 393+393@2s、向量 2448=153 帧×16 点)/时间(单调;**P3/P4 同报文时间戳重合 393/393**)/标识(6 节点归属本线)/清单(manifest+nodes/+frames/)。

## 4. 运行中发现(如实记录)

| # | 内容 | 级别 | 处置 |
| --- | --- | --- | --- |
| F-1 | **holdIntervalMs 语义误配**:文档"两次写变更间隔≥1s"被映射为保写心跳 holdIntervalMs=1000 → 心跳写持续刷新 60s 在线写闸(WRITE_INTERVAL),人工写被饿死;保写心跳与 WRITE_INTERVAL 共闸是设计张力 | P2(配置映射)+ 设计注记 | PATCH 0 后写通;skill 已写入该语义 |
| F-2 | **dcw http 写驱动仅 POST**(method 不可配)+ 回读只认顶层 bodyKey 字段——合同 PUT/嵌套信封不匹配 | P3(已知能力面) | 网关别名(设备接受 POST+写应答平铺);skill 已写入 |
| F-3 | test-connection 首跑打默认 3001(lib 缺省),须显式 AW_BASE;skill §0 已有此步,执行时漏了 | P4 操作 | 补 AW_BASE 重跑 |
| F-4 | 9B lead 首次 spawn PROCESS_EXIT → **D1 兜底 23:21:15 复活**(机制生效);23:25 二次 PROCESS_EXIT + **compact 链**(Already compacted→等待超时 120s 放行)——66k 上下文 × 工业工具面的历史模式实时复现 | 观测(模型能力,非平台缺陷) | 见 §5 |
| F-5 | **停滞催办刷新预算 → 预算兜底饿死**:静默模型陷入"催办→重投→再催办"循环,30min 预算 55min 未结算;操作员经 cancel 端点收口 | P2(设计张力) | 建议平台:催办不刷新预算或催办次数上限强制收口 |

## 5. 真实作业轮(US-7)——9B 按用户选择如实测试

频道 `f8906572`(模板 chtpl-generic-optimize-default,4 Agent,绑定 4 条:2 daq+1 dcw+1 recipe,全 manual),llm=`lm-studio/qwen3.5-9b-64k`,执行模式 manual,种子任务 66732095(读数巡检+小步写+独立回读+收口)。

**执行实录**(23:19 派发 → 00:16 操作员收口):

| 时刻 | 事件 |
| --- | --- |
| 23:19:33 | 频道锻造 7/7(模板实例化+插件开关+4 绑定 nb-*/种子任务派发) |
| 23:19:33 | lead 首次 spawn **PROCESS_EXIT**(Harness 重建 lease=bd07b2b2) |
| 23:21:15 | **D1 兜底生效**:排队根滞留 SUBMITTED → 复活 lead+投递 assign;任务转 WORKING |
| 23:25:02 | 二次 **PROCESS_EXIT**(lease=1aeb163b)→ 重建 |
| 23:27-23:28 | **compact 链**:`Already compacted` → `等待超时(120000ms)→ 放行` —— 66k 上下文 × 工业工具面压缩churn |
| 23:30~23:57 | 停滞看门狗 6 次催办(300s 周期,全部被消费)—— **零助手文本/零任务进展/零审批请求/零设备写** |
| 00:1x | 30min 预算未结算:**催办重投刷新预算 → 兜底被饿死**(新发现 F-5) |
| 00:16 | 操作员经 `POST /api/workshop/tasks/:id/cancel`(平台正道"手动回收卡死任务")收口 → **CANCELED** |

**判定(按账本,不按自报)**:9B(qwen3.5-9b-64k,66k ctx)在工业频道全量工具面下 **55 分钟零进展**——任务账本中虽有 ~200 条工具活动条目,但全部**偏离绑定工具面**(幻觉不存在的工具名如 `xd://mcp__kb_mcp_line_context_read` ×8、重复扫描 kb 文档、用 python eval 模拟传感器数据、web_search),**绑定的 daq/dcw 工具从未被调用**;零助手文本、零审批请求、零设备写,叠加两次进程退出与压缩churn。这是**盲动(blind flailing)而非沉默**——比"零调用"更能说明 9B 无法在工具面纪律下作业。HITL manual 模式未被触发(没有一笔合法写审批产生,预授权批准器全程待命零动作)。**这与历史判定一致且加强:9B 不能胜任全量工具面的频道作业;ustc/deepseek-flash 仍是自主工具作业的最低可用档。** 平台侧防御(D1 复活/停滞看门狗/台账为准+操作员回收)全部按设计工作——失败在模型,不在平台。

**本轮新发现(F-5)**:停滞催办的重投会刷新根预算,静默模型形成"催办→刷新→再催办"循环,预算兜底被饿死——建议平台评估"催办不刷新预算"或"催办次数上限后强制收口"。

## 6. 判定

- **澄清门约束进 skill + 文档驱动全链配置**:**PROVEN**(2 轮 8 问全答复→映射→配置→验收全绿)。
- **MQTT 写侧覆盖**:**PROVEN**(transport-ack + 确认报文 + 独立回读三方一致)。
- **9B 作业轮**:**如实负结果**——9B 不能胜任(55min 零产出,CANCELED 收口);平台防御全部生效;用户澄清选择被完整尊重并如实记录。
- **遗留**:F-1(保写心跳 vs 写闸)与 F-5(催办刷新预算)两个设计张力建议平台排期;导出 job 的 title/note 经 curl -d 内联中文存在 GBK 风险(已知坑,本轮复现,建议脚本一律 --data-binary @file)。

## 7. 资源清单(本次创建,收尾按此清单)

- 线 `ln-5402968a`(PROTO3-B3-文档驱动接入线);产品 pd-3002d21b;配方 rc-f6db68db;批次 rr-17d8a079(CANCELED 收口后批次状态以台账为准)
- DAQ:dn-812822ad / dn-0f7c8b75 / dn-767e0a6c / dn-f9ea1045 / dn-df726c9e / dn-3d2dd37e
- DCW:dw-87e3e89d(holdIntervalMs 已修正为 0)/ dw-a282d05f
- 向量模板 ct-0b39ab45;频道 f8906572(4 agents,任务 66732095=CANCELED);绑定 nb-5fc758d6/nb-a6eee777/nb-4a16dd7d/nb-378789c9
- 设备模拟器 scripts/_audit/proto-b3-device-4021.mjs(4021/18830,保留作为证据端点);批准器 D:/tmp/proto3-approver.mjs(已收口)

*证据:evidence 目录(clarifications.json/blueprint.json/export 五件套/writes/)+ 平台台账(anchors/journal/任务)+ 设备日志(/d/tmp/proto-b3-device-4021.log)+ 审批留痕(/d/tmp/proto3-approvals.log)。*
