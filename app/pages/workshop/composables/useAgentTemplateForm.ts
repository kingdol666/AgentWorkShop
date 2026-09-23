import { message } from 'ant-design-vue'
import { reactive, watch, type Ref } from 'vue'
import { useWorkshopApi, type AgentTemplateDto, type HarnessMetaDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 弹窗表单视图态(字段与拆分前 agents.vue 的 form 一致;harness 默认 mock) */
export interface AgentTemplateFormState {
  name: string
  harness: string
  configJson: string
  visibility: 'private' | 'public'
}

/**
 * 弹窗依赖:开关(与组件 v-model:open 是同一个 ref)+ 打开时携带的模板
 * + 页面算好的 harness 派生数据(可用性/元信息,不在这里二次派生)+ 保存成功回调。
 */
export interface AgentTemplateFormOptions {
  open: Ref<boolean>
  editing: () => AgentTemplateDto | null
  isUnavailable: (id: string) => boolean
  harnessMeta: (id: string) => HarnessMetaDto | undefined
  onSaved: () => void | Promise<void>
}

/**
 * 「新建 / 编辑 Agent 模板」弹窗的表单与提交。
 * 打开时的回填/重置挂在这个 composable 的 watcher 上(flush 默认是 pre:同一帧渲染前完成,
 * 用户看到的时序与拆分前页面里 openCreate/openEdit 的同步赋值一致):
 * 新建(editing = null)= 回默认;编辑 = 从模板回填 name/harness/configJson/visibility。
 */
export function useAgentTemplateForm(options: AgentTemplateFormOptions) {
  const api = useWorkshopApi()
  const { t: tt } = useI18n()

  const form = reactive<AgentTemplateFormState>({ name: '', harness: 'mock', configJson: '{}', visibility: 'private' })

  watch([() => options.open.value, () => options.editing()], () => {
    if (!options.open.value) return
    const tpl = options.editing()
    if (!tpl) {
      form.name = ''
      form.harness = 'mock'
      form.configJson = '{}'
      form.visibility = 'private'
      return
    }
    form.name = tpl.name
    form.harness = tpl.harness
    form.configJson = JSON.stringify(tpl.config ?? {}, null, 2)
    form.visibility = tpl.visibility
  })

  const save = async (): Promise<void> => {
    // 与拆分前一致:解析失败就 error + return;这里的初值 {} 在两条路径上都读不到,故不写
    let config: Record<string, unknown>
    try {
      config = JSON.parse(form.configJson || '{}')
    }
    catch {
      message.error(tt('agents.badConfigJson'))
      return
    }
    // 前端兜底:引擎未安装禁止保存(与后端 assertHarnessUsable 同判据)
    if (options.isUnavailable(form.harness)) {
      message.error(options.harnessMeta(form.harness)?.error ?? tt('agents.notInstalled'))
      return
    }
    try {
      const tpl = options.editing()
      if (tpl) {
        await api.updateTemplate(tpl.id, { name: form.name, harness: form.harness, config, visibility: form.visibility })
        message.success(tt('agents.k3n9aij020'))
      }
      else {
        await api.createTemplate({ name: form.name, harness: form.harness, config, visibility: form.visibility })
        message.success(tt('agents.k3n5hak021'))
      }
      options.open.value = false
      void options.onSaved()
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
  }

  return { form, save }
}
