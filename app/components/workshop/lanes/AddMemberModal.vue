<script setup lang="ts">
/**
 * 添加成员弹窗 —— 三模式:从零创建 / 模板克隆 / 编组部署(批量)。
 * 状态自持:弹窗打开(open false→true)即重置表单与选择并懒加载目录,
 * 与拆分前 openMemberModal 的时序一致(重置在原点击处同步完成)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId: string }>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const api = useWorkshopApi()

const memberSubmitting = ref(false)
/** 添加模式:从零创建 / 从模板克隆 / 部署编组(批量) */
const addMode = ref<'create' | 'template' | 'team'>('create')
const memberForm = reactive({
  name: '',
  harness: 'omp' as 'omp' | 'mock' | 'claude',
  role: 'worker' as 'lead' | 'worker',
  systemPrompt: '',
})
/** 模板克隆 / 编组部署选项(弹窗打开时懒加载) */
const templates = ref<Array<{ id: string, name: string, harness: string, enabled: number }>>([])
const teams = ref<Array<{ id: string, name: string, memberCount: number, hasLead: boolean }>>([])
const selectedTemplateId = ref<string>('')
const selectedTeamId = ref<string>('')

const loadCatalog = async (): Promise<void> => {
  try {
    const [tplRes, teamRes] = await Promise.all([api.listTemplates(), api.listTeams()])
    templates.value = (tplRes.data ?? []).map(t => ({ id: t.id, name: t.name, harness: t.harness, enabled: t.enabled }))
    teams.value = (teamRes.data ?? []).map(t => ({
      id: t.id,
      name: t.name,
      memberCount: t.members.length,
      hasLead: t.members.some(m => m.role === 'lead'),
    }))
  }
  catch { /* 目录拉取失败:对应模式显示空并提示刷新 */ }
}

// 打开即回到初始态(拆分前由父级 openMemberModal 同步重置,时序等价)
watch(open, (v) => {
  if (!v) return
  memberForm.name = ''
  memberForm.harness = 'omp'
  memberForm.role = 'worker'
  memberForm.systemPrompt = ''
  addMode.value = 'create'
  selectedTemplateId.value = ''
  selectedTeamId.value = ''
  void loadCatalog()
})

const submitMember = async (): Promise<void> => {
  if (addMode.value === 'create') {
    const name = memberForm.name.trim()
    if (!name) {
      message.warning(t('agentLanesView.ky6jqt4032'))
      return
    }
    memberSubmitting.value = true
    try {
      await api.addChannelAgent(props.channelId, {
        name,
        harness: memberForm.harness,
        role: memberForm.role,
        config: memberForm.systemPrompt.trim()
          ? { systemPromptPrefix: memberForm.systemPrompt.trim() }
          : undefined,
      })
      message.success(t('agentLanesView.k1g5ykr3046', { p0: name }))
      open.value = false
    }
    catch (err) {
      message.error(t('agentLanesView.k1j97j74047', { p0: apiErrorMessage(err) }))
    }
    finally {
      memberSubmitting.value = false
    }
    return
  }
  if (addMode.value === 'template') {
    if (!selectedTemplateId.value) {
      message.warning(t('agentLanesView.k13xo8sz034'))
      return
    }
    memberSubmitting.value = true
    try {
      const tpl = templates.value.find(t => t.id === selectedTemplateId.value)
      await api.addChannelAgent(props.channelId, {
        agentId: selectedTemplateId.value,
        role: memberForm.role,
        config: memberForm.systemPrompt.trim()
          ? { systemPromptPrefix: memberForm.systemPrompt.trim() }
          : undefined,
      })
      message.success(t('agentLanesView.kk3uwzo048', { p0: memberForm.role, p1: tpl?.name ?? '' }))
      open.value = false
    }
    catch (err) {
      const text = apiErrorMessage(err)
      message.error(t('agentLanesView.cloneFail', { p0: text.includes('LEAD_EXISTS') ? t('agentLanesView.leadExistsShort') : `: ${text}` }))
    }
    finally {
      memberSubmitting.value = false
    }
    return
  }
  // 部署编组:批量克隆全部成员模板(lead 冲突由服务端 409 拒绝)
  if (!selectedTeamId.value) {
    message.warning(t('agentLanesView.k1tjd5ab035'))
    return
  }
  memberSubmitting.value = true
  try {
    const team = teams.value.find(t => t.id === selectedTeamId.value)
    await api.deployTeam(selectedTeamId.value, props.channelId)
    message.success(t('agentLanesView.k1gslqf9050', { p0: team?.name ?? '', p1: team?.memberCount ?? 0 }))
    open.value = false
  }
  catch (err) {
    const text = apiErrorMessage(err)
    message.error(t('agentLanesView.deployFail', { p0: text.includes('LEAD_EXISTS') ? t('agentLanesView.leadExistsChannel') : `: ${text}` }))
  }
  finally {
    memberSubmitting.value = false
  }
}
</script>

<template>
  <!-- 添加成员弹窗(三模式:从零创建 / 模板克隆 / 编组部署) -->
  <a-modal
    v-model:open="open"
    :title="$t('agentLanesView.k17kcn55004')"
    :confirm-loading="memberSubmitting"
    :ok-text="$t('common.add')"
    :cancel-text="$t('common.cancel')"
    @ok="submitMember"
  >
    <a-radio-group
      v-model:value="addMode"
      class="mode-switch"
    >
      <a-radio-button value="create">
        {{ $t('agentLanesView.k1b7cwvy024') }}
      </a-radio-button>
      <a-radio-button value="template">
        {{ $t('agentLanesView.k1ndey1w025') }}
      </a-radio-button>
      <a-radio-button value="team">
        {{ $t('agentLanesView.k1l5qyux026') }}
      </a-radio-button>
    </a-radio-group>

    <!-- 模式一:从零创建 -->
    <a-form
      v-if="addMode === 'create'"
      layout="vertical"
      class="member-form"
    >
      <a-form-item :label="$t('agentLanesView.k3nufdm005')">
        <a-input
          v-model:value="memberForm.name"
          :placeholder="$t('agentLanesView.namePh')"
          @press-enter="submitMember"
        />
      </a-form-item>
      <a-form-item label="harness">
        <a-radio-group v-model:value="memberForm.harness">
          <a-radio value="omp">
            {{ $t('agentLanesView.ompFull') }}
          </a-radio>
          <a-radio value="mock">
            {{ $t('agentLanesView.kqg6783027') }}
          </a-radio>
          <a-radio value="claude">
            claude
          </a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="$t('agentLanesView.k479op006')">
        <a-radio-group v-model:value="memberForm.role">
          <a-radio value="worker">
            worker
          </a-radio>
          <a-radio value="lead">
            {{ $t('agentLanesView.k1weovo028') }}
          </a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="$t('agentLanesView.kaogfp007')">
        <a-textarea
          v-model:value="memberForm.systemPrompt"
          :rows="3"
          :placeholder="$t('agentLanesView.kbqn6w5008')"
        />
      </a-form-item>
    </a-form>

    <!-- 模式二:从已有模板克隆 -->
    <a-form
      v-else-if="addMode === 'template'"
      layout="vertical"
      class="member-form"
    >
      <a-form-item :label="$t('agentLanesView.tplCloneLabel')">
        <a-select
          v-model:value="selectedTemplateId"
          :placeholder="$t('agentLanesView.kung925009')"
          :options="templates.map(t => ({ value: t.id, label: `${t.name}(${t.harness})${t.enabled === 0 ? $t('agentLanesView.tplDisabled') : ''}` }))"
        />
      </a-form-item>
      <a-form-item :label="$t('agentLanesView.k1bl78fu010')">
        <a-radio-group v-model:value="memberForm.role">
          <a-radio value="worker">
            worker
          </a-radio>
          <a-radio value="lead">
            {{ $t('agentLanesView.k1weovo028') }}
          </a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="$t('agentLanesView.k1vhvbz7011')">
        <a-textarea
          v-model:value="memberForm.systemPrompt"
          :rows="3"
          :placeholder="$t('agentLanesView.k7ft6ig012')"
        />
      </a-form-item>
      <div class="mode-hint">
        {{ $t('agentLanesView.knybb6r029') }}
      </div>
    </a-form>

    <!-- 模式三:部署 AgentTeam(批量) -->
    <a-form
      v-else
      layout="vertical"
      class="member-form"
    >
      <a-form-item :label="$t('agentLanesView.k29om9b013')">
        <a-select
          v-model:value="selectedTeamId"
          :placeholder="$t('agentLanesView.kur1otz014')"
          :options="teams.map(t => ({ value: t.id, label: $t('agentLanesView.k1qcmxyu040', { p0: t.name, p1: t.memberCount, p2: t.hasLead ? $t('agentLanesView.withLead') : '' }) }))"
        />
      </a-form-item>
      <div class="mode-hint">
        {{ $t('agentLanesView.k1qqnq5030') }}
      </div>
    </a-form>
  </a-modal>
</template>

<style scoped>
.member-form { margin-top: 8px; }
.mode-switch { margin-top: 4px; }
.mode-hint {
  padding: 6px 8px;
  font-size: 11px;
  opacity: 0.6;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border-radius: var(--radius-chip);
}
</style>
