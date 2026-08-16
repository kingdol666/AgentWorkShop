<script setup lang="ts">
/**
 * 记忆面板:shared 公共域 / 按成员 private 域切换;
 * 混合检索(REST search,与 agent search_memory 工具同源)+ 手动写入 + 删除。
 * 说明:REST 记忆端点要求 Bearer agent token(成员身份);
 * P0 阶段从 channel 成员列表选择身份并填入 token(设置页可存默认 token)。
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '../../stores/workshop/entities'

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()

const domain = ref<'shared' | 'private'>('shared')
const selectedAgent = ref<string>('')
const tokenInput = ref<string>('')
const rows = ref<Array<{ id: string, title: string, content: string, kind: string, importance: number, agentId: string }>>([])
const loading = ref(false)

const agents = computed(() => entities.agents[props.channelId] ?? [])

const load = async (): Promise<void> => {
  loading.value = true
  try {
    if (domain.value === 'shared') {
      const res = await fetch(`/api/workshop/channels/${props.channelId}/memories`, {
        headers: tokenInput.value ? { authorization: `Bearer ${tokenInput.value}` } : {},
      })
      const json = await res.json()
      rows.value = json.code === 0 ? json.data : []
      if (json.code !== 0) message.warning(`需要成员 token(${json.message})`)
    }
    else {
      if (!selectedAgent.value) {
        rows.value = []
        return
      }
      const res = await fetch(`/api/workshop/channels/${props.channelId}/agents/${selectedAgent.value}/memories`, {
        headers: tokenInput.value ? { authorization: `Bearer ${tokenInput.value}` } : {},
      })
      const json = await res.json()
      rows.value = json.code === 0 ? json.data : []
      if (json.code !== 0) message.warning(`需要成员 token(${json.message})`)
    }
  }
  finally {
    loading.value = false
  }
}
watch([domain, selectedAgent], () => void load())

const searchText = ref('')
const searchScope = ref<'auto' | 'private' | 'shared'>('auto')
const searchResults = ref<Array<{ id: string, title: string, content: string, score: number, source: string }>>([])
const searching = ref(false)
const doSearch = async (): Promise<void> => {
  if (!searchText.value.trim() || !selectedAgent.value) {
    message.warning('检索需要关键词与成员身份')
    return
  }
  searching.value = true
  try {
    const res = await fetch(`/api/workshop/channels/${props.channelId}/agents/${selectedAgent.value}/memories/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tokenInput.value ? { authorization: `Bearer ${tokenInput.value}` } : {}) },
      body: JSON.stringify({ query: searchText.value, scope: searchScope.value, limit: 8 }),
    })
    const json = await res.json()
    searchResults.value = json.code === 0 ? json.data : []
  }
  finally {
    searching.value = false
  }
}

const writeOpen = ref(false)
const writeForm = reactive({ title: '', content: '', scope: 'shared' as 'shared' | 'private', importance: 0.8, dedupKey: '' })
const doWrite = async (): Promise<void> => {
  if (!writeForm.title || !writeForm.content || !selectedAgent.value) {
    message.warning('标题/内容/身份必填')
    return
  }
  const res = await fetch(
    `/api/workshop/channels/${props.channelId}/agents/${domain.value === 'shared' ? selectedAgent.value : selectedAgent.value}/memories`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tokenInput.value ? { authorization: `Bearer ${tokenInput.value}` } : {}) },
      body: JSON.stringify({ ...writeForm, dedupKey: writeForm.dedupKey || undefined }),
    },
  )
  const json = await res.json()
  if (json.code === 0) {
    message.success('已写入')
    writeOpen.value = false
    writeForm.title = ''
    writeForm.content = ''
    void load()
  }
  else {
    message.error(json.message ?? '写入失败')
  }
}
</script>

<template>
  <div class="memory-panel">
    <div class="toolbar">
      <a-radio-group
        v-model:value="domain"
        size="small"
        button-style="solid"
      >
        <a-radio-button value="shared">
          公共域
        </a-radio-button>
        <a-radio-button value="private">
          私有域
        </a-radio-button>
      </a-radio-group>
      <a-select
        v-model:value="selectedAgent"
        size="small"
        placeholder="成员身份"
        class="agent-select"
        :options="agents.map(a => ({ value: a.agentId, label: a.name }))"
      />
    </div>
    <a-input-password
      v-model:value="tokenInput"
      size="small"
      placeholder="Bearer token(成员身份)"
      class="token"
    />

    <div class="search-bar">
      <a-input-search
        v-model:value="searchText"
        size="small"
        placeholder="混合检索记忆…"
        :loading="searching"
        @search="doSearch"
      />
      <a-select
        v-model:value="searchScope"
        size="small"
        class="scope"
        :options="[{ value: 'auto', label: 'auto' }, { value: 'private', label: 'private' }, { value: 'shared', label: 'shared' }]"
      />
    </div>
    <div
      v-if="searchResults.length"
      class="search-results"
    >
      <div
        v-for="s in searchResults"
        :key="s.id"
        class="hit"
      >
        <span class="src">{{ s.source }}</span>
        <span class="score">{{ s.score }}</span>
        <span class="hit-title">{{ s.title }}</span>
      </div>
    </div>

    <div class="list-head">
      <span>记忆列表</span>
      <a-space size="small">
        <a-button
          size="small"
          type="text"
          @click="load"
        >
          刷新
        </a-button>
        <a-button
          size="small"
          type="text"
          @click="writeOpen = true"
        >
          写入
        </a-button>
      </a-space>
    </div>
    <a-spin :spinning="loading">
      <div
        v-for="r in rows"
        :key="r.id"
        class="row"
      >
        <div class="row-head">
          <a-tag class="kind">
            {{ r.kind }}
          </a-tag>
          <span class="row-title">{{ r.title }}</span>
        </div>
        <div class="row-content">
          {{ r.content.slice(0, 140) }}{{ r.content.length > 140 ? '…' : '' }}
        </div>
      </div>
      <div
        v-if="rows.length === 0 && !loading"
        class="empty"
      >
        (空)
      </div>
    </a-spin>

    <a-modal
      v-model:open="writeOpen"
      title="写入记忆"
      ok-text="写入"
      cancel-text="取消"
      @ok="doWrite"
    >
      <a-form layout="vertical">
        <a-form-item label="scope">
          <a-radio-group v-model:value="writeForm.scope">
            <a-radio value="shared">
              shared(公共域)
            </a-radio>
            <a-radio value="private">
              private
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="标题">
          <a-input v-model:value="writeForm.title" />
        </a-form-item>
        <a-form-item label="内容">
          <a-textarea
            v-model:value="writeForm.content"
            :rows="4"
          />
        </a-form-item>
        <a-form-item label="importance(0-1)">
          <a-input-number
            v-model:value="writeForm.importance"
            :min="0"
            :max="1"
            :step="0.1"
          />
        </a-form-item>
        <a-form-item label="dedupKey(可选,幂等)">
          <a-input v-model:value="writeForm.dedupKey" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.memory-panel { font-size: 12px; }
.toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.agent-select { flex: 1 1 auto; min-width: 90px; }
.token { margin-bottom: 6px; }
.search-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.scope { width: 90px; }
.search-results { margin-bottom: 8px; }
.hit {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 2px 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}
.src {
  padding: 0 4px;
  color: #fff;
  background: #1677ff99;
  border-radius: 3px;
}
.score { opacity: 0.5; }
.hit-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-weight: 600;
  opacity: 0.7;
}
.row { padding: 4px 0; border-bottom: 1px dashed color-mix(in srgb, currentColor 10%, transparent); }
.row-head { display: flex; gap: 6px; align-items: center; }
.kind { margin-inline-end: 0; font-size: 10px; }
.row-title { font-weight: 600; font-size: 12px; }
.row-content {
  font-size: 11px;
  opacity: 0.65;
  word-break: break-all;
}
.empty { padding: 8px 0; opacity: 0.4; }
</style>
