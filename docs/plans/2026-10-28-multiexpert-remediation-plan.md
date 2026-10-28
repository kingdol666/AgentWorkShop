# 多专家设计审查整改计划(P0×2 + P1×11)—— 修复 / 验收 / 上线判定

- 日期:2026-10-28
- 输入:`docs/audit/2026-10-28-multiexpert-design-review.md`(P0×2 已亲验 / P1×11 / P2×28)
- 状态:**实施中**(本文件同时是验收规范;结果写入 `docs/audit/2026-10-28-multiexpert-remediation-acceptance.md`)
- 非目标:28 项 P2 不逐条实施(按域分批随版本);本轮只做"阻断生产上线"的 P0/P1,并在验收报告中如实列出 P2 遗留。

---

## 一、修复策略(按审查的共同主题)

| 主题 | 涉及条目 | 统一修法 |
|---|---|---|
| 检查点与生效点之间隔着 await | B-P1-1 / B-P1-2 / B-P1-4 / A-P1-2 | await 后**重验状态/快照**;或先**原子占位(claim)**再 await |
| 缓存与信号失效路径 | C-P1-1 / C-P1-2 / C-P1-3 | 生命周期先行摘除 + 失败路径 finally 清理 + 单一回写点 |
| 治理不变式入口不对称 | B-P1-3 | 摘闸门(manual→auto)只走 `resolveModeChange` 单一入口,委派面同样 confirm + 审计 |
| 双后端语义等价 | D-P1-1 / D-P1-2 | 补 Timescale 列与分页 + "双后端同输入同输出"契约测试;迁移改为 schema 驱动重建 |

---

## 二、验收规范(AE 条目,逐条可执行)

> 判定口径:每条 AE 必须由**新跑的**命令/测试输出或工件佐证;不接受"看起来对"。
> 单测文件统一放 `tests/`;可复用夹具,但断言必须直指本条缺陷的触发序列。

### AE-1(P0-1)Modbus 字节序三序一致
- `decodeRegisters` 对 float32=1.0 在三种字节序下的寄存器布局:ABCD→`[0x3F80,0x0000]`、CDAB→`[0x0000,0x3F80]`、DCBA→`[0x0000,0x803F]` 解码均得 1.0。
- `encodeWords` 与 `decodeRegisters` 在三序 × {float32,int32,uint32} 上**互为逆运算**(round-trip 误差 0)。
- 旧实现会错的用例被显式断言:CDAB 设备值走 `little` 必须**不再**返回 2.27e-41(以 1.0 断言)。
- UI 目录标签:`little` = 小端(DC BA),`wordSwap` = 字交换(CD AB),与实现一致。

### AE-2(P0-2)掩码凭据不得回写
- DAQ:GET 投影为 `******`;以 GET 结果整包 PATCH(含掩码)后,仓储内真实口令**逐字节不变**;提供新明文则正常更新;`******` 以外的掩码变体(`******` 精确匹配)不得误伤。
- DCW:同型断言。
- 掩码过滤发生在后端单点(merge 前),前端无需配合。

### AE-3(A-P1-1)帧指标告警跨帧保持
- 帧指标越 alarm 硬限后,连续 N 帧仍在限外:节点态持续 `alarm`(不被每帧抹回 `ok`)。
- 指标恢复后:节点态回 `ok`(或 `warn`),与告警面板规则态一致。
- 标量路径行为零变化。

### AE-4(A-P1-2)停线补种不被乱序游标吞掉
- retained-only 设备:批次 A 采到样本 → 停线(缓存最新值)→ 换批 B → 补种必须以**补种时刻**为时间戳入库,`ConsumeVerdict=ok`,批次 B 至少有 1 条样本。
- 旧行为(用缓存到达时刻,判 `late` 且 `runSeeded=true`)被显式反向断言。

### AE-5(A-P1-3)外部 ingest 与驱动路径同一 sink 管线
- 图像节点:外部 ingest 后 `daq_frames.meta.thumbKey` 存在(模板声明 thumbnail 处理器时),sha256/size 由服务端计算而非信任请求。
- 向量节点:模板 `deriveMetric` 处理器产出的指标出现在帧指标里(请求未提供该指标)。
- 与驱动/推送路径共用 `processFrameSample`(代码层面单点)。

### AE-6(B-P1-1)系统兜底回退 await 后重验
- 构造:captureMetrics 挂起期间(a)人工写入 `judge.uncertain`;(b)记录被关闭;(c)同节点出现更新的 open 记录 → 恢复后**不得**产生任何回退写(PLC 写次数 0),且不覆盖人工判定。
- 正常路径(无干扰)仍能自动回退(反向断言,防"修死")。

### AE-7(B-P1-2)配方频控并发原子性
- 同一配方并发两次 agent 下发:恰 1 次进入写入,另 1 次 429/明确拒绝;写入次数 = 1;第二次的失败不留下半写。
- 试验节拍:并发两次 trial 只放行 1 次。
- 顺序调用且间隔已满足时仍放行(opIntervalMs=0 或已过期)。

### AE-8(B-P1-3)委派不得静默摘 HITL
- lead 以 `mode=auto` 委派且无 `confirm:true` → 拒绝(文案含"摘除人工审批闸门"),绑定面零变更。
- 带 `confirm:true` → 落库 auto,`ops_log` 出现 `binding.mode`/委派审计记录。
- 未指定 mode → 目标绑定为 `manual`(不继承 lead 的 auto)。

### AE-9(B-P1-4)recipe_update 审批后定义比对
- 快照:进入 HITL 前记录配方定义指纹(version + 目标参数值集合)。
- 审批窗口内配方被并发编辑 → 批准后 update **拒绝执行**并返回"审批期间配方已变更,请重新读取后重提";配方定义不变。
- 无并发编辑 → 正常保存新版本。

### AE-10(C-P1-1)停机窗口不假送达
- `stopAndDetach` 开始后(同步摘除)立即 route 定向消息 → `delivered=[]`(如实失败),消息不进入已关闭信箱。
- 停机完成后消息可再次投递并触发重新装配(惰性复活仍有效)。
- `Mailbox.enqueue` 在 closed 时返回 false,`route` 不再把其计入 delivered。

### AE-11(C-P1-2)人类调用作用域失败路径清理
- 回合结束且未产生平台回执(无 reply)→ 该 Agent 的作用域**立即**清除,后续 lead 管理面/worker 写面不再被陈旧 scope 封锁。
- 正常回执 → 按 `invocationId` 精确清除(旧调用不误删新调用)。
- `stopAndDetach` 时同步清除。

### AE-12(C-P1-3)工具活性信号全引擎覆盖
- 统一分发入口 `dispatchHostTool` 记录活性;omp 原生 host_tool_call(不经 REST/MCP)也能刷新 `toolActivityOf`。
- 停滞看门狗在"仅 omp 原生工具调用"序列下不误报/不误取消(以调度规则单测断言)。

### AE-13(D-P1-1)TSDB 双后端语义等价
- Timescale `queryTagged` raw 分支返回 `state` 与 `ingestedAt`。
- `queryTaggedPage` 在 Timescale 实现,游标严格 `> afterTs`、`done/nextCursor` 语义与 sqlite 一致。
- 契约测试:同一输入(含 state/ingested_at/分页/桶)两适配器输出结构相同(值容差 0)。

### AE-14(D-P1-2)owner-FK 老库迁移不丢列
- 构造带 `owner_user_id REFERENCES users(id)` 的旧 channels/agents/teams/workspaces 表,含 `scenario_prompt`/`llm_json` 与额外列。
- `initWorkshopDb` 后:表无 users FK;原有行数/全部业务列值逐行相等;`scenario_prompt`/`llm_json` 数据保留。
- 迁移幂等:再次运行无变化、无异常。

### AE-15 全量门禁
- `npm run lint` / `npm run typecheck` / `npm run test:unit` 全绿(含新增用例)。

### AE-16 回归套件
- `test:api-live`(60)、`test:e2e-line`(44)、`test:mcp`(14)、`test:plugin-lifecycle`(22)、`test:sdk-surface`、`test:skills`(124)、本体离线 e2e(57)、`scripts/security-acceptance.mjs`(29)全绿。

### AE-17 真实场景作业(Qwen3.5-9B + omp)
- 用 REST 建 AgentChannel(含 lead/worker)、用工装模板实例化;
- worker 绑定 DAQ 节点 + DCW 节点 + 配方;任务下发后**运行时提示词**含绑定卡(节点名/量程/单步/模式);
- 工具调用链:数采取数 → 判定 → 配方试验(manual 挂 HITL)→ 人工批准 → 设备证实 ACK → 任务 COMPLETED;
- 全程 transcript / 任务工件 / 审批单 / 批次 ACK 入证据目录。

### AE-18 设计完整性与上线判定
- 对"数采镜像 / 数控 / AgentChannel 创建 / worker 绑定节点并运行时注入提示词 / 取数 / HITL 下发"逐项给出"成立/不成立 + 证据锚点";
- 给出"可否上线产线端"的裁定与硬门清单(设备侧、协议、审计、回滚演练)。

### AE-19 文档
- README.md / README-zh.md、VitePress(`docs/site/**`)更新本轮变更与验收结论;
- `npm run docs:check` 不新增失败(存量失败需列明)。

### AE-20 提交 / 推送 / 打包 / 发布
- 版本 bump(0.8.5 → 0.8.6),commit 信息符合 commitlint,推送远端;
- `npm publish` 成功,`npm view agentworkshop version` = 新版;
- 全局入口冒烟(`aw --version` / 首页 200)。

---

## 三、实施顺序

1. P0-1 / P0-2(小改,先落)
2. A-P1-1/2/3 → B-P1-1/2/3/4 → C-P1-1/2/3 → D-P1-1/2
3. 单测(逐条 AE) → 全量门禁 → 回归套件
4. 真实场景作业 + 设计完整性裁定
5. 文档 → 提交 → 推送 → 打包发布

## 四、风险与取舍

- **字节序语义变更**:`little` 从"事实上的 BADC"改为标准 DCBA。存量节点若按旧行为标定过,需要重新核对;但旧行为对真实设备(标准 DCBA/CDAB)本就是错值,且写回读自洽不变。文档与变更日志显式标注。
- **迁移重建**:采用 schema 驱动重建(以现有表定义为准,剔除 users 外键),避免"白名单 DDL 又一次漂移"。
- **P2 遗留**:28 项按域分批,本轮不做;验收报告逐条列明,不声称"全部修复"。
