# 产线控制机制完整测试计划(配方链路控制策略 · v0.7.53)

范围:与产线控制相关的全部机制 —— 参数中间层、四层限界、写控节奏、recipe 生命周期、节点绑定与授权、日志审计、默认 Channel 编排、模板升级与绑线。执行方式 = 隔离实例 + mock 可写节点 + omp-rpc 工具桥直调(无 LLM 额度消耗),全程断言计数,应测尽测。

## TP-1 参数中间层(工艺参数 ↔ 节点解耦)
- TP-1.1 参数面自动生成:建节点即生成映射;GET /dcw/params 返回语义面,**不含 register/dataType/driverConfig 任何 PLC 寻址细节**
- TP-1.2 语义寻址写:param_control(param_key, value) 按 key 命中参数 → 落到绑定节点;跨产线同名参数需 line_id 消歧
- TP-1.3 语义读:param_read 返回 PLC 当前值 + 量程/窗口摘要(无寻址细节)
- TP-1.4 未绑定拒绝:未持该节点绑定的 Agent 语义写 → 拒绝并提示授权路径

## TP-2 四层限界联锁(节点量程 ∩ 参数基准 ∩ 活动产品 ∩ 配方窗口)
- TP-2.1 逐层越界:分别构造超节点量程 / 超参数基准 / 超产品限界 / 超配方窗口的写入 → 全部 400,文案点名约束层来源 + 「当前有效写入区间 min~max」
- TP-2.2 合法交集内写入 → 成功,回读一致
- TP-2.3 限界交集正确性:四层各自收窄后,有效区间 = 数学交集(用构造值精确验证边界)
- TP-2.4 拒绝入册:每次拒绝 ops_log 出现 dcw.write.rejected(带操作者/产线/被拒值/约束层)

## TP-3 写控节奏治理
- TP-3.1 60s 在线间隔:同参数两次在线写间隔 <60s → 429,提示剩余秒数;≥60s 后放行
- TP-3.2 单步限幅:|Δ| 超步限 → 409(来源:node/param/recipe 优先级)
- TP-3.3 写入保持窗:写成功后锁定窗内再写 → 429「写入保持窗口」
- TP-3.4 Agent 互斥:他人持有 open 优化记录时,第二 Agent 同节点写入被拒(护栏)
- TP-3.5 回退冷却:rollback 后同向写入被冷却拦截(防反复翻烧饼)
- TP-3.6 配方路径豁免:recipe 下发(trial/apply)不受 60s/步限约束,但四层限界照常

## TP-4 recipe 生命周期(配方链路)
- TP-4.1 版本化:update/revert 同 id 版本 +1,history 带 by/actorName/reason/diff;**全程无新 recipe id**
- TP-4.2 trial 不写版本:候选整批下发(多参数一次落 PLC),版本与定义不变;同线节拍 <间隔 → 429
- TP-4.3 trial 越界候选:越界参数拒(逐参数标注原因),同批合法参数照常落;批次快照=候选值
- TP-4.4 recipe_apply:下发已固化版本(全参数)
- TP-4.5 回退两态:缺省=仅定义;dispatch:true=定义回退+PLC 整批恢复(读数验证)
- TP-4.6 lastGood:judge keep 标记良好批次;to_last_good 回退取冻结快照
- TP-4.7 版本史工具:recipe_versions 的 diff/归因/回退溯源可读
- TP-4.8 失效节点守卫:配方引用节点被删/停用 → 下发跳过并标注;update 精确拒因

## TP-5 节点绑定与授权
- TP-5.1 绑定面:my_industrial_nodes 语义卡(含工艺描述/量程/窗口);绑定/解绑即时生效
- TP-5.2 授权下发:lead dispatch_task 带 grant_node_ids → worker 即刻获得指定节点;team_grant_nodes 执行中授予
- TP-5.3 越权拒绝:未绑定节点的 dcw_control/param_control/recipe_trial 逐节点拒;跨产线拒绝
- TP-5.4 频道绑线只读:绑线后无绑定成员可读 ops_log/recipe_log/recipe_versions/line_context;写仍拒
- TP-5.5 解绑回收:解绑/换绑后成员运行时回收,权限即时收敛

## TP-6 日志与审计
- TP-6.1 全链留痕:trial/apply/update/revert/逐参数写/拒绝 全部在 ops_log 可查(带 Channel/成员归因)
- TP-6.2 recipe_log 专门视图:下发/开窗/判定/回退分类清晰
- TP-6.3 dcw_journal:节点级逐笔参数值变更史
- TP-6.4 跨产线拒绝:查询未授权产线日志 → 拒绝并列出可读范围

## TP-7 默认 Channel 编排闭环(最佳编排设计)
- TP-7.1 编成:通用模板 4 成员(生产主管/数据分析师/知识调优工程师/工艺工程师)+ 提示词教学齐备(工具用法/时机/节拍/回退)
- TP-7.2 lead 编排:goal 任务经 dispatch_task 拆解派发(带 grant_node_ids),成员领取执行
- TP-7.3 完整优化过程展示(逐步旁证):取证(daq_query)→ 知识检索(kb_agent 缺席降级声明)→ 多参数候选 → recipe_trial 整批 → 复测判读 → 进步 update 固化 / 劣化统一回退 → 沉淀
- TP-7.4 KB 未启用降级:知识调优工程师声明退化为数据驱动建议(不假装检索)
- TP-7.5 收口:父任务 COMPLETED;全程配方 id 稳定;审计链完整

## TP-8 模板升级与绑线
- TP-8.1 内置模板 upsert:改脏模板行 → 重启被权威定义覆盖(用户复制模板不受影响)
- TP-8.2 instantiate bindLineId 即绑;非法线 id → 404
- TP-8.3 设置弹窗绑线字段:i18n 键齐全(三处对齐)

## 通过标准
每项 PASS/FAIL 明确计数;FAIL 必须附请求/响应证据;产品缺陷当场修复并回归;执行结束输出「优化过程逐步展示」叙述(每步:角色→工具→入参→结果→证据)。
