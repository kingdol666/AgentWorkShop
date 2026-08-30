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

/** 删除产线(确认后;旗下节点/产品/配方自动解挂为未分配) */
const removing = ref('')
async function doRemoveLine(card: LineCard): Promise<void> {
  const label = t('dcw.k1gp649b062', { p0: card.line.name, p1: card.nodes, p2: card.products, p3: card.recipes })
  if (!window.confirm(`确认删除产线「${card.line.name}」?
${label}`)) return
  removing.value = card.line.id
  quickErr.value = ''
  try {
    await dcw.removeLine(card.line.id)
  }
  catch (err) {
    quickErr.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    removing.value = ''
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

    <!-- 产线卡片栅格 -->
    <div class="line-grid">
      <div
        v-for="c in cards"
        :key="c.line.id"
        class="line-card"
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
            class="lc-del"
            :title="$t('dcw.k1yfm3gv002')"
            @click="doRemoveLine(c)"
          >
            ✕
          </button>
        </div>
        <small
          v-if="dcw.lineStateOf(c.line.id).active"
          class="lc-run mono"
        >{{ dcw.lineStateOf(c.line.id).productName }} · {{ dcw.lineStateOf(c.line.id).recipeName }} · {{ $t('dcw.k3zz0f052') }} {{ dcw.lineStateOf(c.line.id).taggedSamples }}</small>
        <small
          v-else
          class="lc-run dim"
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

    <!-- 新建产线弹窗 -->
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

    <!-- 控制模板管理弹窗 -->
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
.badge {
  padding: 3px 10px;
  font-size: 11px;
  color: #8fa0b5;
  background: rgba(13, 20, 32, 0.7);
  border: 1px solid rgba(45, 62, 92, 0.6);
  border-radius: 999px;
}
.warn-badge { color: #f6c453; border-color: rgba(246, 196, 83, 0.4); }
.tpl-btn { color: #41c8f4; border-color: rgba(65, 200, 244, 0.45); cursor: pointer; }
.tpl-btn:hover { background: rgba(65, 200, 244, 0.12); }

.line-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.line-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  text-align: left;
  background: linear-gradient(180deg, #111a2b 0%, #0d1420 100%);
  border: 1px solid rgba(45, 62, 92, 0.6);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(143, 176, 220, 0.07), 0 10px 28px rgba(3, 7, 14, 0.45);
  transition: border-color 0.18s var(--hud-ease, ease), transform 0.18s var(--hud-ease, ease), box-shadow 0.18s var(--hud-ease, ease);
}
.line-card:hover {
  border-color: color-mix(in srgb, var(--lc, #3aa0ff) 55%, #1d2a42);
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(143, 176, 220, 0.09), 0 14px 34px rgba(3, 7, 14, 0.55);
}
.lc-head { display: flex; gap: 9px; align-items: center; }
.lc-dot {
  width: 11px;
  height: 11px;
  flex: none;
  background: var(--lc);
  border-radius: 4px;
  box-shadow: 0 0 12px var(--lc);
}
.lc-name { font-size: 14.5px; color: #e8eef8; }
.lc-state {
  margin-left: auto;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: #5f6e84;
}
.lc-state.on { color: #35e0a0; }
.lc-del {
  flex: none;
  width: 20px;
  height: 20px;
  font-size: 10px;
  color: #5f6e84;
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.lc-del:hover { color: #ff6b6b; background: rgba(255, 107, 107, 0.12); }
.lc-run { font-size: 10.5px; color: #41c8f4; }
.lc-run.dim { color: #5f6e84; }
.lc-stats {
  display: flex;
  gap: 14px;
  font-size: 10.5px;
  color: #8fa0b5;
}
.lc-stats b { color: #e8eef8; }
.lc-ctl { display: flex; gap: 8px; }
.lc-ctl .inp {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  font-size: 11.5px;
  color: #e8eef8;
  background: #0a111d;
  border: 1px solid rgba(45, 62, 92, 0.8);
  border-radius: 8px;
}
.lc-ctl .inp:focus { outline: none; border-color: #35e0a0; box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13); }
.pill-btn {
  flex: none;
  height: 30px;
  padding: 0 14px;
  font-size: 11.5px;
  font-weight: 600;
  color: #04120c;
  background: #1f9e6e;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.pill-btn:hover:not(:disabled) { background: #35e0a0; box-shadow: 0 0 14px rgba(53, 224, 160, 0.35); }
.pill-btn:disabled { opacity: 0.4; cursor: default; }
.pill-btn.stop { background: rgba(255, 107, 107, 0.14); color: #ff6b6b; }
.pill-btn.stop:hover:not(:disabled) { background: rgba(255, 107, 107, 0.24); box-shadow: none; }
.lc-manage {
  font-size: 11.5px;
  font-weight: 600;
  color: #41c8f4;
  text-decoration: none;
}
.lc-manage:hover { text-decoration: underline; }
.new-card {
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #8fa0b5;
  background: transparent;
  border: 1px dashed #274064;
  box-shadow: none;
  cursor: pointer;
}
.new-card:hover { color: #35e0a0; border-color: #1f9e6e; transform: none; }
.new-card small { font-weight: 400; font-size: 10px; color: #5f6e84; }

.banner { padding: 8px 12px; font-size: 12px; border-radius: 10px; }
.banner.bad { color: #ff6b6b; background: rgba(255, 107, 107, 0.08); border: 1px solid rgba(255, 107, 107, 0.28); }

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: rgba(4, 8, 14, 0.66);
  backdrop-filter: blur(3px);
}
.modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(440px, calc(100vw - 40px));
  max-height: 82vh;
  padding: 18px;
  overflow: auto;
  background: #0e1626;
  border: 1px solid #27395c;
  border-radius: 14px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
}
.modal.wide { width: min(640px, calc(100vw - 40px)); }
.m-title { display: flex; gap: 10px; align-items: baseline; font-size: 15px; color: #e8eef8; }
.f { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: #8fa0b5; }
.f em { color: #ff6b6b; font-style: normal; }
.f .inp {
  height: 30px;
  padding: 0 9px;
  font-size: 12px;
  color: #e8eef8;
  background: #0a111d;
  border: 1px solid rgba(45, 62, 92, 0.8);
  border-radius: 8px;
}
.f .inp:focus { outline: none; border-color: #35e0a0; box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13); }
.color-row { display: flex; gap: 7px; align-items: center; }
.color-dot {
  width: 20px;
  height: 20px;
  border: 2px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.color-dot.on { border-color: #e8eef8; box-shadow: 0 0 10px currentColor; }
.m-actions { display: flex; gap: 8px; justify-content: flex-end; }
.m-err { font-size: 11px; color: #ff6b6b; }
.dim { color: #5f6e84; }
.sec-label { font-size: 10px; font-weight: 700; color: #5f6e84; letter-spacing: 0.16em; }
.tpl-hint { font-size: 11px; }
.tpl-list { display: flex; flex-direction: column; gap: 6px; }
.tpl-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 10px;
  font-size: 12px;
  color: #e8eef8;
  background: rgba(13, 20, 32, 0.6);
  border: 1px solid rgba(45, 62, 92, 0.5);
  border-radius: 9px;
}
.tpl-row small { flex: 1; }
.tpl-tag {
  padding: 1px 8px;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  color: #41c8f4;
  border: 1px solid rgba(65, 200, 244, 0.4);
  border-radius: 5px;
}
.tpl-tag.builtin { color: #5f6e84; border-color: rgba(95, 110, 132, 0.5); }
.tpl-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tpl-sem { flex: 1; color: #8fa0b5; }
textarea.inp { height: auto; padding: 6px 9px; font-size: 11.5px; resize: vertical; }
.mini-btn {
  padding: 4px 10px;
  font-size: 10.5px;
  color: #8fa0b5;
  background: #0a111d;
  border: 1px solid rgba(45, 62, 92, 0.8);
  border-radius: 7px;
  cursor: pointer;
}
.mini-btn:hover { border-color: #33507c; color: #e8eef8; }
.mini-btn.danger { color: #ff6b6b; }
</style>
