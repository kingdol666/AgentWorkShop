<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 设备属性 + 数采绑定段(含绑定弹层)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { TownScene3D } from '../TownScene3D'
import type { DaqTemplate, RailBindChoice, TownModelRow } from '@/app/composables/workshop/town/town-view-types'

const { t } = useI18n()
const objNameDraft = defineModel<string>('objNameDraft', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number }
  scene3dRef: TownScene3D | null
  deviceModels: TownModelRow[]
  boundDaqRows: Array<{ daqId: string, name: string, ch: string, icon: string, value: string, unit: string, color: string }>
  daqTemplates: DaqTemplate[]
  daqBindChoices: Record<string, RailBindChoice[]>
  daqBindChoiceCount: number
  bindPopOpen: boolean
  bindPopMaxH: number
  toggleBindPop: (key: 'daq' | 'dcw', e: MouseEvent) => void
  bindDaqChoice: (nodeId: string) => void
  unbindDaq: (daqId: string) => void
  setSparkRef: (id: string, el: unknown) => void
  onObjNameCommit: () => void
  bindDeviceModel: (modelRef: string) => void
}>()
</script>

<template>
  <div class="obj-row">
    <span class="obj-label">{{ $t('townView.k3xhia082') }}</span>
    <input
      v-model="objNameDraft"
      class="obj-input"
      :placeholder="$t('townView.k1k6vbaf015')"
      :disabled="mode !== 'edit'"
      :title="mode === 'edit' ? $t('townView.deviceName') : $t('townView.readonlyTip')"
      @change="onObjNameCommit"
      @keydown.enter="onObjNameCommit"
    >
  </div>
  <div class="obj-row">
    <span class="obj-label">{{ $t('townView.k41amp083') }}</span>
    <select
      class="obj-select"
      :value="scene3dRef?.getDeviceModelRef?.(selected.id) ?? ''"
      :disabled="mode !== 'edit'"
      @change="bindDeviceModel(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="m in deviceModels"
        :key="m.id"
        :value="m.id"
      >
        {{ townModelName(t, m) }}
      </option>
    </select>
  </div>

  <!-- 数采绑定(设计稿 bind-row:图标 + 通道 + 实时值 + 迷你折线 + 解绑;运行模式只读展示) -->
  <div class="sect-hd">
    {{ $t('townView.k1vtyk05130') }} {{ boundDaqRows.length }} {{ $t('townView.k3vfpz5138') }}
  </div>
  <div
    v-for="r in boundDaqRows"
    :key="r.daqId"
    class="bind-row"
  >
    <span class="bind-ico">
      <WorkshopDaqTemplateIcon
        class="bind-svg"
        :icon="r.icon"
      />
    </span>
    <span class="bind-meta">
      <span class="bind-label">{{ r.ch }}</span>
      <span class="bind-val"><b>{{ r.value }}</b> {{ r.unit }} · {{ r.name }}</span>
    </span>
    <canvas
      :ref="el => setSparkRef(r.daqId, el)"
      class="bind-spark"
      width="56"
      height="20"
    />
    <button
      v-if="mode === 'edit'"
      class="bind-x"
      :title="$t('townView.k1k73omv016')"
      @click="unbindDaq(r.daqId)"
    >
      ✕
    </button>
  </div>
  <div
    v-if="!boundDaqRows.length"
    class="ins-empty"
  >
    {{ $t('townView.kgpuqhb084') }}
  </div>
  <div
    v-if="mode === 'edit'"
    class="bind-add-wrap"
  >
    <button
      class="bind-add"
      @click="toggleBindPop('daq', $event)"
    >
      {{ $t('townView.kvm0lin085') }}
    </button>
    <div
      v-if="bindPopOpen"
      class="bind-pop"
      :style="{ maxHeight: `${bindPopMaxH}px` }"
    >
      <template
        v-for="tpl in daqTemplates"
        :key="tpl.id"
      >
        <div
          v-if="daqBindChoices[tpl.id]?.length"
          class="bp-group"
        >
          <span class="bp-tpl">{{ tpl.name }} · {{ tpl.ch }}</span>
          <button
            v-for="c in daqBindChoices[tpl.id]"
            :key="c.id"
            :data-node-id="c.id"
            :title="c.devName ? $t('townView.k2bindr0007', { p0: c.devName }) : $t('townView.k2bindr0008')"
            @click="bindDaqChoice(c.id)"
          >
            <WorkshopDaqTemplateIcon
              class="bind-svg"
              :icon="c.tpl.icon"
            />
            <span>{{ c.name }}<i
              v-if="c.devName"
              class="bp-cur"
            >→ {{ c.devName }}</i><i
              v-else-if="!c.placed"
              class="bp-cur"
            >{{ $t('townView.k2bindr0009') }}</i></span>
          </button>
        </div>
      </template>
      <div
        v-if="!daqBindChoiceCount"
        class="bp-empty"
      >
        {{ $t('townView.k2bindr0010') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctl-btns { display: flex; gap: 8px; margin-top: auto; }
.btn {
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--hud-r-sm);
  font-size: 12px;
  font-weight: 600;
  flex: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 0.15s var(--hud-ease), background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.btn-primary { background: var(--hud-accent-dim); color: #04120c; }
.btn-primary:hover { background: #25b57e; }
.btn-ghost { border: 1px solid #27395c; color: var(--hud-text); }
.btn-ghost:hover { background: #14203a; border-color: #33507c; }
.btn-danger { background: #b3273a; color: #fff; }
.btn-danger:hover { background: #d1304a; }
.btn:not(:disabled):active { transform: translateY(1px); }
/* 只读态:禁用控件降透明度 + 禁止光标(运行模式视觉语言) */
.btn:disabled, .nav-action:disabled, .obj-input:disabled, .obj-select:disabled,
.bind-select:disabled, .obj-mini:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  filter: saturate(0.4);
}
.btn:disabled:hover, .nav-action:disabled:hover { background: inherit; }
.sect-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--hud-faint);
  letter-spacing: 0.16em;
  font-weight: 700;
  margin: 10px 0 7px;
}
/* 分区头刻度线:与面板左缘数据条同 motif,建立分区节奏 */
.sect-hd::before {
  content: '';
  width: 3px;
  height: 9px;
  background: var(--hud-accent);
  border-radius: 1px;
  opacity: 0.55;
}
.obj-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.obj-label { flex: none; width: 52px; font-size: 10.5px; color: var(--hud-dim); }
.obj-input, .obj-select {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  padding: 5px 8px;
  transition: border-color 0.15s var(--hud-ease);
}
.obj-input:focus, .obj-select:focus { outline: none; border-color: var(--hud-accent); }
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
/* 数采绑定/信息 */
/* 数采绑定行(设计稿 bind-row:图标 + 通道 + 实时值 + 迷你折线 + 解绑) */
.bind-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  margin-bottom: 6px;
  background: #0f1726;
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.bind-ico {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--hud-accent);
  background: #0d1a26;
  border-radius: 7px;
}
.bind-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.bind-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.bind-label { font-size: 11px; font-weight: 600; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val { font-family: var(--font-mono); font-size: 10px; color: var(--hud-cyan); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val b { font-size: 11px; font-weight: 700; }
.bind-spark { width: 56px; height: 20px; flex: none; }
.bind-x {
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--hud-faint);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.bind-x:hover { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.bind-add-wrap { position: relative; }
.bind-add {
  width: 100%;
  height: 30px;
  font-size: 11px;
  color: var(--hud-dim);
  background: transparent;
  border: 1px dashed #274064;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.bind-add:hover { border-color: var(--hud-accent-dim); color: var(--hud-accent); }
.bind-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 30;
  overflow-y: auto;
  overflow-x: hidden;
  max-height: min(46vh, 420px);
  overscroll-behavior: contain;
  background: #0e1626;
  border: 1px solid #27395c;
  border-radius: var(--hud-r-md);
  box-shadow: var(--hud-shadow-pop, 0 16px 40px rgba(0, 0, 0, 0.55));
}
.bind-pop::-webkit-scrollbar { width: 8px; }
.bind-pop::-webkit-scrollbar-thumb {
  background: #2c4568;
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 9999px;
}
.bind-pop::-webkit-scrollbar-thumb:hover { background: #3d5a85; background-clip: content-box; }
.bind-pop button {
  display: flex;
  width: 100%;
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  font-size: 11.5px;
  color: var(--hud-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.bind-pop button:hover { background: #12203a; color: var(--hud-text); }
.bind-pop .bind-svg { color: var(--hud-accent); }
/* 节点选择器分组(设备卡添加通道:直绑节点实例,非模板) */
.bind-pop button > span {
  display: flex;
  flex: 1;
  gap: 6px;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.bp-group { display: flex; flex-direction: column; }
.bp-group + .bp-group { border-top: 1px solid rgba(39, 57, 92, 0.55); }
.bp-tpl {
  padding: 6px 10px 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--hud-faint);
}
.bp-cur {
  margin-left: auto;
  font-style: normal;
  font-size: 9.5px;
  color: var(--hud-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 96px;
}
.bp-empty {
  padding: 10px;
  font-size: 10.5px;
  color: var(--hud-faint);
}
/* ===== 控件语汇统一:输入场 focus 柔光环 + number 去原生 spinner ===== */
.obj-input:hover, .obj-select:hover, .bind-select:hover, .daq-num:hover,
.daq-ctl-cycle input:hover {
  border-color: var(--hud-line-hi);
}
.obj-input:focus, .obj-select:focus, .bind-select:focus, .daq-num:focus,
.daq-ctl-cycle input:focus {
  outline: none;
  border-color: var(--hud-accent);
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13);
}
input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
/* 绑定行 hover 微抬(DAQ 行与智控卡同一 hover 语言) */
.bind-row { transition: border-color 0.18s var(--hud-ease), box-shadow 0.18s var(--hud-ease); }
.bind-row:hover {
  border-color: var(--hud-line-hi);
  box-shadow: 0 6px 18px rgba(3, 7, 14, 0.4);
}
/* 添加通道按钮:虚线框 hover 实心化 + 底色微亮 */
.bind-add:hover { background: rgba(53, 224, 160, 0.05); border-style: solid; }
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.obj-input:focus-visible,
.obj-select:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}
/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
@media (max-width: 1023px) {
  .bind-val b { font-size: 12px; }
}
</style>
