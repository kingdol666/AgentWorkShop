/**
 * /dcw —— 产线运营总览。
 * 产线 = 节点/产品/配方/批次的顶层隔离维度:每张卡片一条产线(光晕色身份 +
 * 运行状态 + 快捷启停),「产线管理」进入该产线的详情(仅加载本产线数据)。
 * 控制模板(自定义分类:电机电流/转速/线速度…)在此统一管理 —— 模板只定义
 * 种类与量程,真正下发 PLC 的是挂到产线上的控制节点。
 */
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { DCW_LINE_COLORS, type DcwTemplateIcon, type LineView } from '#shared/dcw-protocol'
import { useDcwStream } from '~/composables/workshop/useDcwStream'

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
    if (!rid) throw new Error('请先选择该产线的配方(配方需绑定控制节点参数)')
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
  const label = `${card.line.name}(节点 ${card.nodes}/产品 ${card.products}/配方 ${card.recipes} 将解除挂载)`
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
const tplForm = reactive({ name: '', ch: '', code: '', unit: '', min: '' as number | '', max: '' as number | '', decimals: 1, icon: 'gateway' as DcwTemplateIcon })
const tplIcons: Array<{ key: DcwTemplateIcon, label: string }> = [
  { key: 'thermo', label: '温度' },
  { key: 'pressure', label: '压力' },
  { key: 'tension', label: '张力' },
  { key: 'encoder', label: '编码/速度' },
  { key: 'camera', label: '视觉' },
  { key: 'gateway', label: '通用' },
]

async function doCreateTemplate(): Promise<void> {
  tplError.value = ''
  try {
    if (!tplForm.name.trim()) throw new Error('模板名称必填')
    if (tplForm.min === '' || tplForm.max === '') throw new Error('工艺量程(min/max)必填')
    await dcw.createTemplate({
      name: tplForm.name.trim(),
      ch: tplForm.ch.trim() || tplForm.name.trim(),
      code: tplForm.code.trim() || 'CUSTOM',
      unit: tplForm.unit.trim() || '-',
      min: Number(tplForm.min),
      max: Number(tplForm.max),
      decimals: Number(tplForm.decimals) || 0,
      icon: tplForm.icon,
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
      if (json?.code !== 0) throw new Error(json?.message ?? '删除失败')
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
        <h1>产线运营</h1>
        <p class="sub">
          产线是节点/产品/配方/数据的顶层隔离单元:每个控制节点挂载到产线,开跑后本产线数采逐样本携带产线标识;
          控制模板只定义参数分类与工艺量程,真正下发 PLC 的是节点。
        </p>
      </div>
      <div class="badges mono">
        <span
          v-if="unassignedCount"
          class="badge warn-badge"
          title="存在未挂载产线的节点/产品,可在对应产线详情页收编"
        >未分配 {{ unassignedCount }}</span>
        <span class="badge">产线 {{ dcw.lines.length }}</span>
        <button
          class="badge tpl-btn"
          @click="tplOpen = true"
        >
          控制模板 · {{ dcw.templates.length }}
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
          >{{ dcw.lineStateOf(c.line.id).active ? '● 运行中' : '○ 待机' }}</span>
          <button
            class="lc-del"
            title="删除产线(旗下节点/产品/配方解除挂载)"
            @click="doRemoveLine(c)"
          >
            ✕
          </button>
        </div>
        <small
          v-if="dcw.lineStateOf(c.line.id).active"
          class="lc-run mono"
        >{{ dcw.lineStateOf(c.line.id).productName }} · {{ dcw.lineStateOf(c.line.id).recipeName }} · 打标 {{ dcw.lineStateOf(c.line.id).taggedSamples }}</small>
        <small
          v-else
          class="lc-run dim"
        >{{ c.line.description || '选择配方后即可开跑数据采集' }}</small>
        <div class="lc-stats mono">
          <span>节点 <b>{{ c.nodes }}</b></span>
          <span>产品 <b>{{ c.products }}</b></span>
          <span>配方 <b>{{ c.recipes }}</b></span>
        </div>
        <div class="lc-ctl">
          <template v-if="!dcw.lineStateOf(c.line.id).active">
            <select
              v-model="quickPick[c.line.id]"
              class="inp"
              :disabled="recipesOf(c.line.id).length === 0"
              title="选择配方后开跑"
            >
              <option value="">
                {{ recipesOf(c.line.id).length ? '选择配方…' : '暂无配方' }}
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
              ▶ 开跑
            </button>
          </template>
          <button
            v-else
            class="pill-btn stop"
            :disabled="quickBusy === c.line.id"
            @click="quickStop(c)"
          >
            ■ 停止
          </button>
        </div>
        <NuxtLink
          class="lc-manage"
          :to="`/dcw/${c.line.id}`"
        >
          产线管理 →
        </NuxtLink>
      </div>

      <!-- 新建产线卡 -->
      <button
        class="line-card new-card"
        @click="openCreate"
      >
        <span class="i-tabler-plus" />
        新建产线
        <small>光晕色自动取色板({{ nextColor }})</small>
      </button>
    </div>

    <p
      v-if="dcw.loaded && dcw.lines.length === 0"
      class="banner"
    >
      还没有产线:点击「新建产线」创建第一条产线,然后在产线详情里收编/添加控制节点、建产品与配方。
    </p>

    <!-- 新建产线弹窗 -->
    <div
      v-if="createOpen"
      class="modal-mask"
      @click.self="createOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          新建产线
        </h3>
        <label class="f">
          <span>产线名称<em>*</em></span>
          <input
            v-model="createForm.name"
            class="inp"
            placeholder="如 1号产线 / 流延线 A"
          >
        </label>
        <label class="f">
          <span>描述(可选)</span>
          <input
            v-model="createForm.description"
            class="inp"
            placeholder="产线用途说明"
          >
        </label>
        <div class="f">
          <span>光晕色(数字孪生场景中本产线节点的光环色)</span>
          <div class="color-row">
            <button
              v-for="c in DCW_LINE_COLORS"
              :key="c"
              class="color-dot"
              :class="{ on: createForm.color === c }"
              :style="{ background: c }"
              @click="createForm.color = createForm.color === c ? '' : c"
            />
            <small class="dim">{{ createForm.color || `缺省 ${nextColor}(按创建序)` }}</small>
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
            取消
          </button>
          <button
            class="pill-btn"
            :disabled="createSaving || !createForm.name.trim()"
            @click="doCreateLine"
          >
            创建
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
          控制模板管理 <small class="dim mono">内置 {{ builtinCount }} · 自定义 {{ dcw.templates.length - builtinCount }}</small>
        </h3>
        <p class="dim tpl-hint">
          模板 = 参数分类(电机电流/转速/线速度…),定义单位与工艺安全量程;创建控制节点时选模板继承域,节点可再自定义覆盖。
        </p>
        <div class="tpl-list">
          <div
            v-for="t in dcw.templates"
            :key="t.key"
            class="tpl-row"
          >
            <b>{{ t.name }}</b>
            <small class="mono dim">{{ t.code }} · {{ t.min }}~{{ t.max }} {{ t.unit }}</small>
            <span
              class="tpl-tag"
              :class="{ builtin: t.builtin }"
            >{{ t.builtin ? '内置' : '自定义' }}</span>
            <button
              v-if="!t.builtin"
              class="mini-btn danger"
              @click="doRemoveTemplate(t.key)"
            >
              删除
            </button>
          </div>
        </div>
        <p class="sec-label">
          新建自定义模板
        </p>
        <div class="tpl-form">
          <label class="f">
            <span>名称<em>*</em></span>
            <input
              v-model="tplForm.name"
              class="inp"
              placeholder="如 电机电流设定"
            >
          </label>
          <label class="f">
            <span>参数语义</span>
            <input
              v-model="tplForm.ch"
              class="inp"
              placeholder="如 电机电流"
            >
          </label>
          <label class="f">
            <span>位号代号</span>
            <input
              v-model="tplForm.code"
              class="inp"
              placeholder="如 MOTOR · I"
            >
          </label>
          <label class="f">
            <span>单位</span>
            <input
              v-model="tplForm.unit"
              class="inp"
              placeholder="如 A"
            >
          </label>
          <label class="f">
            <span>量程下限<em>*</em></span>
            <input
              v-model.number="tplForm.min"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>量程上限<em>*</em></span>
            <input
              v-model.number="tplForm.max"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>小数位</span>
            <input
              v-model.number="tplForm.decimals"
              type="number"
              class="inp"
            >
          </label>
          <label class="f">
            <span>图标</span>
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
            关闭
          </button>
          <button
            class="pill-btn"
            :disabled="!tplForm.name.trim() || tplForm.min === '' || tplForm.max === ''"
            @click="doCreateTemplate"
          >
            创建模板
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
