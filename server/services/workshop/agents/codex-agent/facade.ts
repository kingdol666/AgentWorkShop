/**
 * CodexAgentImpl —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { CodexAgentImplLayer03 } from './03-client'
import type { AgentInterface } from '../agent-interface'

export class CodexAgentImpl extends CodexAgentImplLayer03 implements AgentInterface {}
