<script setup lang="ts">
/**
 * 左栏 Channel 会话列表(Zcode session 栏):workspace 内挂载的 channel,
 * 实时状态徽标(忙碌成员数/活跃任务数),点击聚焦;挂载/移出/设置操作。
 * v10 模板化:
 *  - 「从模板挂载」:选择 Channel 模板 → 实例化 + 挂载一步完成(替代"挂载已有 Channel");
 *  - 「设置」:热修改当前 Channel 实例的场景描述与工作目录(成员运行时自动回收重装配);
 *  - 「保存为模板」:把当前 Channel 实例捕获为可复用模板(场景/目录/团队快照)。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopApi, type ChannelDto, type ChannelTemplateDto } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ wsId: string }>()
const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const workspace = computed(() => wsStore.workspaces.find(w => w.id === props.wsId))

const channels = ref<ChannelDto[]>([])
const channelTemplates = ref<ChannelTemplateDto[]>([])
const refreshChannels = async (): Promise<void> => {
  // SSR 守卫:axios 相对 baseURL 仅客户端有效(服务端拉取会 Invalid URL)
  if (typeof window === 'undefined') return
  const [ch, tpl] = await Promise.all([
    api.listChannels(),
    api.listChannelTemplates().catch(() => null),
  ])
  channels.value = (ch as unknown as { data?: ChannelDto[] })?.data ?? []
  channelTemplates.value = (tpl as unknown as { data?: ChannelTemplateDto[] } | null)?.data ?? []
}
void refreshChannels()

const mountedChannels = computed(() =>
  (workspace.value?.channelIds ?? [])
    .map(id => ({ id, meta: channels.value.find(c => c.id === id), entity: entities.channels[id] }))
    .map(({ id, meta, entity }) => ({
      id,
      name: entity?.name ?? meta?.name ?? id.slice(0, 8),
      /** 实体基线(WS 快照)是否已到达:未到时计数不可信,展示"同步中"而非误导性的 0 */
      synced: entity !== undefined,
      busy: entities.busyCount(id),
      agents: entities.agents[id]?.length ?? 0,
      activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
      workspace: meta?.workspace ?? '',
    })),
)

const select = (channelId: string): void => {
  wsStore.setActiveChannel(props.wsId, channelId)
}

// ===== 新建 Channel 并挂载(空团队) =====
const mountModal = ref(false)
const mountForm = reactive({ name: '', description: '', workspace: '', scenarioPrompt: '' })
const mountSubmitting = ref(false)
/** FileSelector 弹窗(选择服务器目录作为 workspace) */
const fileSelectorOpen = ref(false)
const createAndMount = async (): Promise<void> => {
  if (!mountForm.name.trim()) {
    message.warning('Channel 名称必填')
    return
  }
  mountSubmitting.value = true
  try {
    const res = await api.createChannel({
      name: mountForm.name.trim(),
      description: mountForm.description || undefined,
      scenarioPrompt: mountForm.scenarioPrompt.trim() || undefined,
      workspace: mountForm.workspace.trim() || undefined,
    })
    const created = (res as unknown as { data?: { channelId?: string } })?.data
    const channelId = created?.channelId
    if (!channelId) throw new Error('创建失败')
    await wsStore.mountChannel(props.wsId, channelId)
    mountModal.value = false
    mountForm.name = ''
    mountForm.description = ''
    mountForm.workspace = ''
    mountForm.scenarioPrompt = ''
    void refreshChannels()
    message.success('Channel 已创建(空团队;进入后通过「添加成员」装配 lead / worker)')
  }
  catch (e) {
    message.error(`创建失败:${e instanceof Error ? e.message : String(e)}`)
  }
  finally {
    mountSubmitting.value = false
  }
}

// ===== 从 Channel 模板挂载(实例化 + mount 一步) =====
const templateMountId = ref<string | undefined>()
const templateMounting = ref(false)
const mountFromTemplate = async (): Promise<void> => {
  if (!templateMountId.value) return
  templateMounting.value = true
  try {
    const res = await api.mountChannelTemplate(props.wsId, templateMountId.value)
    const data = (res as unknown as { data?: { agentCount?: number } })?.data
    message.success(`已从模板实例化并挂载(成员 ${data?.agentCount ?? 0} 个)`)
    templateMountId.value = undefined
    void refreshChannels()
  }
  catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    message.error(err?.data?.message ?? err?.message ?? '模板挂载失败')
  }
  finally {
    templateMounting.value = false
  }
}

const unmount = (channelId: string): void => {
  wsStore.unmountChannel(props.wsId, channelId)
    .catch((e: { data?: { message?: string }, message?: string }) => { message.error(e?.data?.message ?? e?.message ?? '移出失败') })
}

// ===== Channel 实例设置(场景/工作目录热更新)+ 保存为模板 =====
const settingsOpen = ref(false)
const settingsChannelId = ref<string>('')
const settingsForm = reactive({ name: '', scenarioPrompt: '', workspace: '' })
const settingsSaving = ref(false)
const fileSelectorOpen2 = ref(false)
const openSettings = (channelId: string): void => {
  const meta = channels.value.find(c => c.id === channelId)
  settingsChannelId.value = channelId
  settingsForm.name = meta?.name ?? ''
  settingsForm.scenarioPrompt = meta?.scenarioPrompt ?? ''
  settingsForm.workspace = meta?.workspace ?? ''
  settingsOpen.value = true
}
const saveSettings = async (): Promise<void> => {
  settingsSaving.value = true
  try {
    await api.patchChannel(settingsChannelId.value, {
      scenarioPrompt: settingsForm.scenarioPrompt,
      workspace: settingsForm.workspace.trim() || undefined,
    })
    message.success('已更新;成员运行时将按新设置回收重装配')
    settingsOpen.value = false
    void refreshChannels()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    settingsSaving.value = false
  }
}

// 保存为模板(捕获当前 channel 的场景/目录/团队)
const saveTplOpen = ref(false)
const saveTplForm = reactive({ name: '', description: '', visibility: 'private' as 'private' | 'public' })
const saveTplSubmitting = ref(false)
const openSaveTemplate = (): void => {
  saveTplForm.name = `${settingsForm.name || 'channel'} 模板`
  saveTplForm.description = ''
  saveTplForm.visibility = 'private'
  saveTplOpen.value = true
}
const saveAsTemplate = async (): Promise<void> => {
  if (!saveTplForm.name.trim()) {
    message.warning('模板名必填')
    return
  }
  saveTplSubmitting.value = true
  try {
    await api.captureChannelTemplate({
      channelId: settingsChannelId.value,
      name: saveTplForm.name.trim(),
      description: saveTplForm.description || undefined,
      visibility: saveTplForm.visibility,
    })
    message.success('已捕获为 Channel 模板(场景/目录/团队快照)')
    saveTplOpen.value = false
    void refreshChannels()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    saveTplSubmitting.value = false
  }
}
</script>

<template>
  <div class="channel-list">
    <div class="list-head">
      <span class="title">Channels</span>
      <span class="head-actions">
        <button
          class="head-op im"
          type="button"
          title="Channel 模板中心"
          @click="navigateTo('/workshop/channel-templates')"
        >
          <span class="i-tabler-layout-grid-add im-pop" />
        </button>
        <button
          class="head-op im"
          type="button"
          title="新建 Channel"
          @click="mountModal = true"
        >
          <span class="i-tabler-plus im-pop" />
        </button>
      </span>
    </div>

    <div
      v-if="mountedChannels.length === 0"
      class="empty"
    >
      尚未挂载 Channel(可从下方模板一键实例化)
    </div>

    <div
      v-for="ch in mountedChannels"
      :key="ch.id"
      class="channel-item"
      :class="{ active: workspace?.activeChannelId === ch.id }"
      @click="select(ch.id)"
    >
      <div class="row1">
        <span
          class="dot"
          :class="{ live: ch.activeTasks > 0 }"
        />
        <span class="ch-name">{{ ch.name }}</span>
        <span
          class="i-tabler-settings2 op"
          title="Channel 设置(场景/工作目录/存为模板)"
          @click.stop="openSettings(ch.id)"
        />
        <span
          class="i-tabler-x op"
          title="移出 workspace"
          @click.stop="unmount(ch.id)"
        />
      </div>
      <div class="row2">
        <!-- 快照未到达:计数不可信,显示同步占位(不呈现误导性的"0 成员") -->
        <span
          v-if="!ch.synced"
          class="meta syncing"
        >同步中…</span>
        <span
          v-else
          class="meta"
        >{{ ch.agents }} 成员 / 忙 {{ ch.busy }} / 任务 {{ ch.activeTasks }}</span>
      </div>
      <div
        v-if="ch.workspace"
        class="row2 ws"
        :title="`工作目录:${ch.workspace}(Agent 作业 cwd)`"
      >
        <span class="i-tabler-folder" /> {{ ch.workspace }}
      </div>
    </div>

    <div class="mount-template">
      <a-select
        v-model:value="templateMountId"
        size="small"
        :placeholder="'从 Channel 模板挂载'"
        class="select"
        :loading="templateMounting"
        :options="channelTemplates.map(t => ({
          value: t.id,
          label: `${t.isBuiltin ? '内置 · ' : t.visibility === 'public' ? '公开 · ' : ''}${t.name}(${(t.lead ? 1 : 0) + t.members.length} 成员)`,
        }))"
        @change="mountFromTemplate"
      />
      <div class="tpl-hint">
        模板 = 场景 + 工作目录 + 团队;实例化即装配成员
      </div>
    </div>

    <a-modal
      v-model:open="mountModal"
      title="新建 Channel 并挂载"
      :confirm-loading="mountSubmitting"
      ok-text="创建"
      cancel-text="取消"
      @ok="createAndMount"
    >
      <a-form layout="vertical">
        <a-form-item label="Channel 名称">
          <a-input v-model:value="mountForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="mountForm.description" />
        </a-form-item>
        <a-form-item label="作业场景 Prompt(全员注入)">
          <a-textarea
            v-model:value="mountForm.scenarioPrompt"
            :rows="4"
            placeholder="该 channel 全部 Agent 共享的作业场景规范,与系统设计手册组合注入每个 harness……例如:所有产出必须附中文摘要;代码修改需先列计划再动手;回复末尾附 [DONE] 标记"
          />
          <template #extra>
            <span class="ws-hint">注入顺序:场景规范 → 成员专长 → 记忆 → 系统手册 → 任务;设置弹窗可热更新(成员运行时自动回收重装配)</span>
          </template>
        </a-form-item>
        <a-form-item label="工作目录(团队作业挂载点)">
          <a-input-group compact>
            <a-input
              v-model:value="mountForm.workspace"
              style="width: 70%"
              placeholder="留空 = data/workspaces/<channelId>"
              allow-clear
              @press-enter="createAndMount"
            />
            <a-button
              style="width: 30%"
              @click="fileSelectorOpen = true"
            >
              浏览…
            </a-button>
          </a-input-group>
          <template #extra>
            <span class="ws-hint">执行任务时该目录注入各 Agent harness 的作业 cwd(omp 子进程工作目录);不存在自动创建</span>
          </template>
        </a-form-item>
        <a-form-item>
          <span class="ws-hint">Channel 创建后为空团队,无任何 Agent;进入后通过「添加成员」选择角色(lead/worker)与场景提示词完成装配</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- Channel 实例设置:场景/工作目录热更新 + 保存为模板 -->
    <a-modal
      v-model:open="settingsOpen"
      :title="`Channel 设置 · ${settingsForm.name}`"
      :confirm-loading="settingsSaving"
      ok-text="保存"
      cancel-text="取消"
      @ok="saveSettings"
    >
      <a-form layout="vertical">
        <a-form-item label="作业场景 Prompt(修改后成员运行时自动回收,按新场景重装配)">
          <a-textarea
            v-model:value="settingsForm.scenarioPrompt"
            :rows="4"
            placeholder="该 channel 全部 Agent 共享的作业场景规范……"
          />
        </a-form-item>
        <a-form-item label="工作目录(Agent 作业 cwd;修改后 omp 子进程按新目录重启)">
          <a-input-group compact>
            <a-input
              v-model:value="settingsForm.workspace"
              style="width: 70%"
              placeholder="data/workspaces/<channelId>"
              allow-clear
            />
            <a-button
              style="width: 30%"
              @click="fileSelectorOpen2 = true"
            >
              浏览…
            </a-button>
          </a-input-group>
        </a-form-item>
        <a-form-item>
          <a-button
            size="small"
            @click="openSaveTemplate"
          >
            <span class="i-tabler-template" />
            保存为 Channel 模板
          </a-button>
          <span class="ws-hint">捕获当前场景/工作目录/团队组合为可复用模板</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 保存为模板 -->
    <a-modal
      v-model:open="saveTplOpen"
      title="保存为 Channel 模板"
      :confirm-loading="saveTplSubmitting"
      ok-text="保存模板"
      cancel-text="取消"
      @ok="saveAsTemplate"
    >
      <a-form layout="vertical">
        <a-form-item label="模板名称">
          <a-input v-model:value="saveTplForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="saveTplForm.description" />
        </a-form-item>
        <a-form-item label="可见性">
          <a-radio-group v-model:value="saveTplForm.visibility">
            <a-radio value="private">
              私有(仅本人)
            </a-radio>
            <a-radio value="public">
              公开(全员可实例化)
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item>
          <span class="ws-hint">成员有模板引用则保留引用,否则保存内联快照;场景与工作目录照搬</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- FileSelector:服务器目录选择 -> 回填工作目录 -->
    <workshop-file-selector-modal
      v-model:open="fileSelectorOpen"
      title="选择团队工作目录"
      :initial-path="mountForm.workspace || undefined"
      @select="(p) => { mountForm.workspace = p }"
    />
    <workshop-file-selector-modal
      v-model:open="fileSelectorOpen2"
      title="选择团队工作目录"
      :initial-path="settingsForm.workspace || undefined"
      @select="(p) => { settingsForm.workspace = p }"
    />
  </div>
</template>

<style scoped>
.channel-list {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 12px 10px 8px;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 8px;
}
.title {
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.head-actions { display: inline-flex; gap: 2px; }
.head-op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 14px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.head-op:hover { color: var(--ink); background: var(--paper-deep); }
.empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--ink-faint);
}
.channel-item {
  padding: 7px 9px;
  margin: 1px 0;
  cursor: pointer;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast);
}
.channel-item:hover { background: var(--paper-deep); }
.channel-item.active { background: var(--paper-deep); box-shadow: inset 2px 0 0 var(--accent); }
.row1 {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 13px;
  color: var(--ink-soft);
}
.channel-item.active .row1 { color: var(--ink); font-weight: 500; }
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--tone-neutral-dot);
  opacity: 0.55;
  border-radius: 50%;
}
.dot.live {
  background: hsl(137 36% 52%);
  opacity: 1;
}
.ch-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--ink-fainter);
  opacity: 0;
  border-radius: var(--radius-chip);
  transition: opacity var(--transition-fast), color var(--transition-fast);
}
.channel-item:hover .op { opacity: 0.75; }
.op:hover { opacity: 1 !important; color: var(--ink); }
.row2 { padding-left: 14px; font-size: 11px; color: var(--ink-faint); }
.meta.syncing { font-style: italic; opacity: 0.6; }
.row2.ws {
  display: flex;
  gap: 4px;
  align-items: center;
  overflow: hidden;
  max-width: 100%;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-fainter);
}
.mount-template { padding: 12px 6px 6px; border-top: 1px solid var(--line); margin-top: 10px; }
.select { width: 100%; }
.tpl-hint {
  padding: 5px 2px 0;
  font-size: 10.5px;
  color: var(--ink-fainter);
}
.ws-hint { font-size: 11px; color: var(--ink-faint); }
</style>
