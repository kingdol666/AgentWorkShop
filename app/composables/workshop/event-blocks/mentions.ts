/**
 * @提及高亮(open-tag Slack 声部):源文本占位 → mdLite → pill 还原。
 */
import { escapeHtml, mdLite } from './markdown'

export interface MentionMember {
  agentId: string
  name: string
}

/** @Name 形态的提及词边界(前面是行首/空白/括号,避免匹配邮箱与代码) */
function mentionRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|(?<![\\w@]))@(${escaped})(?=$|[\\s,.;:!?、,。;:!?…)\\]】」』])`, 'gu')
}

/**
 * 源文本提及占位:@Name → \uE000M{idx}\uE000(私用区码点,正文流不可能出现;
 * 先于 mdLite 转义执行,占位符不受转义/标记影响;名字按长度降序避免前缀遮蔽)。
 */
export function maskMentions(src: string, members: MentionMember[]): { text: string, hits: MentionMember[] } {
  const hits: MentionMember[] = []
  if (members.length === 0) return { text: src, hits }
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length)
  let text = src
  for (const m of sorted) {
    if (!m.name) continue
    text = text.replace(mentionRegex(m.name), (_m, _pre, _name) => {
      hits.push(m)
      return `\uE000M${hits.length - 1}\uE000`
    })
  }
  return { text, hits }
}

/** 还原占位为提及 pill HTML(mdLite 输出后执行;pill 点击由容器事件委托处理) */
export function restoreMentions(html: string, hits: MentionMember[]): string {
  return html.replace(/\uE000M(\d+)\uE000/g, (_m, i: string) => {
    const m = hits[Number(i)]
    if (!m) return ''
    return `<span class="md-mention" data-agent-id="${escapeHtml(m.agentId)}">@${escapeHtml(m.name)}</span>`
  })
}

/** mdLite + @提及高亮一体化(聊天正文渲染入口) */
export function mdLiteMentions(src: string, members: MentionMember[]): string {
  const { text, hits } = maskMentions(src, members)
  return restoreMentions(mdLite(text), hits)
}
