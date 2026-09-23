import { computed, ref } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { DAQ_TEMPLATE_ICONS, type DaqTemplateDef, type DaqTemplateIcon, type DaqTemplateInput } from '#shared/daq-protocol'

/** 模板表单(自定义信号模板;内置模板只读可复制) */
export interface DaqTemplateForm {
  name: string
  ch: string
  code: string
  unit: string
  min: number | string
  max: number | string
  base: number | string
  amp: number | string
  decimals: number | string
  icon: DaqTemplateIcon
}

/** 图标中文名(与模板表单下拉同源;由页面注入 i18n 函数) */
export type DaqTemplateIconLabel = Record<DaqTemplateIcon, string>

export function useDaqTemplateIconLabels(t: (key: string) => string): DaqTemplateIconLabel {
  return {
    thermo: t('daq.k422b8079'),
    pressure: t('daq.k3x6ff080'),
    tension: t('daq.k3z9xc081'),
    encoder: t('daq.k3subk4082'),
    camera: t('daq.k47atw083'),
    gateway: t('daq.kz7yhbj084'),
  }
}

/**
 * 自定义信号模板管理(server 权威 CRUD;内置只读可复制)。
 * 表单/编辑目标/两段式删除确认都收在这里,页面只负责开合弹窗。
 */
export function useDaqTemplates(t: (key: string, named?: Record<string, unknown>) => string) {
  const daq = useDaqStream()

  const tplOpen = ref(false)
  const tplEditing = ref<string | null>(null)
  const tplSaving = ref(false)
  const tplError = ref('')
  const confirmingDel = ref('')
  const tplForm = ref<DaqTemplateForm>({
    name: '', ch: '', code: '', unit: '',
    min: 0, max: 100, base: 50, amp: 2,
    decimals: 2, icon: 'thermo' as DaqTemplateIcon,
  })

  const customTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(tp => !tp.builtin))
  const builtinTpls = computed<DaqTemplateDef[]>(() => daq.templates.filter(tp => tp.builtin))

  function fillTplForm(tp: DaqTemplateDef, asCopy = false): void {
    tplForm.value.name = asCopy ? t('daq.k2hbo3c126', { p0: catalogTplName(t, tp) }) : catalogTplName(t, tp)
    tplForm.value.ch = tp.ch
    tplForm.value.code = tp.code
    tplForm.value.unit = tp.unit
    tplForm.value.min = tp.min
    tplForm.value.max = tp.max
    tplForm.value.base = tp.base
    tplForm.value.amp = tp.amp
    tplForm.value.decimals = tp.decimals
    tplForm.value.icon = tp.icon
  }

  function resetTplForm(): void {
    tplEditing.value = null
    tplError.value = ''
    confirmingDel.value = ''
    fillTplForm({ key: '', name: '', code: '', ch: '', unit: '', base: 50, amp: 2, min: 0, max: 100, decimals: 2, icon: 'thermo' })
  }

  function editTpl(tp: DaqTemplateDef): void {
    tplEditing.value = tp.key
    tplError.value = ''
    fillTplForm(tp)
  }

  function copyTpl(tp: DaqTemplateDef): void {
    tplEditing.value = null
    tplError.value = ''
    fillTplForm(tp, true)
  }

  async function saveTpl(): Promise<void> {
    tplSaving.value = true
    tplError.value = ''
    try {
      const num = (v: number | string): number | undefined => {
        const n = Number(v)
        return v === '' || v == null || !Number.isFinite(n) ? undefined : n
      }
      const f = tplForm.value
      const input: DaqTemplateInput = {
        name: f.name.trim(),
        ch: f.ch.trim() || undefined,
        code: f.code.trim() || undefined,
        unit: f.unit.trim(),
        min: num(f.min)!,
        max: num(f.max)!,
        base: num(f.base),
        amp: num(f.amp),
        decimals: num(f.decimals),
        icon: f.icon,
      }
      if (tplEditing.value) await daq.updateTemplate(tplEditing.value, input)
      else await daq.createTemplate(input)
      resetTplForm()
    }
    catch (err) {
      tplError.value = apiErrorMessage(err)
    }
    finally {
      tplSaving.value = false
    }
  }

  /** 两段式删除确认(避免误删;空目录风格与节点表一致) */
  async function askDelTpl(tp: DaqTemplateDef): Promise<void> {
    if (confirmingDel.value !== tp.key) {
      confirmingDel.value = tp.key
      return
    }
    try {
      await daq.removeTemplate(tp.key)
    }
    catch (err) {
      tplError.value = apiErrorMessage(err)
    }
    finally {
      confirmingDel.value = ''
    }
  }

  return {
    tplOpen,
    tplEditing,
    tplSaving,
    tplError,
    confirmingDel,
    tplForm,
    iconChoices: DAQ_TEMPLATE_ICONS,
    customTpls,
    builtinTpls,
    resetTplForm,
    editTpl,
    copyTpl,
    saveTpl,
    askDelTpl,
  }
}
