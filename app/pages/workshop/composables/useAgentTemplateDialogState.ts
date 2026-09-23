import { ref } from 'vue'
import type { AgentTemplateDto } from '@/app/composables/workshop/useWorkshopApi'

/**
 * 编辑弹窗的开关 + "打开时携带的模板"(页面级编排状态)。
 * 这里只留一个开关 + 一个 payload ref:表单回填与提交在 useAgentTemplateForm
 * (由弹窗组件调用,回填挂在弹窗 open 的 watcher 上,同一帧渲染前完成)。
 * 关闭时不清 payload(与拆分前的 editing 一样,留着上一次的值)。
 */
export function useAgentTemplateDialogState() {
  const editOpen = ref(false)
  const editing = ref<AgentTemplateDto | null>(null)

  const openCreate = (): void => {
    editing.value = null
    editOpen.value = true
  }
  const openEdit = (t: AgentTemplateDto): void => {
    editing.value = t
    editOpen.value = true
  }

  return { editOpen, editing, openCreate, openEdit }
}
