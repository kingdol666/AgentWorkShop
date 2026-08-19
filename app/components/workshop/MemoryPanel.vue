<script setup lang="ts">
/**
 * 记忆面板:shared 公共域 / 按成员 private 域切换;
 * 混合检索(REST search,与 agent search_memory 工具同源)+ 手动写入 + 删除。
 * 身份凭证自动化:REST 记忆端点要求 Bearer agent token,成员列表(用户 token 可读)
 * 已含各成员 token → 自动装配;手动填 token 仅作为兜底(默认折叠)。
 * 传入 agentId(Agent 抽屉场景)时锁定身份,隐藏身份选择。
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId: string, agentId?: string }>()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const domain = ref<'shared' | 'private'>('shared')
const selectedAgent = ref<string>(props.agentId ?? '')
watch(() => props.agentId, (v) => {
  if (v) selectedAgent.value = v
})

/** 成员身份 → token 自动装配(用户 token 拉成员列表;失败退化为手填) */
const memberTokens = ref<Record<string, string>>({})
const manualToken = ref('')
const effectiveToken = computed(() =>
  manualToken.value.trim() || memberTokens.value[selectedAgent.value] || '',
)
const tokenResolved = computed(() => effectiveToken.value.length > 0)

const loadMembers = async (): Promise<void> => {
  try {
    const res = await api.listChannelAgents(props.channelId)
    const map: Record<string, string> = {}
    for (const m of res.data ?? []) {
      if (m.token) map[m.id] = m.token
    }
    memberTokens.value = map
    if (!selectedAgent.value) {
      // 默认身份:优先 lead(shared 域写入需 lead)
      const lead = (res.data ?? []).find(m => m.role === 'lead')
      if (lead) selectedAgent.value = lead.id
    }
  }
  catch { /* 拉取失败由手填兜底 */ }
}
onMounted(() => void loadMembers())
watch(() => props.channelId, () => {
  memberTokens.value = {}
  selectedAgent.value = props.agentId ?? ''
  void loadMembers()
})

const authHeaders = computed<Record<string, string>>(() => {
  const h: Record<string, string> = {}
  if (effectiveToken.value) h.authorization = `Bearer ${effectiveToken.value}`
  return h
})

const agents = computed(() => entities.agents[props.channelId] ?? [])

const rows = ref<Array<{ id: string, title: string, content: string, kind: string, importance: number, agentId: string }>>([])
const loading = ref(false)

const load = async (): Promise<void> => {
  loading.value = true
  try {
    const url = domain.value === 'shared'
      ? `/api/workshop/channels/${props.channelId}/memories`
      : `/api/workshop/channels/${props.channelId}/agents/${selectedAgent.value}/memories`
    const res = await fetch(url, { headers: authHeaders.value })
    const json = await res.json()
    rows.value = json.code === 0 ? json.data : []
    if (json.code !== 0) message.warning(json.message ?? '读取失败(检查成员身份)')
  }
  finally {
    loading.value = false
  }
}
watch([domain, selectedAgent, effectiveToken], () => {
  if (effectiveToken.value && (domain.value === 'shared' || selectedAgent.value)) void load()
})

const searchText = ref('')
const searchScope = ref<'auto' | 'private' | 'shared'>('auto')
const searchResults = ref<Array<{ id: string, title: string, content: string, score: number, source: string }>>([])
const searching = ref(false)
const doSearch = async (): Promise<void> => {
  if (!searchText.value.trim() || !selectedAgent.value || !effectiveToken.value) {
    message.warning('检索需要关键词与成员身份')
    return
  }
  searching.value = true
  try {
    const res = await fetch(`/api/workshop/channels/${props.channelId}/agents/${selectedAgent.value}/memories/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders.value },
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
  if (!writeForm.title || !writeForm.content || !selectedAgent.value || !effectiveToken.value) {
    message.warning('标题/内容/成员身份必填')
    return
  }
  const res = await fetch(
    `/api/workshop/channels/${props.channelId}/agents/${selectedAgent.value}/memories`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders.value },
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
        v-if="!agentId"
        v-model:value="selectedAgent"
        size="small"
        placeholder="成员身份"
        class="agent-select"
        :options="agents.map(a => ({ value: a.agentId, label: a.name }))"
      />
      <a-tooltip :title="tokenResolved ? '成员 token 已自动装配' : '自动装配失败,可手动填入成员 token'">
        <span
          class="token-state"
          :data-ok="tokenResolved"
        >🔑{{ tokenResolved ? 'auto' : '手动' }}</span>
      </a-tooltip>
    </div>
    <a-input-password
      v-if="!tokenResolved"
      v-model:value="manualToken"
      size="small"
      placeholder="Bearer token(成员身份,兜底手填)"
      class="token"
    />

    <div class="search-bar">
      <a-input-search
        v-model:value="searchText"
        size="small"
        placeholder="混合检索记忆(FTS+向量,与 agent search_memory 同源)…"
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
        :title="s.content.slice(0, 200)"
      >
        <span
          class="src"
          :data-source="s.source"
        >{{ s.source }}</span>
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
          <span class="row-importance">{{ r.importance.toFixed(2) }}</span>
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
              shared(公共域,全员可检索)
            </a-radio>
            <a-radio value="private">
              private(本人)
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
  align-items: center;
  margin-bottom: 6px;
}
.agent-select { flex: 1 1 auto; min-width: 90px; }
.token-state {
  flex: 0 0 auto;
  padding: 0 5px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.token-state[data-ok='true'] { color: #52c41a; }
.token-state[data-ok='false'] { color: #fa8c16; }
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
.src[data-source='shared'] { background: #9254de99; }
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
.row-importance { font-family: ui-monospace, Consolas, monospace; font-size: 10px; opacity: 0.5; }
.row-title { font-weight: 600; font-size: 12px; }
.row-content {
  font-size: 11px;
  opacity: 0.65;
  word-break: break-all;
}
.empty { padding: 8px 0; opacity: 0.4; }
</style>
