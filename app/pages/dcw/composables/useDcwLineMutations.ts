import { ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { LineCard } from '../types'
import type { LineInput, LineView } from '#shared/dcw-protocol'

/**
 * 产线写路径状态 —— 新建/编辑/删除三个对话框与「快捷启停」无关的 server 写入。
 * 对话框内的表单字段留在各自组件(纯 UI 状态),这里只保留开合、在飞与错误回显。
 */export function useDcwLineMutations() {
  const dcw = useDcwStream()

  // ---------- 新建产线 ----------
  const createOpen = ref(false)
  const createSaving = ref(false)
  const createError = ref('')

  function openCreate(): void {
    createError.value = ''
    createOpen.value = true
  }

  async function doCreateLine(input: LineInput): Promise<void> {
    createSaving.value = true
    createError.value = ''
    try {
      await dcw.createLine(input)
      createOpen.value = false
    }
    catch (err) {
      createError.value = apiErrorMessage(err)
    }
    finally {
      createSaving.value = false
    }
  }

  // ---------- 编辑产线(名称/描述/光晕色) ----------
  const editOpen = ref(false)
  const editSaving = ref(false)
  const editError = ref('')
  const editTarget = ref<LineCard | null>(null)

  function openEdit(card: LineCard): void {
    editTarget.value = card
    editError.value = ''
    editOpen.value = true
  }

  async function doEditLine(id: string, patch: Partial<LineView>): Promise<void> {
    editSaving.value = true
    editError.value = ''
    try {
      await dcw.updateLine(id, patch)
      editOpen.value = false
    }
    catch (err) {
      editError.value = apiErrorMessage(err)
    }
    finally {
      editSaving.value = false
    }
  }

  // ---------- 删除产线(弹窗两步确认;purge 勾选 = 连同旗下节点/产品/配方一并清理) ----------
  const delOpen = ref(false)
  const delBusy = ref(false)
  const delErr = ref('')
  const delPurge = ref(true)
  const delCard = ref<LineCard | null>(null)

  function openDelete(card: LineCard): void {
    delCard.value = card
    delPurge.value = true
    delErr.value = ''
    delOpen.value = true
  }

  async function doDeleteLine(): Promise<void> {
    if (!delCard.value)
      return
    delBusy.value = true
    delErr.value = ''
    try {
      await dcw.removeLine(delCard.value.line.id, delPurge.value)
      delOpen.value = false
    }
    catch (err) {
      delErr.value = apiErrorMessage(err)
    }
    finally {
      delBusy.value = false
    }
  }

  return {
    createOpen,
    createSaving,
    createError,
    openCreate,
    doCreateLine,
    editOpen,
    editSaving,
    editError,
    editTarget,
    openEdit,
    doEditLine,
    delOpen,
    delBusy,
    delErr,
    delPurge,
    delCard,
    openDelete,
    doDeleteLine,
  }
}
