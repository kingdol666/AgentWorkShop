import { computed, reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { useDcwAddNode } from './useDcwAddNode'
import type { DcwTemplateIcon } from '#shared/dcw-protocol'

/** 新建控制模板表单(页面唯一副本,经 v-model 下发弹窗) */
export interface DcwTemplateForm {
  name: string
  ch: string
  code: string
  unit: string
  min: number | ''
  max: number | ''
  decimals: number
  icon: DcwTemplateIcon
  semantics: string
}

/**
 * 添加控制节点模板(本页内自定义创建)—— 开合/在飞/错误/成功回显与表单的唯一副本。
 * 新模板创建成功后把添加节点向导的模板选择指向它,下拉随 store 响应式更新。
 */
export function useDcwDetailTemplates(addNode: ReturnType<typeof useDcwAddNode>) {
  const { t } = useI18n()
  const dcw = useDcwStream()

  // ---------- 添加控制节点模板(自定义创建) ----------
  const tplOpen = ref(false)
  const tplSaving = ref(false)
  const tplError = ref('')
  const tplOk = ref('')

  function openTplModal(): void {
    tplOpen.value = true
    tplError.value = ''
    tplOk.value = ''
  }

  const tplForm = reactive<DcwTemplateForm>({
    name: '', ch: '', code: '', unit: '', min: '' as number | '', max: '' as number | '',
    decimals: 1, icon: 'gateway' as DcwTemplateIcon, semantics: '',
  })
  const tplIcons: Array<{ key: DcwTemplateIcon, label: string }> = [
    { key: 'thermo', label: t('dcwDetail.k422b8126') },
    { key: 'pressure', label: t('dcwDetail.k3x6ff127') },
    { key: 'tension', label: t('dcwDetail.k3z9xc128') },
    { key: 'encoder', label: t('dcwDetail.kjb3vhs129') },
    { key: 'camera', label: t('dcwDetail.k47atw130') },
    { key: 'gateway', label: t('dcwDetail.k48c07131') },
  ]

  async function doCreateTemplate(): Promise<void> {
    tplSaving.value = true
    tplError.value = ''
    tplOk.value = ''
    try {
      if (!tplForm.name.trim()) throw new Error(t('dcwDetail.k6ugbw2132'))
      if (tplForm.unit.trim() === '') throw new Error(t('dcwDetail.kx3pg59133'))
      if (tplForm.min === '' || tplForm.max === '') throw new Error(t('dcwDetail.k13awowo134'))
      const tpl = await dcw.createTemplate({
        name: tplForm.name.trim(),
        ch: tplForm.ch.trim() || tplForm.name.trim(),
        code: tplForm.code.trim() || 'CUSTOM',
        unit: tplForm.unit.trim(),
        min: Number(tplForm.min),
        max: Number(tplForm.max),
        decimals: Number(tplForm.decimals) || 0,
        icon: tplForm.icon,
        semantics: tplForm.semantics.trim() || undefined,
      })
      // 新模板即刻可选:添加控制节点向导自动选中它,下拉随 store 响应式更新
      addNode.addTemplate.value = tpl.key
      tplOk.value = t('dcwDetail.ky4e1tr185', { p0: catalogTplName(t, tpl) })
      tplForm.name = ''
      tplForm.ch = ''
      tplForm.code = ''
      tplForm.unit = ''
      tplForm.min = ''
      tplForm.max = ''
      tplForm.semantics = ''
    }
    catch (err) {
      tplError.value = apiErrorMessage(err)
    }
    finally {
      tplSaving.value = false
    }
  }

  const builtinCount = computed(() => dcw.templates.filter(tp => tp.builtin).length)
  const customCount = computed(() => dcw.templates.filter(tp => !tp.builtin).length)

  return { tplOpen, tplSaving, tplError, tplOk, tplForm, tplIcons, builtinCount, customCount, openTplModal, doCreateTemplate }
}
