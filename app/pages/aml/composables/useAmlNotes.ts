/**
 * 行内备注编辑态:全局唯一一个「正在编辑的行」(key = 实体 id)。
 * 数据集表与模型表共用同一份实例 —— 两处同时只能开一个编辑框,
 * 因此状态由页面创建一次后显式下发给两个子组件,而不是各自复制一份。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { amlApi } from '../api'

export interface AmlNotesDeps {
  reloadDatasets: () => Promise<void>
  reloadModels: () => Promise<void>
}

export function useAmlNotes(deps: AmlNotesDeps) {
  const { t: tt } = useI18n()

  const noteEditing = ref('')
  const noteDraft = ref('')

  function startEditNote(id: string, current: string): void {
    noteEditing.value = id
    noteDraft.value = current ?? ''
  }
  function cancelEditNote(): void {
    noteEditing.value = ''
    noteDraft.value = ''
  }
  async function saveNote(kind: 'datasets' | 'models', id: string): Promise<void> {
    try {
      await amlApi(`/${kind}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: noteDraft.value }),
      })
      message.success(tt('aml.k1amlx192'))
      cancelEditNote()
      if (kind === 'datasets') await deps.reloadDatasets()
      else await deps.reloadModels()
    }
    catch (err) {
      message.error(`${tt('aml.k1amlx203')}:${apiErrorMessage(err)}`)
    }
  }

  return { noteEditing, noteDraft, startEditNote, cancelEditNote, saveNote }
}
