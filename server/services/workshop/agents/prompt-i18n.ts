/**
 * 注入面语言(Agent 看到的系统文案)。
 *
 * 边界:只翻译**系统生成**的模板文字(工具描述后缀/工况简报/作业环/语义卡标签);
 * 节点名、配方名、用户填写的语义/场景说明是用户数据,原样保留。
 *
 * 解析顺序(无 DB 迁移;均为既有 JSON 配置面):
 *   1) channel_agents.config_json.locale(单 Agent 覆盖)
 *   2) channels.llm_json.locale(频道默认;未设置则跳过)
 *   3) env AW_PROMPT_LOCALE(部署级默认)
 *   4) 'zh'(与历史行为一致)
 */
export type PromptLocale = 'zh' | 'en'

export function normalizePromptLocale(value: unknown): PromptLocale {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'en' || v.startsWith('en-') || v.startsWith('en_')) return 'en'
  return 'zh'
}

/** 内联双语:locale=zh 返回 zh(缺省逐字节不变);locale=en 返回 en */
export function tr(locale: PromptLocale, zh: string, en: string): string {
  return locale === 'en' ? en : zh
}

interface ManagerShape {
  __workshopManager?: {
    deps?: {
      repos?: {
        channelAgents?: { findById?(id: string): { configJson?: string, channelId?: string } | undefined }
        channels?: { findById?(id: string): { llmJson?: string } | undefined }
      }
    }
  }
}

function readJsonLocale(text: unknown): string {
  try {
    const parsed = JSON.parse(String(text ?? '{}')) as { locale?: unknown }
    return typeof parsed?.locale === 'string' ? parsed.locale : ''
  }
  catch {
    return ''
  }
}

/** 解析 Agent 注入面语言(纯读取;任何异常回落 env/zh) */
export function promptLocaleOf(agentId?: string, channelId?: string): PromptLocale {
  try {
    const repos = (globalThis as ManagerShape).__workshopManager?.deps?.repos
    let row: { configJson?: string, channelId?: string } | undefined
    if (agentId && repos?.channelAgents?.findById) {
      row = repos.channelAgents.findById(agentId)
      const v = readJsonLocale(row?.configJson)
      if (v) return normalizePromptLocale(v)
    }
    // 频道级回退:显式 channelId 优先;否则用 agent 行自带的 channelId
    const cid = channelId || row?.channelId || ''
    if (cid && repos?.channels?.findById) {
      const ch = repos.channels.findById(cid)
      const v = readJsonLocale(ch?.llmJson)
      if (v) return normalizePromptLocale(v)
    }
  }
  catch { /* 仓储不可用(单测/启动早期)→ 回落 */ }
  return normalizePromptLocale(process.env.AW_PROMPT_LOCALE ?? 'zh')
}
