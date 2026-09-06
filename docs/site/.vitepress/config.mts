import { defineConfig } from 'vitepress'

// 中文根站点 + /en/ 英文镜像(右上角语言切换);主题/搜索/页脚按 locale 各自声明
const zhNav = [
  { text: '指南', link: '/guide/getting-started' },
  { text: 'SDK', link: '/sdk/' },
  { text: '插件', link: '/plugins/' },
  { text: 'CLI', link: '/cli/' },
  { text: '开源协议', link: '/guide/license' },
  { text: 'GitHub', link: 'https://github.com/kingdol666/AgentWorkShop' },
]
const enNav = [
  { text: 'Guide', link: '/en/guide/getting-started' },
  { text: 'SDK', link: '/en/sdk/' },
  { text: 'Plugins', link: '/en/plugins/' },
  { text: 'CLI', link: '/en/cli/' },
  { text: 'License', link: '/en/guide/license' },
  { text: 'GitHub', link: 'https://github.com/kingdol666/AgentWorkShop' },
]
const zhGuide = [
  { text: '快速开始', link: '/guide/getting-started' },
  { text: '配置系统', link: '/guide/configuration' },
  { text: '五协议数采与数控', link: '/guide/daq-protocols' },
  { text: '数控读写集成', link: '/guide/dcw-read-write' },
  { text: 'HITL 人机协同审批', link: '/guide/hitl' },
  { text: 'Recipe 版本管理', link: '/guide/recipe-versions' },
  { text: '多 Harness Agent 团队', link: '/guide/multi-harness' },
  { text: '产线级权限', link: '/guide/line-permissions' },
  { text: '第一次 Agent × 产线会话', link: '/guide/first-session' },
  { text: '开源协议', link: '/guide/license' },
]
const enGuide = [
  { text: 'Getting started', link: '/en/guide/getting-started' },
  { text: 'Configuration', link: '/en/guide/configuration' },
  { text: 'Five-protocol DAQ & control', link: '/en/guide/daq-protocols' },
  { text: 'Read-write DCW', link: '/en/guide/dcw-read-write' },
  { text: 'HITL approvals', link: '/en/guide/hitl' },
  { text: 'Recipe versioning', link: '/en/guide/recipe-versions' },
  { text: 'Multi-harness agent teams', link: '/en/guide/multi-harness' },
  { text: 'Line-level permissions', link: '/en/guide/line-permissions' },
  { text: 'Your first agent × line session', link: '/en/guide/first-session' },
  { text: 'License', link: '/en/guide/license' },
]
const zhSdk = [
  { text: '总览与获取', link: '/sdk/' },
  { text: '平台 REST 客户端', link: '/sdk/api-client' },
  { text: '插件上下文 ctx', link: '/sdk/context' },
  { text: '生命周期事件', link: '/sdk/lifecycle' },
  { text: '浏览器端 SDK', link: '/sdk/client' },
  { text: '完整指南(单页)', link: '/sdk/guide' },
]
const enSdk = [
  { text: 'Overview', link: '/en/sdk/' },
  { text: 'Platform REST client', link: '/en/sdk/api-client' },
  { text: 'Plugin context (ctx)', link: '/en/sdk/context' },
  { text: 'Lifecycle events', link: '/en/sdk/lifecycle' },
  { text: 'Browser-side SDK', link: '/en/sdk/client' },
  { text: 'Full guide (single page)', link: '/en/sdk/guide' },
]
const zhPlugins = [
  { text: '插件指南', link: '/plugins/' },
  { text: '生命周期详解', link: '/plugins/lifecycle' },
  { text: '真实案例 line-sentinel', link: '/plugins/example' },
  { text: '完整指南(单页)', link: '/plugins/guide' },
]
const enPlugins = [
  { text: 'Plugin guide', link: '/en/plugins/' },
  { text: 'Lifecycle', link: '/en/plugins/lifecycle' },
  { text: 'Real example: line-sentinel', link: '/en/plugins/example' },
  { text: 'Full guide (single page)', link: '/en/plugins/guide' },
]

export default defineConfig({
  title: 'AgentWorkShop',
  description: 'Agent 团队 × 产线 × 数字孪生 —— 配置驱动 · SDK 集成 · 插件增强',
  // GitHub Pages 项目页路径(https://kingdol666.github.io/AgentWorkShop/)
  base: '/AgentWorkShop/',
  // 单一控制室色板,不提供明暗切换(theme/custom.css 以 --hud-* 令牌承载)
  appearance: false,
  lastUpdated: true,
  ignoreDeadLinks: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: zhNav,
        sidebar: {
          '/guide/': [{ text: '上手指南', items: zhGuide }],
          '/sdk/': [{ text: 'SDK(客户端与扩展基座)', items: zhSdk }],
          '/plugins/': [{ text: '插件开发', items: zhPlugins }],
          '/cli/': [{ text: 'CLI', items: [{ text: 'aw 指令手册', link: '/cli/' }] }],
        },
        search: { provider: 'local', options: { translations: { button: { buttonText: '搜索文档' } } } },
        outline: { level: [2, 3], label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
        returnToTopLabel: '回到顶部',
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: enNav,
        sidebar: {
          '/en/guide/': [{ text: 'Guide', items: enGuide }],
          '/en/sdk/': [{ text: 'SDK (client & extension base)', items: enSdk }],
          '/en/plugins/': [{ text: 'Plugin development', items: enPlugins }],
          '/en/cli/': [{ text: 'CLI', items: [{ text: 'aw command manual', link: '/en/cli/' }] }],
        },
        search: { provider: 'local' },
        outline: { level: [2, 3], label: 'On this page' },
        docFooter: { prev: 'Previous', next: 'Next' },
        lastUpdated: { text: 'Last updated' },
        returnToTopLabel: 'Back to top',
      },
    },
  },
  themeConfig: {
    siteTitle: 'AgentWorkShop',
    logo: '/favicon.svg',
    socialLinks: [{ icon: 'github', link: 'https://github.com/kingdol666/AgentWorkShop' }],
    footer: {
      message: '依据 PolyForm Noncommercial 1.0.0 开源 · Licensed under PolyForm Noncommercial 1.0.0',
      copyright: 'Copyright © 2026 kingdol (kingdol666)',
    },
  },
})
