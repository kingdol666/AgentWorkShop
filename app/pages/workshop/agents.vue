<script setup lang="ts">
/**
 * Agent 模板库(P1):全局可复用模板 CRUD + 实例去向(克隆到了哪些 channel)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type AgentTemplateDto } from '../../composables/workshop/useWorkshopApi'

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
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

const editOpen = ref(false)
const editing = ref<AgentTemplateDto | null>(null)
const form = reactive({ name: '', harness: 'mock', configJson: '{}' })
const openCreate = (): void => {
  editing.value = null
  form.name = ''
  form.harness = 'mock'
  form.configJson = '{}'
  editOpen.value = true
}
const openEdit = (t: AgentTemplateDto): void => {
  editing.value = t
  form.name = t.name
  form.harness = t.harness
  form.configJson = JSON.stringify(t.config ?? {}, null, 2)
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
      await api.updateTemplate(editing.value.id, { name: form.name, harness: form.harness, config })
      message.success('已更新')
    }
    else {
      await api.createTemplate({ name: form.name, harness: form.harness, config })
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

useHead({ title: 'Agent 模板库 · Workshop' })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Agent 模板库</h2>
        <p class="sub">
          全局可复用 Agent 定义;克隆进 Channel 生成独立实例(实例去向见展开行)。
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

    <a-table
      :data-source="templates"
      :loading="loading"
      row-key="id"
      size="small"
      :pagination="false"
    >
      <a-table-column
        title="名称"
        data-index="name"
      />
      <a-table-column
        title="harness"
        data-index="harness"
        :width="110"
      />
      <a-table-column
        title="实例数"
        :width="80"
      >
        <template #default="{ record }">
          {{ record.instances.length }}
        </template>
      </a-table-column>
      <a-table-column
        title="启用"
        :width="80"
      >
        <template #default="{ record }">
          <a-switch
            :checked="record.enabled === 1"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>
      </a-table-column>
      <a-table-column
        title="操作"
        :width="140"
      >
        <template #default="{ record }">
          <a-space size="small">
            <a-button
              size="small"
              type="text"
              @click="openEdit(record)"
            >
              编辑
            </a-button>
            <a-popconfirm
              title="删除模板?(已克隆实例保留)"
              @confirm="remove(record)"
            >
              <a-button
                size="small"
                type="text"
                danger
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
          <a-tag :color="inst.role === 'lead' ? 'purple' : 'blue'">
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
  margin-bottom: 16px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }
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
