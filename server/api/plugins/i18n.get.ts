/**
 * GET /api/plugins/i18n —— 全部插件的 i18n 消息包(免鉴权只读)。
 * 返回 { "<plugin>": { "<locale>": { key: value } } };前端 loader 启动/热重载时
 * 拉取,按 vue-i18n 命名空间 `plugin.<plugin>` 合并 —— 插件设置标签、面板文案
 * 由此获得多语言支持。仅 UI 文案:插件作者不得把敏感信息放进 i18n.json。
 */
import { defineEventHandler } from 'h3'
import { pluginI18nBundle } from '@/server/services/workshop/plugins/host.mjs'

export default defineEventHandler(() => {
  return { i18n: pluginI18nBundle(), locales: ['zh-CN', 'en'] }
})
