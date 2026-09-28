# 通用调控频道升级 + 写控/回退链验收(2026-09-29)

## 需求 → 实现映射

| 需求 | 实现 | 验收 |
|---|---|---|
| 插件只配地址+token 即可用 | rag-bridge/diag-bridge 默认 base_url 指向本机后端,设置页仅填 token(可选)即热生效 | T3 PASS:仅 PATCH token+diag base_url 两键,双插件协同全通 |
| Agent 懂两工具的用法与时机 | 模板提示词 + KB 作业段教学:检索在动手前(KB 增强)、调优方案注明依据条目、收口沉淀、diag 异步+完成入库指引 | T1 PASS:scenarioPrompt 1813 字含全部教学段;各成员 systemPromptPrefix 职责明确 |
| 知识总结入库 + 检索增强 + 据此下发 | 专职「知识调优工程师」worker:检索→结合数据分析→出带依据的调优方案→交工艺工程师治理下发→沉淀/劣化建议回退 | T1+T3 PASS(工具面);协同链路语义见场景提示词与 KB 段 |
| DCW 写入时间卡控 | 平台硬卡控:同参数在线写入间隔 ≥60s(429+剩余秒数提示)+ 单步限幅 | T4 PASS:2s 内二写被拒「还需 58s」;61s 后恢复;大步 28℃>2℃ 限幅被拒 |
| 质量差则回退 | dcw_judge(rollback)→dcw_rollback 恢复;配方级 recipe_update 留版本→revert 非破坏回退 | T5 PASS:回退后读值恢复一致;配方 161→165→161 谱系完整(带 by/actor) |
| recipe/参数管理存储回退机制 | 配方版本史(非破坏)+ revert API + rollback-good 机制 | T5 PASS:versions 3 条全谱系 |
| 默认调控 Channel 团队编成 | 4 成员:生产主管(统一调配+回退决策)/ 数据分析师(持续读数·滑动窗口)/ 知识调优工程师(知识↔数据→方案)/ 工艺工程师(治理下发+60s 纪律) | T1 PASS:成员与职责词全中 |
| 通用场景开箱即用,特定场景填提示 | 模板 = 标准作业流程(不假设场景);特定场景 = 实例化后改场景提示词即成专业任务(KB 段自动追加) | 设计如此;T1 双形态验证(有/无 KB 段) |
| 存量库升级 | 内置模板 upsert:seed 启动对 owner IS NULL 的内置行无条件同步权威定义 | T2 PASS:直改脏数据重启即被新版覆盖,用户复制模板不受影响 |

断言合计 33/33 PASS,0 FAIL(实例 3940 + mock IDD 3210 + 真实 KB 8770;脚本存档 .e2e-tmp/tpl-e2e/)。

## 变更清单(产品代码)
- seed.ts:chtpl-generic-optimize-default 重构(4 成员 + 教学型提示词:工具用法/时机/写入卡控/劣化回退/知识闭环);新增内置模板升级 upsert(UPDATE ... WHERE owner_user_id IS NULL)。
- channel-templates.ts:KNOWLEDGE_BASE_PROMPT_SECTION 升级(知识调优工程师为主消费者、kb_agent_status 查询、diag-bridge 协同段)。

## 已知边界(如实记录)
- 模板 harness=omp:mock 引擎实例化时成员 harness 仍为 omp,工具面验收走 agent-tools/invoke 桥(admin 驱动);真实 LLM 编排质量待有余额时跑一轮 omp 实测(历史 omp 闭环已验证同款工具面)。
- 写入间隔 60s 为平台常量(dcw 写控治理),如需按产线可调,后续可挂设置组(当前设计:全局一致,防止误配过激)。
