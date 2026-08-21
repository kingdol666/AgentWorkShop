<script setup lang="ts">
/**
 * Agent 模板库:用户级隔离的模板 CRUD + 实例去向(克隆到了哪些 channel)。
 * v10 可见性:private 仅本人;public 全员可读可用(仅属主可改删);内置(锁)任何人不可改删。
 * admin:全量视图(含他人私有),附创建者;可改删任意非内置模板。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type AgentTemplateDto } from '../../composables/workshop/useWorkshopApi'
import { useUserStore } from '../../stores/workshop/user'

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
const userStore = useUserStore()
const templates = ref<AgentTemplateDto[]>([])
const loading = ref(false)
const load = async (): Promise<void> => {
  loading.value = true
  try {
    const res = await api.listTemplates()
    templates.value = (res as unknown as { data?: AgentTemplateDto[] })?.data ?? []
  }
  finally {
    loading.value = false
  }
}
void load()

// ===== 过滤(全部/我的/公开/内置;admin 另有"他人私有") =====
type Filter = 'all' | 'mine' | 'public' | 'builtin' | 'others'
const filter = ref<Filter>('all')
const filterOptions = computed(() => {
  const opts: Array<{ value: Filter, label: string }> = [
    { value: 'all', label: `全部 ${templates.value.length}` },
    { value: 'mine', label: `我的 ${templates.value.filter(t => t.ownerUserId === userStore.user?.id).length}` },
    { value: 'public', label: `公开 ${templates.value.filter(t => t.visibility === 'public').length}` },
    { value: 'builtin', label: `内置 ${templates.value.filter(t => t.isBuiltin).length}` },
  ]
  if (userStore.isAdmin) {
    opts.push({ value: 'others', label: `他人私有 ${templates.value.filter(t => t.ownerUserId !== null && t.ownerUserId !== userStore.user?.id && t.visibility === 'private').length}` })
  }
  return opts
})
const shown = computed(() => {
  const uid = userStore.user?.id
  switch (filter.value) {
    case 'mine': return templates.value.filter(t => t.ownerUserId === uid)
    case 'public': return templates.value.filter(t => t.visibility === 'public')
    case 'builtin': return templates.value.filter(t => t.isBuiltin)
    case 'others': return templates.value.filter(t => t.ownerUserId !== null && t.ownerUserId !== uid && t.visibility === 'private')
    default: return templates.value
  }
})

// 写权限:属主或 admin;内置/他人公开模板只读
const canWrite = (t: AgentTemplateDto): boolean =>
  !t.isBuiltin && (t.ownerUserId === userStore.user?.id || userStore.isAdmin)

const visTag = (t: AgentTemplateDto): { text: string, color: string, icon?: string } => {
  if (t.isBuiltin) return { text: '内置', color: 'default', icon: 'i-tabler-lock' }
  if (t.visibility === 'public') return { text: '公开', color: 'green' }
  return { text: '私有', color: 'default' }
}

const editOpen = ref(false)
const editing = ref<AgentTemplateDto | null>(null)
const form = reactive({ name: '', harness: 'mock', configJson: '{}', visibility: 'private' as 'private' | 'public' })
const openCreate = (): void => {
  editing.value = null
  form.name = ''
  form.harness = 'mock'
  form.configJson = '{}'
  form.visibility = 'private'
  editOpen.value = true
}
const openEdit = (t: AgentTemplateDto): void => {
  editing.value = t
  form.name = t.name
  form.harness = t.harness
  form.configJson = JSON.stringify(t.config ?? {}, null, 2)
  form.visibility = t.visibility
  editOpen.value = true
}
const save = async (): Promise<void> => {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(form.configJson || '{}')
  }
  catch {
    message.error('config 不是合法 JSON')
    return
  }
  try {
    if (editing.value) {
      await api.updateTemplate(editing.value.id, { name: form.name, harness: form.harness, config, visibility: form.visibility })
      message.success('已更新')
    }
    else {
      await api.createTemplate({ name: form.name, harness: form.harness, config, visibility: form.visibility })
      message.success('已创建')
    }
    editOpen.value = false
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}
const remove = async (t: AgentTemplateDto): Promise<void> => {
  await api.deleteTemplate(t.id)
  message.success('已删除')
  void load()
}

const toggleEnabled = async (t: AgentTemplateDto): Promise<void> => {
  await api.updateTemplate(t.id, { enabled: t.enabled === 1 ? 0 : 1 })
  void load()
}

/** 一键切换可见性(属主/admin;行内 switch) */
const toggleVisibility = async (t: AgentTemplateDto, pub: boolean): Promise<void> => {
  try {
    await api.updateTemplate(t.id, { visibility: pub ? 'public' : 'private' })
    message.success(pub ? '已公开:全员可读可用,仅你可修改' : '已转为私有')
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

useHead({ title: 'Agent 模板库 · Workshop' })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Agent 模板库</h2>
        <p class="sub">
          模板按用户隔离:私有仅本人可见;公开后全员可读可用(仅属主可修改);内置模板公开且不可变更。
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          返回工作区
        </a-button>
        <a-button
          type="primary"
          @click="openCreate"
        >
          新建模板
        </a-button>
      </a-space>
    </div>

    <div class="toolbar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="filterOptions"
      />
      <span
        v-if="userStore.isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> admin 视图:可见全部用户的模板与创建者</span>
    </div>

    <a-table
      :data-source="shown"
      :loading="loading"
      row-key="id"
      size="small"
      :pagination="false"
    >
      <a-table-column
        title="名称"
        data-index="name"
      >
        <template #default="{ record }">
          <span class="tpl-name">
            <span class="i-tabler-user-square" />
            {{ record.name }}
          </span>
        </template>
      </a-table-column>
      <a-table-column
        title="harness"
        data-index="harness"
        :width="100"
      />
      <a-table-column
        title="可见性"
        :width="120"
      >
        <template #default="{ record }">
          <a-tag
            :color="visTag(record).color"
            class="vis-tag"
          >
            <span
              v-if="visTag(record).icon"
              :class="visTag(record).icon"
            />{{ visTag(record).text }}
          </a-tag>
          <a-switch
            v-if="!record.isBuiltin && canWrite(record)"
            :checked="record.visibility === 'public'"
            size="small"
            checked-children="公开"
            un-checked-children="私有"
            :title="record.visibility === 'public' ? '点击转为私有' : '点击公开(全员可读可用)'"
            @change="(v: unknown) => toggleVisibility(record, v === true)"
          />
        </template>
      </a-table-column>
      <a-table-column
        title="创建者"
        :width="130"
      >
        <template #default="{ record }">
          <span class="owner">{{ record.ownerName ?? record.ownerUserId?.slice(0, 8) ?? '-' }}</span>
        </template>
      </a-table-column>
      <a-table-column
        title="实例数"
        :width="70"
      >
        <template #default="{ record }">
          {{ record.instances.length }}
        </template>
      </a-table-column>
      <a-table-column
        title="启用"
        :width="70"
      >
        <template #default="{ record }">
          <a-switch
            :checked="record.enabled === 1"
            size="small"
            :disabled="!canWrite(record)"
            @change="toggleEnabled(record)"
          />
        </template>
      </a-table-column>
      <a-table-column
        title="操作"
        :width="130"
      >
        <template #default="{ record }">
          <a-space size="small">
            <a-button
              size="small"
              type="text"
              :disabled="!canWrite(record)"
              :title="record.isBuiltin ? '内置模板不可修改' : !canWrite(record) ? '仅属主可修改' : '编辑'"
              @click="openEdit(record)"
            >
              编辑
            </a-button>
            <a-popconfirm
              title="删除模板?(已克隆实例保留)"
              :disabled="!canWrite(record)"
              @confirm="remove(record)"
            >
              <a-button
                size="small"
                type="text"
                danger
                :disabled="!canWrite(record)"
                :title="record.isBuiltin ? '内置模板不可删除' : '删除'"
              >
                删除
              </a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </a-table-column>
      <template #expandedRowRender="{ record }">
        <div
          v-for="inst in record.instances"
          :key="inst.id"
          class="inst"
        >
          <a-tag :color="inst.role === 'lead' ? 'gold' : 'blue'">
            {{ inst.role }}
          </a-tag>
          <span class="inst-id">{{ inst.id.slice(0, 8) }}</span>
          <span class="inst-ch">channel {{ inst.channelId.slice(0, 8) }}</span>
        </div>
        <div
          v-if="record.instances.length === 0"
          class="empty"
        >
          尚无实例
        </div>
      </template>
    </a-table>

    <a-modal
      v-model:open="editOpen"
      :title="editing ? '编辑模板' : '新建模板'"
      ok-text="保存"
      cancel-text="取消"
      @ok="save"
    >
      <a-form layout="vertical">
        <a-form-item label="名称">
          <a-input v-model:value="form.name" />
        </a-form-item>
        <a-form-item label="harness">
          <a-select
            v-model:value="form.harness"
            :options="[{ value: 'mock', label: 'mock(测试)' }, { value: 'omp', label: 'omp(真实 LLM)' }, { value: 'claude', label: 'claude' }]"
          />
        </a-form-item>
        <a-form-item label="可见性">
          <a-radio-group v-model:value="form.visibility">
            <a-radio value="private">
              私有(仅本人可见)
            </a-radio>
            <a-radio value="public">
              公开(全员可读可用,仅本人可修改)
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="config(JSON;mock 可配 delayMs)">
          <a-textarea
            v-model:value="form.configJson"
            :rows="6"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.admin-note {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 11px;
  color: var(--ink-faint);
}
.tpl-name {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.vis-tag {
  margin-right: 8px;
}
.owner { font-size: 12px; color: var(--ink-soft); }
.inst {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 2px 0;
  font-size: 12px;
}
.inst-id,
.inst-ch { font-family: ui-monospace, Consolas, monospace; opacity: 0.6; }
.empty { padding: 6px 0; font-size: 12px; opacity: 0.4; }
</style>
