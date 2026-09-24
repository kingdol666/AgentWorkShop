/**
 * AgentMemory —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)。
 *
 * 模块级尾码(vectorizeMemory / MaintenanceResult / runMemoryMaintenance)按"谁依赖谁"归位:
 * 分层类要调 vectorizeMemory ⇒ 它放 helpers.ts(否则 层 → facade → 层 循环导入);
 * 维护函数只被定时器/REST 调用,留在 helpers 一并导出。
 */
import { AgentMemoryScore } from './score'

export class AgentMemory extends AgentMemoryScore {}
