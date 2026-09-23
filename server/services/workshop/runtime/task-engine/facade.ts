/**
 * TaskEngine —— 组合各分层后的最终类(可见性/继承/实现接口与拆分前一致)
 * + 原文件类体之后引用本类的模块级代码(单例/工厂/广播装配)。
 */
import { TaskEngineLayer04 } from './04-lifecycle'

export class TaskEngine extends TaskEngineLayer04 {}
