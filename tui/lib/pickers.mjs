// ============================================================
// 交互选择器(浮层)—— 频道选择 / Agent 选择。
// 基于 pi-tui showOverlay + SelectList:方向键移动、Enter 选择、Esc 取消。
// ============================================================
import { SelectList } from '@earendil-works/pi-tui'
import { theme } from '../theme.mjs'

/** 组合"标题 + SelectList"的浮层组件。返回 handle { hide, list, component, __bindHandle } */
function pickerComponent(title, items, maxVisible, onSelect, onCancel) {
  const list = new SelectList(items, maxVisible, theme.editor.selectList)
  const wrap = {
    render(width) {
      return [theme.accent(`┌─ ${title}`), ...list.render(Math.max(width - 2, 24))]
    },
  }
  const handle = { hide() {}, list, component: wrap }
  list.onSelect = (item) => {
    handle.hide()
    onSelect(item)
  }
  list.onCancel = () => {
    handle.hide()
    onCancel?.()
  }
  // 二次装配:showOverlay 返回真实 handle 后回填 hide(调用方调 picker.__bindHandle(real))
  handle.__bindHandle = (h) => {
    handle.hide = () => h.hide()
  }
  return handle
}

/**
 * 频道选择浮层。Enter 选择并切换;Esc 取消(fallback 频道由调用方决定)。
 * @returns handle { close }
 */
export function openChannelPicker(tui, state, { onSelect, onCancel } = {}) {
  const items = state.channels.map(c => ({
    value: c.id,
    label: c.name,
    description: c.leadAgentId ? 'lead 已配置' : '无 lead(仅收发消息)',
  }))
  const picker = pickerComponent('选择要进入的频道(↑↓ 移动 · Enter 进入 · Esc 取消)', items, Math.min(10, items.length),
    (item) => {
      state.channelPickerOpen = false
      onSelect?.(item.value)
    },
    () => {
      state.channelPickerOpen = false
      onCancel?.()
    })
  state.channelPickerOpen = true
  const handle = tui.showOverlay(picker.component, { anchor: 'center' })
  picker.__bindHandle(handle)
  tui.setFocus(picker.list)
  return handle
}

/**
 * Agent/对话目标选择浮层(Tab 触发)。首项 = 频道(发布任务模式);
 * 选具体成员 = 切换通信目标并自动打开其独立监控。
 */
export function openTargetPicker(tui, state, { onPick, onCancel } = {}) {
  const s = state.agents
    .filter(a => a.enabled !== 0)
    .map(a => ({
      value: a.id,
      label: `${a.name}${a.role === 'lead' ? '(lead)' : ''}`,
      description: `通信对话 + 独立监控 · ${state.agentStates[a.id]?.state ?? 'idle'}`,
    }))
  const items = [{ value: '__channel__', label: '频道(发布任务)', description: '普通文本 = 向频道发布正式任务' }, ...s]
  if (items.length === 1 && s.length === 0) {
    onCancel?.()
    return null
  }
  const picker = pickerComponent('选择对话目标(Tab 呼出 · ↑↓ 移动 · Enter 确认 · Esc 取消)', items, Math.min(10, items.length),
    (item) => {
      if (process.env.AW_TUI_DEBUG) console.error('[picker-debug] item=', JSON.stringify(item), 'agentIds=', JSON.stringify(s.map(x => x.value)))
      state.targetPickerOpen = false
      if (item.value === '__channel__') {
        state.target = null
        onPick?.(null)
      }
      else {
        const a = state.agents.find(x => x.id === item.value)
        if (!a) {
          onCancel?.()
          return
        }
        state.target = { agentId: a.id, name: a.name }
        onPick?.(a)
      }
    },
    () => {
      state.targetPickerOpen = false
      onCancel?.()
    })
  state.targetPickerOpen = true
  const handle = tui.showOverlay(picker.component, { anchor: 'center' })
  picker.__bindHandle(handle)
  tui.setFocus(picker.list)
  return handle
}
