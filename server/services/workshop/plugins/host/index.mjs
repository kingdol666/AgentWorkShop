/**
 * 插件宿主:配置与 i18n / 运行时服务种子 / 状态与发现 / 初始化 / 装载 / 回滚 / 重载 / 开关 / 对外查询
 *
 * 由原单文件按职责拆分而来;此处保持**原文件的公开 API 与 import 路径不变**
 * (目录 index 解析),外部调用方无需改动。
 *
 * 模块划分:
 *   config.mjs             模块头 / 懒加载权限与仓储 / 日志 / 路径与插件 i18n 读取
 *   services.mjs           插件运行时服务种子(ctx.* 懒绑定)
 *   state.mjs              状态文件路径 / 启停集合读写 / 插件目录发现
 *   init.mjs               宿主初始化(加载配置、种子服务、装载全部插件)
 *   load.mjs               单个插件的装载与校验(配置事件中继 + 主装载流程)
 *   rollback.mjs           装载失败回滚 / 自身 origin / 设置同步
 *   reload.mjs             热重载(reloadPluginHost / doReload)
 *   toggle.mjs             单插件启停 / 状态文件监听 / 宿主查询
 *   api.mjs                对外 API:事件发射 / 客户端脚本 / 清单 / 关停
 */
export { readPluginI18n, pluginI18nBundle } from './config.mjs'
export { statePathFor, readDisabledSet, writeDisabledSet, discoverPluginDirs } from './state.mjs'
export { initPluginHost } from './init.mjs'
export { reloadPluginHost } from './reload.mjs'
export { setPluginEnabled } from './toggle.mjs'
export { getPluginHost, emitPluginEvent, emitDaqSample, emitDaqFrame, emitDcwWrite, emitLineLifecycle, readClientScript, pluginManifest, shutdownPluginHost } from './api.mjs'
