/**
 * markdown-lite 渲染(流式安全:先转义后标记,输出可信 HTML)。
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

function inlineMd(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<i>$2</i>')
}

/** GitHub 风格提示框元数据(open-tag github-alert 移植;`> [!NOTE]` 等) */
const GH_ALERTS: Record<string, { label: string, icon: string }> = {
  note: { label: '说明', icon: 'i-tabler-info-circle' },
  tip: { label: '提示', icon: 'i-tabler-bulb' },
  important: { label: '重要', icon: 'i-tabler-flag' },
  warning: { label: '警告', icon: 'i-tabler-alert-triangle' },
  caution: { label: '注意', icon: 'i-tabler-shield-half' },
}

/** 散文渲染:围栏代码块 / 段落 / # 标题 / - 列表 / > 引用 / GitHub 提示框 /
 *  任务列表勾选 / 行内代码与加粗(对部分流式文本安全) */
export function mdLite(src: string): string {
  // ① 围栏代码块先行抽离(```lang … ```):抽成占位符,正文段落流不受影响;
  //    代码块 = 头栏(语言标签 + 复制按钮,事件委托见 useCodeCopy) + 等宽正文
  const codeBlocks: string[] = []
  const fenced = escapeHtml(src).replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, body: string) => {
    const idx = codeBlocks.length
    codeBlocks.push(
      `<div class="code-block" data-lang="${lang || 'text'}">`
      + `<div class="code-head"><span class="code-lang">${lang || 'text'}</span>`
      + `<button type="button" class="code-copy">复制</button></div>`
      + `<pre><code>${body.replace(/\n$/, '')}</code></pre></div>`,
    )
    return `@@AWCODE${idx}@@`
  })
  const html = fenced.split(/\n{2,}/).map((para) => {
    const lines = para.split('\n')
    if (/^### /.test(para)) return `<h5>${inlineMd(para.slice(4))}</h5>`
    if (/^## /.test(para)) return `<h4>${inlineMd(para.slice(3))}</h4>`
    if (/^# /.test(para)) return `<h4>${inlineMd(para.slice(2))}</h4>`
    if (lines.every(l => /^\s*[-*] /.test(l))) {
      // 任务列表:任一行是 `- [ ]` / `- [x]` → 勾选列表(open-tag task-list 移植)
      if (lines.some(l => /^\s*[-*] \[[ xX]\] /.test(l))) {
        const items = lines.map((l) => {
          const m = /^\s*[-*] \[([ xX])\] (.*)$/.exec(l)!
          const done = (m[1] ?? ' ').toLowerCase() === 'x'
          return `<li class="task-item${done ? ' done' : ''}">`
            + `<span class="task-check${done ? ' on' : ''}">${done ? '✓' : ''}</span>`
            + `<span class="task-text">${inlineMd(m[2] ?? '')}</span></li>`
        }).join('')
        return `<ul class="task-list">${items}</ul>`
      }
      return `<ul>${lines.map(l => `<li>${inlineMd(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
    }
    if (lines.every(l => /^&gt;\s?/.test(l))) {
      // GitHub 提示框:首行 `> [!NOTE] [标题]`(open-tag remarkGithubAlerts 移植)
      const am = /^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/.exec(lines[0] ?? '')
      if (am) {
        const meta = GH_ALERTS[am[1]!.toLowerCase()]!
        const firstRest = am[2] ?? ''
        const bodyLines = [
          ...(firstRest ? [firstRest] : []),
          ...lines.slice(1).map(l => l.replace(/^&gt;\s?/, '')),
        ]
        return `<div class="gh-alert gh-${am[1]!.toLowerCase()}">`
          + `<div class="gh-title"><span class="${meta.icon}"></span>${meta.label}</div>`
          + `<p>${bodyLines.map(l => inlineMd(l)).join('<br>')}</p></div>`
      }
      return `<blockquote>${lines.map(l => inlineMd(l.replace(/^&gt;\s?/, ''))).join('<br>')}</blockquote>`
    }
    // 占位符独占段落 → 原样还原(不包 <p>)
    if (lines.length === 1 && /^@@AWCODE\d+@@$/.test(para)) return para
    return `<p>${lines.map(l => inlineMd(l)).join('<br>')}</p>`
  }).join('')
  return html.replace(/@@AWCODE(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
}
