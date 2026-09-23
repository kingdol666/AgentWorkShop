import { computed, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { DcwTemplateInput } from '#shared/dcw-protocol'

/**
 * 控制模板管理(自定义分类)—— server 权威目录的增删。
 * 表单字段由对话框持有(useDcwTemplateForm),本 composable 只管落库与错误回显。
 */
export function useDcwTemplates() {
  const dcw = useDcwStream()
  const { t } = useI18n()

  /** 打开弹窗时清零错误(与原 tplOpen 打开语义一致) */
  const tplError = ref('')
  function clearTplError(): void {
    tplError.value = ''
  }

  async function doCreateTemplate(input: DcwTemplateInput): Promise<void> {
    tplError.value = ''
    try {
      await dcw.createTemplate(input)
    }
    catch (err) {
      tplError.value = apiErrorMessage(err)
    }
  }

  async function doRemoveTemplate(key: string): Promise<void> {
    tplError.value = ''
    try {
      await fetch(`/api/workshop/dcw/templates/${key}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? ''}` },
      }).then(async (r) => {
        const json = await r.json().catch(() => ({}))
        if (json?.code !== 0) throw new Error(json?.message ?? t('dcw.k1bphrb3048'))
      })
      const i = dcw.templates.findIndex(tpl => tpl.key === key)
      if (i >= 0) dcw.templates.splice(i, 1)
    }
    catch (err) {
      tplError.value = apiErrorMessage(err)
    }
  }

  const builtinCount = computed(() => dcw.templates.filter(tpl => tpl.builtin).length)

  return { tplError, clearTplError, doCreateTemplate, doRemoveTemplate, builtinCount }
}
