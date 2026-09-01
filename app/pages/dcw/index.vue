<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { DCW_LINE_COLORS, type DcwTemplateIcon, type LineView } from '#shared/dcw-protocol'
import { useDcwStream } from '~/composables/workshop/useDcwStream'

const { t } = useI18n()

const dcw = useDcwStream()
void dcw.load()

// ---------- 产线总览 ----------
interface LineCard {
  line: LineView
  nodes: number
  products: number
  recipes: number
}

const cards = computed<LineCard[]>(() =>
  dcw.lines.map(line => ({
    line,
    nodes: dcw.nodes.filter(n => n.lineId === line.id).length,
    products: dcw.products.filter(p => p.lineId === line.id).length,
    recipes: dcw.recipes.filter(r => r.lineId === line.id).length,
  })),
)
const unassignedCount = computed(() =>
  dcw.nodes.filter(n => !n.lineId).length + dcw.products.filter(p => !p.lineId).length,
)

// ---------- 清单筛选(94 条历史线的管理页:导航先于遍历) ----------
const filterState = ref<'all' | 'running' | 'idle'>('all')
const searchText = ref('')
const runningCount = computed(() => cards.value.filter(c => dcw.lineStateOf(c.line.id).active).length)
const shownCards = computed(() => cards.value.filter((c) => {
  const active = dcw.lineStateOf(c.line.id).active
  if (filterState.value === 'running' && !active) return false
  if (filterState.value === 'idle' && active) return false
  const q = searchText.value.trim().toLowerCase()
  if (q && !c.line.name.toLowerCase().includes(q) && !(c.line.description ?? '').toLowerCase().includes(q)) return false
  return true
}))

// ---------- 新建产线 ----------
const createOpen = ref(false)
const createSaving = ref(false)
const createError = ref('')
const createForm = reactive({ name: '', description: '', color: '' })

const nextColor = computed(() => DCW_LINE_COLORS[dcw.lines.length % DCW_LINE_COLORS.length] ?? '#3aa0ff')

function openCreate(): void {
  createForm.name = ''
  createForm.description = ''
  createForm.color = ''
  createError.value = ''
  createOpen.value = true
}

async function doCreateLine(): Promise<void> {
  createSaving.value = true
  createError.value = ''
  try {
    await dcw.createLine({
      name: createForm.name.trim(),
      description: createForm.description.trim(),
      color: createForm.color || undefined,
    })
    createOpen.value = false
  }
  catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    createSaving.value = false
  }
}

// ---------- 快捷启停(卡片上) ----------
const quickBusy = ref('')
const quickErr = ref('')
const quickPick = reactive<Record<string, string>>({})

async function quickStart(card: LineCard): Promise<void> {
  quickBusy.value = card.line.id
  quickErr.value = ''
  try {
    const rid = quickPick[card.line.id] ?? ''
    if (!rid) throw new Error(t('dcw.k188cswn039'))
    await dcw.startLine(card.line.id, rid)
  }
  catch (err) {
    quickErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    quickBusy.value = ''
  }
}

async function quickStop(card: LineCard): Promise<void> {
  quickBusy.value = card.line.id
  quickErr.value = ''
  try {
    await dcw.stopLine(card.line.id)
  }
  catch (err) {
    quickErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    quickBusy.value = ''
  }
}

/** 卡片配方下拉:本产线配方(继承自产品) */
function recipesOf(lineId: string) {
  return dcw.recipes.filter(r => r.lineId === lineId)
}

/** 删除产线(弹窗两步确认;purge 勾选 = 连同旗下节点/产品/配方一并清理) */
const delOpen = ref(false)
const delBusy = ref(false)
const delErr = ref('')
const delPurge = ref(true)
const delCard = ref<LineCard | null>(null)

function openDelete(card: LineCard): void {
  delCard.value = card
  delPurge.value = true
  delErr.value = ''
  delOpen.value = true
}

async function doDeleteLine(): Promise<void> {
  if (!delCard.value)
    return
  delBusy.value = true
  delErr.value = ''
  try {
    await dcw.removeLine(delCard.value.line.id, delPurge.value)
    delOpen.value = false
  }
  catch (err) {
    delErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    delBusy.value = false
  }
}

/** 编辑产线(名称/描述/光晕色) */
const editOpen = ref(false)
const editSaving = ref(false)
const editError = ref('')
const editForm = reactive({ id: '', name: '', description: '', color: '' })

function openEdit(card: LineCard): void {
  editForm.id = card.line.id
  editForm.name = card.line.name
  editForm.description = card.line.description
  editForm.color = card.line.color
  editError.value = ''
  editOpen.value = true
}

async function doEditLine(): Promise<void> {
  editSaving.value = true
  editError.value = ''
  try {
    await dcw.updateLine(editForm.id, {
      name: editForm.name.trim(),
      description: editForm.description.trim(),
      color: editForm.color || undefined,
    })
    editOpen.value = false
  }
  catch (err) {
    editError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    editSaving.value = false
  }
}

// ---------- 控制模板管理(自定义分类) ----------
const tplOpen = ref(false)
const tplError = ref('')
const tplForm = reactive({ name: '', ch: '', code: '', unit: '', min: '' as number | '', max: '' as number | '', decimals: 1, icon: 'gateway' as DcwTemplateIcon, semantics: '' })
const tplIcons: Array<{ key: DcwTemplateIcon, label: string }> = [
  { key: 'thermo', label: t('dcw.k422b8040') },
  { key: 'pressure', label: t('dcw.k3x6ff041') },
  { key: 'tension', label: t('dcw.k3z9xc042') },
  { key: 'encoder', label: t('dcw.kjb3vhs043') },
  { key: 'camera', label: t('dcw.k47atw044') },
  { key: 'gateway', label: t('dcw.k48c07045') },
]

async function doCreateTemplate(): Promise<void> {
  tplError.value = ''
  try {
    if (!tplForm.name.trim()) throw new Error(t('dcw.k6ugbw2046'))
    if (tplForm.min === '' || tplForm.max === '') throw new Error(t('dcw.k13awowo047'))
    await dcw.createTemplate({
      name: tplForm.name.trim(),
      ch: tplForm.ch.trim() || tplForm.name.trim(),
      code: tplForm.code.trim() || 'CUSTOM',
      unit: tplForm.unit.trim() || '-',
      min: Number(tplForm.min),
      max: Number(tplForm.max),
      decimals: Number(tplForm.decimals) || 0,
      icon: tplForm.icon,
      semantics: tplForm.semantics.trim() || undefined,
    })
    tplForm.name = ''
    tplForm.ch = ''
    tplForm.code = ''
    tplForm.unit = ''
    tplForm.min = ''
    tplForm.max = ''
  }
  catch (err) {
    tplError.value = err instanceof Error ? err.message : String(err)
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
    const i = dcw.templates.findIndex(t => t.key === key)
    if (i >= 0) dcw.templates.splice(i, 1)
  }
  catch (err) {
    tplError.value = err instanceof Error ? err.message : String(err)
  }
}

const builtinCount = computed(() => dcw.templates.filter(t => t.builtin).length)
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / LINE OPERATIONS
        </p>
        <h1>{{ $t('dcw.k1b2tk5c009') }}</h1>
        <p class="sub">
          {{ $t('dcw.k5q0aqi010') }}
        </p>
      </div>
      <div class="badges mono">
        <span
          v-if="unassignedCount"
          class="badge warn-badge"
          :title="$t('dcw.k1i5a9vw001')"
        >{{ $t('dcw.k3ootr6049') }} {{ unassignedCount }}</span>
        <span class="badge">{{ $t('dcw.k3wj9n050') }} {{ dcw.lines.length }}</span>
        <button
          class="badge tpl-btn"
          @click="tplOpen = true"
        >
          {{ $t('dcw.k11nndsp051') }} {{ dcw.templates.length }}
        </button>
      </div>
    </div>

    <p
      v-if="quickErr"
      class="banner bad"
    >
      {{ quickErr }}
    </p>

    <!-- 清单筛选:状态分段 + 名称搜索(复用 aw-seg / 页内 inp 语言) -->
    <div class="fleet-filter">
      <div class="aw-seg">
        <button
          :class="{ on: filterState === 'all' }"
          @click="filterState = 'all'"
        >
          {{ $t('common.all') }} {{ cards.length }}
        </button>
        <button
          :class="{ on: filterState === 'running' }"
          @click="filterState = 'running'"
        >
          {{ $t('dcw.k1eox1el055') }} {{ runningCount }}
        </button>
        <button
          :class="{ on: filterState === 'idle' }"
          @click="filterState = 'idle'"
        >
          {{ $t('dcw.k149r6y7059') }} {{ cards.length - runningCount }}
        </button>
      </div>
      <input
        v-model="searchText"
        class="inp fleet-search"
        type="search"
        :placeholder="$t('dcw.filterSearchPh')"
      >
    </div>

    <!-- 产线卡片栅格 -->
    <div class="line-grid">
      <div
        v-for="c in shownCards"
        :key="c.line.id"
        class="line-card"
        :class="{ idle: !dcw.lineStateOf(c.line.id).active }"
        :style="{ '--lc': c.line.color }"
      >
        <div class="lc-head">
          <span class="lc-dot" />
          <b class="lc-name">{{ c.line.name }}</b>
          <span
            class="lc-state"
            :class="{ on: dcw.lineStateOf(c.line.id).active }"
          >{{ dcw.lineStateOf(c.line.id).active ? $t('dcw.k1eox1el055') : $t('dcw.k149r6y7059') }}</span>
          <button
            class="lc-act"
            :title="$t('common.edit')"
            @click="openEdit(c)"
          >
            <span class="i-tabler-pencil" />
          </button>
          <button
            class="lc-act danger"
            :title="$t('dcw.k3xakp026')"
            @click="openDelete(c)"
          >
            <span class="i-tabler-trash" />
          </button>
        </div>
        <small
          v-if="dcw.lineStateOf(c.line.id).active"
          class="lc-run mono"
        >{{ dcw.lineStateOf(c.line.id).productName }} · {{ dcw.lineStateOf(c.line.id).recipeName }} · {{ $t('dcw.k3zz0f052') }} {{ dcw.lineStateOf(c.line.id).taggedSamples }}</small>
        <small
          v-else
          class="lc-run dim"
          :class="{ ph: !c.line.description }"
        >{{ c.line.description || $t('dcw.k18moyq1056') }}</small>
        <div class="lc-stats mono">
          <span>{{ $t('dcw.k45uio011') }} <b>{{ c.nodes }}</b></span>
          <span>{{ $t('dcw.k3waz1012') }} <b>{{ c.products }}</b></span>
          <span>{{ $t('dcw.k48grv013') }} <b>{{ c.recipes }}</b></span>
        </div>
        <div class="lc-ctl">
          <template v-if="!dcw.lineStateOf(c.line.id).active">
            <select
              v-model="quickPick[c.line.id]"
              class="inp"
              :disabled="recipesOf(c.line.id).length === 0"
              :title="$t('dcw.k1dhaby4003')"
            >
              <option value="">
                {{ recipesOf(c.line.id).length ? $t('dcw.kutxzsz057') : $t('dcw.k1elczt9060') }}
              </option>
              <option
                v-for="r in recipesOf(c.line.id)"
                :key="r.id"
                :value="r.id"
                :disabled="r.params.length === 0"
              >
                {{ r.name }}({{ r.params.length }})
              </option>
            </select>
            <button
              class="pill-btn"
              :disabled="quickBusy === c.line.id || !quickPick[c.line.id]"
              @click="quickStart(c)"
            >
              {{ $t('dcw.k149b4vg014') }}
            </button>
          </template>
          <button
            v-else
            class="pill-btn stop"
            :disabled="quickBusy === c.line.id"
            @click="quickStop(c)"
          >
            {{ $t('dcw.k148rclf015') }}
          </button>
        </div>
        <NuxtLink
          class="lc-manage"
          :to="`/dcw/${c.line.id}`"
        >
          {{ $t('dcw.k1fwqw5g016') }}
        </NuxtLink>
      </div>

      <!-- 新建产线卡 -->
      <button
        class="line-card new-card"
        @click="openCreate"
      >
        <span class="i-tabler-plus" />
        {{ $t('dcw.k1efe391017') }}
        <small>{{ $t('dcw.k19dlbli053') }}{{ nextColor }})</small>
      </button>
    </div>

    <p
      v-if="dcw.loaded && dcw.lines.length === 0"
      class="banner"
    >
      {{ $t('dcw.k1sk85vs018') }}
    </p>
    <p
      v-else-if="dcw.loaded && shownCards.length === 0"
      class="banner"
    >
      {{ $t('dcw.filterEmpty') }}
    </p>

    <!-- 新建产线弹窗 -->
    <Transition name="modal">
      <div
        v-if="createOpen"
        class="modal-mask"
        @click.self="createOpen = false"
      >
        <div class="modal">
          <h3 class="m-title">
            {{ $t('dcw.k1efe391017') }}
          </h3>
          <label class="f">
            <span>{{ $t('dcw.k1b2ioko019') }}<em>*</em></span>
            <input
              v-model="createForm.name"
              class="inp"
              :placeholder="$t('dcw.kru37i3004')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k24dxcd020') }}</span>
            <input
              v-model="createForm.description"
              class="inp"
              :placeholder="$t('dcw.k1f2nwsp005')"
            >
          </label>
          <div class="f">
            <span>{{ $t('dcw.k1x7nubr021') }}</span>
            <div class="color-row">
              <button
                v-for="c in DCW_LINE_COLORS"
                :key="c"
                class="color-dot"
                :class="{ on: createForm.color === c }"
                :style="{ background: c }"
                @click="createForm.color = createForm.color === c ? '' : c"
              />
              <small class="dim">{{ createForm.color || $t('dcw.k1qidbpy061', { p0: nextColor }) }}</small>
            </div>
          </div>
          <p
            v-if="createError"
            class="m-err"
          >
            {{ createError }}
          </p>
          <div class="m-actions">
            <button
              class="mini-btn"
              @click="createOpen = false"
            >
              {{ $t('dcw.k3xdnn022') }}
            </button>
            <button
              class="pill-btn"
              :disabled="createSaving || !createForm.name.trim()"
              @click="doCreateLine"
            >
              {{ $t('dcw.k3wzi2023') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 编辑产线弹窗 -->
    <Transition name="modal">
      <div
        v-if="editOpen"
        class="modal-mask"
        @click.self="editOpen = false"
      >
        <div class="modal">
          <h3 class="m-title">
            {{ $t('dcw.k5tq8wc071') }}
          </h3>
          <label class="f">
            <span>{{ $t('dcw.k1b2ioko019') }}<em>*</em></span>
            <input
              v-model="editForm.name"
              class="inp"
              :placeholder="$t('dcw.kru37i3004')"
            >
          </label>
          <label class="f">
            <span>{{ $t('dcw.k24dxcd020') }}</span>
            <input
              v-model="editForm.description"
              class="inp"
              :placeholder="$t('dcw.k1f2nwsp005')"
            >
          </label>
          <div class="f">
            <span>{{ $t('dcw.k1x7nubr021') }}</span>
            <div class="color-row">
              <button
                v-for="c in DCW_LINE_COLORS"
                :key="c"
                class="color-dot"
                :class="{ on: editForm.color === c }"
                :style="{ background: c }"
                @click="editForm.color = editForm.color === c ? '' : c"
              />
              <small class="dim">{{ editForm.color || $t('dcw.k1qidbpy061', { p0: nextColor }) }}</small>
            </div>
          </div>
          <p
            v-if="editError"
            class="m-err"
          >
            {{ editError }}
          </p>
          <div class="m-actions">
            <button
              class="mini-btn"
              @click="editOpen = false"
            >
              {{ $t('dcw.k3xdnn022') }}
            </button>
            <button
              class="pill-btn"
              :disabled="editSaving || !editForm.name.trim()"
              @click="doEditLine"
            >
              {{ $t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 删除产线弹窗(两步确认;purge 勾选决定是否级联清理) -->
    <Transition name="modal">
      <div
        v-if="delOpen && delCard"
        class="modal-mask"
        @click.self="delOpen = false"
      >
        <div class="modal">
          <h3 class="m-title danger-title">
            <span class="i-tabler-alert-triangle" />
            {{ $t('dcw.k7xq2mfd063', { p0: delCard.line.name }) }}
          </h3>
          <p class="del-summary">
            {{ delPurge
              ? $t('dcw.k4r7nbd073', { p0: delCard.line.name, p1: delCard.nodes, p2: delCard.products, p3: delCard.recipes })
              : $t('dcw.k1gp649b062', { p0: delCard.line.name, p1: delCard.nodes, p2: delCard.products, p3: delCard.recipes }) }}
          </p>
          <label class="del-purge">
            <input
              v-model="delPurge"
              type="checkbox"
            >
            <span>{{ $t('dcw.k9m2vxa072') }}</span>
          </label>
          <p
            v-if="delErr"
            class="m-err"
          >
            {{ delErr }}
          </p>
          <div class="m-actions">
            <button
              class="mini-btn"
              @click="delOpen = false"
            >
              {{ $t('dcw.k3xdnn022') }}
            </button>
            <button
              class="pill-btn danger"
              :disabled="delBusy"
              @click="doDeleteLine"
            >
              {{ $t('dcw.k3xakp026') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 控制模板管理弹窗 -->
    <Transition name="modal">
      <div
        v-if="tplOpen"
        class="modal-mask"
        @click.self="tplOpen = false"
      >
        <div class="modal wide">
          <h3 class="m-title">
            {{ $t('dcw.k11oadmx024') }} <small class="dim mono">{{ $t('dcw.k3x23c054') }} {{ builtinCount }} · {{ $t('dcw.k3t616a058') }} {{ dcw.templates.length - builtinCount }}</small>
          </h3>
          <p class="dim tpl-hint">
            {{ $t('dcw.k2hlav5025') }}
          </p>
          <div class="tpl-list">
            <div
              v-for="t in dcw.templates"
              :key="t.key"
              class="tpl-row"
              :title="t.semantics ?? ''"
            >
              <b>{{ t.name }}</b>
              <small class="mono dim">{{ t.code }} · {{ t.min }}~{{ t.max }} {{ t.unit }}</small>
              <small
                v-if="t.semantics"
                class="tpl-sem"
              >{{ t.semantics.slice(0, 40) }}{{ t.semantics.length > 40 ? '…' : '' }}</small>
              <span
                class="tpl-tag"
                :class="{ builtin: t.builtin }"
              >{{ t.builtin ? $t('dcw.k3x23c054') : $t('dcw.k3t616a058') }}</span>
              <button
                v-if="!t.builtin"
                class="mini-btn danger"
                @click="doRemoveTemplate(t.key)"
              >
                {{ $t('dcw.k3xakp026') }}
              </button>
            </div>
          </div>
          <p class="sec-label">
            {{ $t('dcw.k169eb4s027') }}
          </p>
          <div class="tpl-form">
            <label class="f">
              <span>{{ $t('dcw.k3xhia028') }}<em>*</em></span>
              <input
                v-model="tplForm.name"
                class="inp"
                :placeholder="$t('dcw.k1tooi3o006')"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k1bqk219029') }}</span>
              <input
                v-model="tplForm.ch"
                class="inp"
                :placeholder="$t('dcw.k698qz0007')"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k1ayxrqb030') }}</span>
              <input
                v-model="tplForm.code"
                class="inp"
                placeholder="如 MOTOR · I"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k3x4ef031') }}</span>
              <input
                v-model="tplForm.unit"
                class="inp"
                placeholder="如 A"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k1l9jv5m032') }}<em>*</em></span>
              <input
                v-model.number="tplForm.min"
                type="number"
                class="inp"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k1l9jv4p033') }}<em>*</em></span>
              <input
                v-model.number="tplForm.max"
                type="number"
                class="inp"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k3mxmcx034') }}</span>
              <input
                v-model.number="tplForm.decimals"
                type="number"
                class="inp"
              >
            </label>
            <label class="f">
              <span>{{ $t('dcw.k3xx56035') }}</span>
              <select
                v-model="tplForm.icon"
                class="inp"
              >
                <option
                  v-for="ic in tplIcons"
                  :key="ic.key"
                  :value="ic.key"
                >
                  {{ ic.label }}
                </option>
              </select>
            </label>
          </div>
          <label class="f">
            <span>{{ $t('dcw.k1b6qorg036') }}</span>
            <textarea
              v-model="tplForm.semantics"
              class="inp"
              rows="3"
              :placeholder="$t('dcw.k1qdnfzc008')"
            />
          </label>
          <p
            v-if="tplError"
            class="m-err"
          >
            {{ tplError }}
          </p>
          <div class="m-actions">
            <button
              class="mini-btn"
              @click="tplOpen = false"
            >
              {{ $t('dcw.k3x62t037') }}
            </button>
            <button
              class="pill-btn"
              :disabled="!tplForm.name.trim() || tplForm.min === '' || tplForm.max === ''"
              @click="doCreateTemplate"
            >
              {{ $t('dcw.k1bg9nga038') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <p
      v-if="dcw.error"
      class="banner bad"
    >
      {{ dcw.error }}
    </p>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 14px; }
.badges { display: flex; gap: 8px; }
/* 状态徽章 = 玻璃芯片:双主题令牌化,浅色不再发白发黄 */
.badge {
  padding: 3px 10px;
  font-size: 11px;
  color: var(--ink-faint);
  background: var(--glass-bg);
  border: 1px solid var(--glass-line);
  border-radius: 999px;
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
}
.warn-badge { color: var(--tone-warning-dot); background: var(--tone-warning-bg); border-color: color-mix(in srgb, var(--tone-warning-dot) 32%, transparent); }
.tpl-btn { color: var(--tone-info-dot); background: var(--tone-info-bg); border-color: color-mix(in srgb, var(--tone-info-dot) 34%, transparent); cursor: pointer; }
.tpl-btn:hover { border-color: color-mix(in srgb, var(--tone-info-dot) 60%, transparent); }

/* 清单筛选条:状态分段 + 搜索(与页内控件同一语言) */
.fleet-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}
.fleet-filter .aw-seg button {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.fleet-search {
  width: 220px;
  margin-left: auto;
  height: 30px;
  padding: 0 10px;
  font-size: 11.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
}
.fleet-search:focus { outline: none; border-color: var(--tone-success-dot); box-shadow: 0 0 0 3px var(--accent-soft); }
.line-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
/* 产线卡 = Aurora Glass 仪表砖:半透 surface + 深模糊 + 内缘折射;
   运行卡在玻璃顶缘叠一线产线色洗染做「图」,待机卡收敛为磨砂做「底」 */
.line-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  text-align: left;
  background: var(--surface-glass);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge);
  transition: border-color var(--transition-base), transform var(--transition-base), box-shadow var(--transition-base);
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .line-card:hover {
    border-color: color-mix(in srgb, var(--lc, #3aa0ff) 55%, var(--line-strong));
    transform: translateY(-2px);
    box-shadow: var(--glass-edge), var(--shadow-float);
  }
}
.line-card:not(.idle) {
  border-color: color-mix(in srgb, var(--lc, #3aa0ff) 38%, var(--line-strong));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--lc, #3aa0ff) 9%, transparent), transparent 46%),
    var(--surface-glass);
}
.line-card.idle {
  background: var(--frost-bg);
}
.line-card.idle .lc-dot {
  box-shadow: none;
  opacity: 0.72;
}
.line-card.idle .lc-name {
  color: var(--ink-faint);
}
.lc-head { display: flex; gap: 8px; align-items: center; }
.lc-dot {
  width: 10px;
  height: 10px;
  flex: none;
  background: var(--lc);
  border-radius: 4px;
  box-shadow: 0 0 10px color-mix(in srgb, var(--lc) 70%, transparent);
}
.lc-name {
  overflow: hidden;
  font-size: 14.5px;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lc-state {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-fainter);
}
.lc-state.on { color: var(--tone-success-dot); }
/* 头部图标钮:编辑/删除,悬停语义色染色 */
.lc-act {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 13px;
  color: var(--ink-fainter);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    opacity 0.15s ease,
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.line-card:hover .lc-act,
.line-card:focus-within .lc-act { opacity: 1; }
.lc-act:hover { color: var(--tone-info-dot); background: var(--tone-info-bg); }
.lc-act.danger:hover { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.lc-act:active { transform: scale(0.9); }
.lc-run { font-size: 10.5px; color: var(--tone-info-dot); }
.lc-run.dim { color: var(--ink-fainter); }
/* 无描述时的兜底提示进一步退后(77 张卡同文反复出现即是噪音;不压到 0.55 以下,保浅色可读) */
.lc-run.dim.ph { opacity: 0.75; }
.lc-stats {
  display: flex;
  gap: 14px;
  font-size: 10.5px;
  color: var(--ink-faint);
}
.lc-stats b { color: var(--ink); font-weight: 600; }
.lc-ctl { display: flex; gap: 8px; }
.lc-ctl .inp {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  font-size: 11.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
}
.lc-ctl .inp:focus { outline: none; border-color: var(--tone-success-dot); box-shadow: 0 0 0 3px var(--accent-soft); }
.pill-btn {
  flex: none;
  height: 30px;
  padding: 0 14px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border: 0;
  border-radius: var(--radius-panel-sm);
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.pill-btn:hover:not(:disabled) { background: var(--accent-strong); box-shadow: 0 0 14px var(--accent-soft); }
.pill-btn:disabled { opacity: 0.4; cursor: default; }
.pill-btn.danger,
.pill-btn.stop { background: var(--tone-danger-bg); color: var(--tone-danger-dot); }
.pill-btn.danger:hover:not(:disabled),
.pill-btn.stop:hover:not(:disabled) { background: color-mix(in srgb, var(--tone-danger-dot) 26%, transparent); box-shadow: none; }
.lc-manage {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--tone-info-dot);
  text-decoration: none;
}
.lc-manage:hover { text-decoration: underline; }
.new-card {
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-faint);
  background: transparent;
  border: 1px dashed var(--line-strong);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  cursor: pointer;
}
.new-card:hover { color: var(--tone-success-dot); border-color: var(--tone-success-dot); transform: none; }
.new-card small { font-weight: 400; font-size: 10px; color: var(--ink-fainter); }

.banner { padding: 8px 12px; font-size: 12px; border-radius: 10px; }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 30%, transparent); }

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: var(--scrim);
  backdrop-filter: blur(3px);
}
/* 弹窗入退场(occasional 频次;防跳变):遮罩淡入淡出,卡片 fade+上浮 8px 入场;
 * modal 不锚定触发器,transform-origin 居中豁免;退场对称快出 */
.modal-enter-active { transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.modal-leave-active { transition: opacity 130ms ease; }
.modal-enter-from,
.modal-leave-to { opacity: 0; }
.modal-enter-active .modal { transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1); }
.modal-enter-from .modal { transform: translateY(8px) scale(0.96); }
.modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(440px, calc(100vw - 40px));
  max-height: 82vh;
  padding: 18px;
  overflow: auto;
  background: var(--surface-glass-strong);
  backdrop-filter: var(--aurora-blur);
  -webkit-backdrop-filter: var(--aurora-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-edge), var(--shadow-float);
}
.modal.wide { width: min(640px, calc(100vw - 40px)); }
.m-title { display: flex; gap: 10px; align-items: baseline; font-size: 15px; color: var(--ink); }
.m-title.danger-title { align-items: center; color: var(--tone-danger-dot); }
.f { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--ink-faint); }
.f em { color: var(--tone-danger-dot); font-style: normal; }
.f .inp {
  height: 30px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
}
.f .inp:focus { outline: none; border-color: var(--tone-success-dot); box-shadow: 0 0 0 3px var(--accent-soft); }
.color-row { display: flex; gap: 7px; align-items: center; }
.color-dot {
  width: 20px;
  height: 20px;
  border: 2px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.color-dot.on { border-color: var(--ink); box-shadow: 0 0 10px currentColor; }
.m-actions { display: flex; gap: 8px; justify-content: flex-end; }
.m-err { font-size: 11px; color: var(--tone-danger-dot); }
.dim { color: var(--ink-fainter); }
.sec-label { font-size: 10px; font-weight: 700; color: var(--ink-fainter); letter-spacing: 0.16em; }
/* 删除确认:摘要行 + 级联勾选 */
.del-summary { font-size: 12px; line-height: 1.6; color: var(--ink-soft); }
.del-purge { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ink); cursor: pointer; }
.del-purge input {
  width: 14px;
  height: 14px;
  accent-color: var(--tone-danger-dot);
}
.tpl-hint { font-size: 11px; }
.tpl-list { display: flex; flex-direction: column; gap: 6px; }
.tpl-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: 9px;
}
.tpl-row small { flex: 1; }
.tpl-tag {
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--tone-info-dot);
  border: 1px solid color-mix(in srgb, var(--tone-info-dot) 40%, transparent);
  border-radius: 5px;
}
.tpl-tag.builtin { color: var(--ink-fainter); border-color: var(--line-strong); }
.tpl-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tpl-sem { flex: 1; color: var(--ink-faint); }
textarea.inp { height: auto; padding: 6px 9px; font-size: 11.5px; resize: vertical; }
.mini-btn {
  padding: 4px 10px;
  font-size: 10.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  cursor: pointer;
}
.mini-btn:hover { border-color: var(--ink-faint); color: var(--ink); }
.mini-btn.danger { color: var(--tone-danger-dot); }
</style>
