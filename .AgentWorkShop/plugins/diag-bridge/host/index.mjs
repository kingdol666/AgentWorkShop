/**
 * 诊断桥插件:常量 / HTTP 与配置辅助 / 快照抽取 / 诊断启动 / 自动巡检 / 插件对象(路由与工具)
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   constants.mjs          模块头与常量(超时 / 快照桶 / 冷却 / 进行中产线集合)
 *   helpers.mjs            基址与令牌解析 / JSON 请求 / 规则解析 / CSV 与数值格式化
 *   snapshot.mjs           快照抽取(降采样 + 截断 + 上传附件)
 *   diagnosis.mjs          启动一次诊断(建运行记录 / 调 harness / 落 KV)
 *   sweep.mjs              自动巡检:按规则扫描产线并触发诊断
 *   plugin.mjs             插件对象(settings / routes / tools / hooks)
 */
export { default } from './plugin.mjs'
