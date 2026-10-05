# 优化 Plan 落地 + 全组合工业场景作业报告(2026-10-06)

> 上游: IDD×知识库集成实测报告(5cb2ca1)下发的 Plan A-D。本轮全部落地,并以一次**真实工业组合作业**验证全功能可行性。
> 结论:**Plan A-D 全部落地(冒烟 9/9)**;组合作业全链真实跑通——数采(merge 导出)→IDD 哨兵(45 告警)→KB 检索/入库→五要素推理提案→HITL 人工批准→下发→复测达标→复测入库→交付,AML 腿(safe_small_step 推荐+入库)同步完成。

## 1. Plan 落地清单(代码/资产)

| Plan | 项 | 落地 |
|---|---|---|
| A | rag-bridge 默认端口对齐 | `DEFAULT_BASE` 8771→**8770**(注释写明端口判定顺序) |
| A | 双插件 README「三步接线」 | `idd-closedloop-bridge/README.md`、`rag-bridge/README.md`(服务→token 签发→settings 热配,含正确注册路径) |
| A | 数据交换目录约定 | idd 插件 settings 新增 `exchange_dir`(含沙箱警示);工具指引与 README 同步 |
| B | sentinel_status 透明化 | failed 时透传 error+stdout_tail+常见原因提示(路径沙箱/缺列) |
| B | daq_export merge 模式 | 平台新增 `merge` 参数:多节点按秒对齐多参数宽表 `merged.csv`(列名=节点名),IDD 可直接消费;host-tools.json schema 同步;输出指引更新 |
| C | 一键工作流模板 | 频道模板「哨兵巡检-入库工作流」(id 859c2742):场景提示词固化 ①export(merge)→②搬运→③基线/筛查→④KB 检索→⑤判读→⑥入库→⑦条件提案→⑧交付 全流程 |
| D | 集成 CI 冒烟 | `scripts/testing/idd-kb-smoke.mjs`(服务健康×3+插件装载+token 配置+最小调用),重启后实测 **9/9 通过** |

## 2. 全组合工业作业执行过程(任务 572652af,Channel「工况A-线1温度GOAL」)

**场景设定**:模拟器切换 `disturb` 工况(扰动加剧),GOAL ≥205.0,root_timeout 热更 60min(缓解 D1)。

| 时刻 | 事件 |
|---|---|
| 02:26 | 派单(九步任务书:数据→搬运→哨兵→KB 检索→判读→入库→条件提案(五要素强制)→复测→交付) |
| 02:28-02:53 | lead 执行①-⑤:merge 导出→交换目录→哨兵 screen×4 窗+watch → **disturb 窗 45 条告警(R6×16/R5×10/R2×9/R1×8/R3×1,窗内零人工下发→判非受控方差型扰动)** → KB 检索命中历史结论 → kb_agent 入库 disturb 文档(regime_key=line1-extruder-disturb-20261006) |
| 02:54 | **recipe_propose**(disturb 纠偏·z2/z3 联合+1.0℃/区 205→206)——五要素全带:①basis(90min 窗 n=2600,均值 205.087,3min 桶最小 205.013 余量贴地)②exp_ref(标定增益 0.57~0.82+**KB 双文档引用含本链路刚入库的 disturb 文档**)③预期 205.66~205.91④步幅 ≤2.8 上限+已验证同款⑤风险回退线(晶点>10/m² 或 >207→rollback v9);z1 单独排除(增益 0.06<0.4 失效线) |
| 02:55 | **人工批准**(工程师评语:依据链完整可核查,z1 封存逻辑正确,按回退线执行) |
| 03:00 | `approval.approve` → `dcw.write.recipe`×2 → `recipe.apply` 2/2(批次 rr-57ab2)——**审计四连完整** |
| 03:0x-03:2x | 惯性等待+复测轮;期间出现第二张卡 ap-7094f721(疑似固化动作)触发 ⏰ TTL 升级,**lead+双 worker 自发三方核证**(三层账面对账+本班次零写入自证)判"无账面背书幽灵卡,超时默认拒=零执行=安全" |
| 03:33 | 卡超时默认拒(fail-closed);人工终审确认无需重发 |
| 03:43-03:48 | 收口轮 WORKING → **COMPLETED**,交付五段全带 |

**物理结果**:熔体 205.09 → **206.08℃**(z2/z3=206 生效,SP 读回 206,GOAL 余量 +1.08,预测带 205.66~205.91 附近)。
**AML 腿**:线2 优化频道 snapshot(snap-muvnebqz,completeness 1)→ `mpc_optimize` → **recommendation-only/safe_small_step**(无 UQ 模型被正确锁定)→ 推荐记录入 KB;期间另一频道 AML agent **自发重训**(job-muvlbbvr,5s-lane MLP persistence-residual,门禁全过并登记 mdl-muvlbbvr)。

## 3. 用户点名的四项需求逐条对照

1. **获取数据保存 CSV 让 IDD 分析** → `daq_export(merge:true)` 产 merged.csv,交换目录交接,IDD 全窗批筛 45 告警 ✅
2. **结果入库+随时查看检索** → 三份文档入库(steady-step/disturb/AML 推荐);作业中与作业后多次 sync 检索均 P0 命中(QDCVR 引擎裁决+领域错配过滤生效) ✅
3. **下发控制附参数思考逻辑** → 提案卡五要素齐全(HITL 用户零上下文可读懂为什么是 206、为什么 z1 不动、超限怎么办),人工凭卡即可裁决 ✅
4. **新一轮分析→检索→再下发** → disturb 窗(新)→检索对照(旧)→判读→提案→批准→下发→复测→复测结论入库,闭环多轮 ✅

## 4. 过程发现(新增/复现)

- **D1 复现×1**:组合任务派单后 7 分钟未入场(重装配+催办解锁);HITL 豁免顺延了预算(批准挂起期),事后未再被收口——60min 预算+豁免组合下任务存活,**预算热更是当前标准缓解手段**。
- **幽灵卡事件(P3 观察)**:ap-7094f721 无账面背书(疑为重试/重复工件),多 Agent 三层核证+超时 fail-closed 兜住;建议 `recipe_update` 类卡片与 ledger 双写强关联防幽灵。
- **上下文压缩代价(P3)**:lead 交付如实自报"daq_export 任务号因会话压缩不可恢复"——长任务建议把关键 id 即时写入 KB/共享记忆(本轮 KB 文档已承担此职)。
- 集成冒烟(Plan-D)在重启后一次性 9/9,证明接线包(Plan-A)有效固化了对齐配置。

## 5. 留痕
任务 572652af;提案 ap-ceaf31cd/幽灵卡 ap-7094f721;批次 rr-57ab2;哨兵 SNW-20261005184856(45 告警)+SNW-20261005175456(41);KB 文档 steady-step/disturb/AML 推荐三篇(regime_key 齐);快照 snap-muvnebqz;模型 mdl-muvlbbvr;模板 859c2742。设置变更:root_timeout 3600000(演示后恢复 900000)、rag-bridge base_url 8770、双 token。
