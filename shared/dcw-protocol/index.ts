/**
 * DCW 共享协议:模板/驱动预设与类型、产线、产品与配方、工艺参数映射、调控闭环记录
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   catalog.ts             控制模板与写控制驱动目录(预设数据)+ 模板键辅助
 *   line.ts                产线(顶层隔离维度)+ 节点视图(REST/WS 同构载荷)
 *   recipe.ts              产品/配方/批次 + 工艺参数映射与 PLC 转换模式
 *   closed-loop.ts         调控闭环:写入来源/台账/Agent 优化记录与广播载荷
 */
export { DCW_TEMPLATE_ICONS, DCW_TEMPLATES, dcwTemplateByKey, dcwKeyFromRef, DCW_DRIVERS } from './catalog'
export type { DcwTemplateDef, DcwTemplateIcon, DcwTemplateInput, DcwDriverKind, DcwScaleConfig, DcwDriverMeta } from './catalog'
export { DCW_LINE_COLORS, dcwLineColorFor } from './line'
export type { LineView, LineInput, DcwNodeState, DcwNodeView, AepDcwWritten, AepDcwNodeChange, AepDcwRead, AepDcwControllerState } from './line'
export type { ParamLimitRange, ParamConversion, ParamAccessSpec, DcwParamView, DcwParamInput, ParamLimitLayer, ParamLimitsBreakdown, ProductView, ProductInput, RecipeDaqWindow, RecipeParam, RecipeView, RecipeInput, RecipeRunView, LineRunState, RecipeRunData, LineQueryOpts, LineQueryResult } from './recipe'
export type { DcwWriteSource, DcwWriteMeta, DcwJournalAnchor, OptimizationChannelMetrics, OptimizationMetrics, OptimizationStatus, OptimizationVerdict, OptimizationJudge, OptimizationRecord, DcwParamLedger, AepDcwOptimizationChange } from './closed-loop'
export { applyTransform, inverseTransform, normalizeDataTransform, type DataTransform } from './catalog'
