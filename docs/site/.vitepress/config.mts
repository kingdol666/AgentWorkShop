import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'AgentWorkShop',
  description: 'Agent 团队 × 产线 × 数字孪生 —— 配置驱动 · SDK 集成 · 插件增强',
  ignoreDeadLinks: true,
  themeConfig: {
    siteTitle: 'AgentWorkShop',
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'SDK', link: '/sdk/' },
      { text: '插件', link: '/plugins/' },
      { text: 'CLI', link: '/cli/' },
      { text: 'GitHub', link: 'https://github.com/kingdol666/AgentWorkShop' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '上手指南',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '配置系统', link: '/guide/configuration' },
            { text: '第一次 Agent × 产线会话', link: '/guide/first-session' },
          ],
        },
      ],
      '/sdk/': [
        {
          text: 'SDK（客户端与扩展基座）',
          items: [
            { text: '总览与获取', link: '/sdk/' },
            { text: '平台 REST 客户端', link: '/sdk/api-client' },
            { text: '插件上下文 ctx', link: '/sdk/context' },
            { text: '生命周期事件', link: '/sdk/lifecycle' },
            { text: '浏览器端 SDK', link: '/sdk/client' },
            { text: '完整指南(单页)', link: '/sdk/guide' },
          ],
        },
      ],
      '/plugins/': [
        {
          text: '插件开发',
          items: [
            { text: '插件指南', link: '/plugins/' },
            { text: '生命周期详解', link: '/plugins/lifecycle' },
            { text: '真实案例 line-sentinel', link: '/plugins/example' },
            { text: '完整指南(单页)', link: '/plugins/guide' },
          ],
        },
      ],
      '/cli/': [
        {
          text: 'CLI',
          items: [{ text: 'aw 指令手册', link: '/cli/' }],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/kingdol666/AgentWorkShop' }],
    search: { provider: 'local', options: { translations: { button: { buttonText: '搜索文档' } } } },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    returnToTopLabel: '回到顶部',
  },
})
