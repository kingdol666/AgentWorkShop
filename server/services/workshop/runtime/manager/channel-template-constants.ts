/**
 * Channel 模板的纯常量(KB 集成名单 + 作业段提示词)。
 *
 * 单独成模块的原因:ManagerChannelTemplates 继承 ManagerTeams,模块图会拉入 nitro
 * `#imports`(server/utils/config);纯常量不应因此无法被单测直接 import。
 * channel-templates 侧保留同名 re-export,生产调用点不变。
 */

/** 携带「知识库集成」选项的模板:实例化时可显式启停 rag-bridge(开 → 注入 KB 作业段提示词);产线 Co-Pilot 两观察面频道(经验/诊断)的经验与诊断沉淀均以 KB 为唯一持久层,必入本名单 */
export const KNOWLEDGE_BASE_TEMPLATE_IDS = new Set(['chtpl-aml-optimization-default', 'chtpl-generic-optimize-default', 'chtpl-exp-miner-default', 'chtpl-line-doctor-default'])

/** 知识库集成开启时追加到频道场景提示词的作业段(教全员:先检索、后行动、再沉淀;知识调优工程师为主消费者) */
export const KNOWLEDGE_BASE_PROMPT_SECTION = `

## 知识库集成(已启用 rag-bridge)
本频道接入了 rag-knowledge 知识库,优化作业遵循「先检索、后行动、再沉淀」:
1. 优化启动前,lead 与知识调优工程师先用 kb_agent(mode=sync) 检索知识库中与本场景相关的**数据分析结论**与**物理机理知识**(检索词带上产线/产品/关键物理量,如「注塑 保压 克重 波动」「烘箱温度 膜厚 滞后」);把检索所得的机理关系、历史阈值与经验教训作为探索方向、步长与安全边界的依据;
2. 知识调优工程师是知识库的主要消费者与沉淀者:调优方案必须注明依据哪条知识;优化过程中若对某个现象拿不准,先查知识库再动手;worker 也可各自检索,但入库/沉淀由 lead 统一收口(可交知识调优工程师执行);
3. 优化闭环收口后(目标达标或 judge 判定 keep),用 kb_agent(mode=async) 把本次经验沉淀入知识库:标题、类别(工艺经验/数据分析/故障案例)、问题、解决方案、关键数据(带单位的参数调整↔响应变化)。异步提交后无需等待,可继续汇报;入库结果用 kb_agent_status 查询;
4. 若本频道同时启用深度诊断(diag-bridge):数据判读拿不准或质量异常时,先用 diag_run 发起根因诊断(异步,提交即返 task_id),完成后按 diag_status 返回的指引把报告经验经 kb_agent 入库,再把结论用于调优决策。`
