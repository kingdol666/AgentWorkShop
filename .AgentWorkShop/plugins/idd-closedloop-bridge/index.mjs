/**
 * IDD 闭环分析桥插件 —— **插件入口薄壳**。
 *
 * 包装 industrial-deep-diagnostic 三件套（sentinel / tuning-memory / optimizer-loop）
 * 为 AgentWorkShop OMP 工具；实现按职责拆到 ./host/ 下（常量 / HTTP 辅助 / 插件对象）。
 * 形态对齐内置 diag-bridge v2.1：异步提交即返 task_id，15s sweep 轮询，KV 跟踪；
 * 分析结果入库知识库由 Agent 依工具返回指引调用 rag-bridge 的 kb_agent（regime_key 场景化）。
 */
export { default } from './host/plugin.mjs'
