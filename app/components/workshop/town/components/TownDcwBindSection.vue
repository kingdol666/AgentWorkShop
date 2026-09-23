<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 智控设定绑定段(三段式仪表卡 + 绑定弹层)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { DcwBoundRow, DcwTemplate, RailBindChoice } from '@/app/composables/workshop/town/town-view-types'

const dcwWriteDrafts = defineModel<Record<string, number | ''>>('dcwWriteDrafts', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  dcw: ReturnType<typeof useDcwStream>
  boundDcwRows: DcwBoundRow[]
  dcwTemplates: DcwTemplate[]
  dcwBindChoices: Record<string, RailBindChoice[]>
  dcwBindChoiceCount: number
  dcwBindPopOpen: boolean
  bindPopMaxH: number
  dcwWriteErrs: Record<string, string>
  dcwMarkPct: (r: { value: number | null, rMin: number | null, rMax: number | null, gMin: number, gMax: number }) => number
  doDcwWrite: (node: ReturnType<typeof useDcwStream>['nodes'][number]) => void
  unbindDcw: (dcwId: string) => void
  toggleBindPop: (key: 'daq' | 'dcw', e: MouseEvent) => void
  bindDcwChoice: (nodeId: string) => void
}>()
</script>

<template>
  <!-- 智控设定(三段式仪表卡:身份行 / 工艺窗口带 / 下发行) -->
  <div class="sect-hd">
    {{ $t('townView.ktzir2t131') }} {{ boundDcwRows.length }} {{ $t('townView.k4l1w042') }}
  </div>
  <div
    v-for="r in boundDcwRows"
    :key="r.dcwId"
    class="dcw-row"
  >
    <div class="dcw-top">
      <span class="bind-ico">
        <WorkshopDaqTemplateIcon
          class="bind-svg"
          :icon="r.icon"
        />
      </span>
      <span class="dcw-id">
        <span class="bind-label">{{ r.ch }}<i
          v-if="r.rMin != null || r.rMax != null"
          class="dcw-tag"
        >{{ $t('townView.k48grv086') }}</i></span>
        <span class="dcw-name">{{ r.name }}</span>
      </span>
      <span class="dcw-cur"><b>{{ r.value != null ? r.value.toFixed(r.decimals) : '--' }}</b><i>{{ r.unit }}</i></span>
      <button
        v-if="mode === 'edit'"
        class="bind-x"
        :title="$t('townView.k1k73omv016')"
        @click="unbindDcw(r.dcwId)"
      >
        ✕
      </button>
    </div>
    <div
      class="dcw-win"
      :class="{ recipe: r.rMin != null || r.rMax != null }"
    >
      <em>{{ r.rMin != null || r.rMax != null ? $t('townView.k1l3m0hx151') : $t('townView.k1bc6rqf181') }}</em>
      <span class="dcw-win-num">{{ r.rMin ?? '-∞' }}</span>
      <span class="dcw-win-track"><i :style="{ left: `${dcwMarkPct(r)}%` }" /></span>
      <span class="dcw-win-num">{{ r.rMax ?? '+∞' }}</span>
    </div>
    <div class="dcw-write">
      <input
        v-model.number="dcwWriteDrafts[r.dcwId]"
        type="number"
        :step="10 ** -r.decimals"
        :placeholder="`${(r.rMin ?? r.gMin)} ~ ${(r.rMax ?? r.gMax)}`"
        @keydown.enter="doDcwWrite(dcw.nodeById(r.dcwId)!)"
      >
      <button
        class="dcw-send"
        :disabled="dcwWriteDrafts[r.dcwId] == null || dcwWriteDrafts[r.dcwId] === ''"
        :title="$t('townView.k15t7izc017')"
        @click="doDcwWrite(dcw.nodeById(r.dcwId)!)"
      >
        write
      </button>
    </div>
    <small
      v-if="dcwWriteErrs[r.dcwId]"
      class="dcw-err"
    >{{ dcwWriteErrs[r.dcwId] }}</small>
  </div>
  <div
    v-if="!boundDcwRows.length"
    class="ins-empty"
  >
    {{ $t('townView.k10smf24087') }}
  </div>
  <div
    v-if="mode === 'edit'"
    class="bind-add-wrap"
  >
    <button
      class="bind-add"
      @click="toggleBindPop('dcw', $event)"
    >
      {{ $t('townView.kvk1vh5088') }}
    </button>
    <div
      v-if="dcwBindPopOpen"
      class="bind-pop"
      :style="{ maxHeight: `${bindPopMaxH}px` }"
    >
      <template
        v-for="tpl in dcwTemplates"
        :key="tpl.id"
      >
        <div
          v-if="dcwBindChoices[tpl.id]?.length"
          class="bp-group"
        >
          <span class="bp-tpl">{{ tpl.name }} · {{ tpl.ch }}</span>
          <button
            v-for="c in dcwBindChoices[tpl.id]"
            :key="c.id"
            :data-node-id="c.id"
            :title="c.devName ? $t('townView.k2bindr0007', { p0: c.devName }) : $t('townView.k2bindr0008')"
            @click="bindDcwChoice(c.id)"
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
        v-if="!dcwBindChoiceCount"
        class="bp-empty"
      >
        {{ $t('townView.k2bindr0010') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
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
/* ===== 智控设定 · 三段式仪表卡(身份行 / 工艺窗口带 / 下发行) ===== */
.dcw-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px 10px;
  margin-bottom: 7px;
  background: linear-gradient(180deg, #111a2b 0%, #0e1522 100%);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-md);
  transition: border-color 0.18s var(--hud-ease), box-shadow 0.18s var(--hud-ease);
}
.dcw-row:hover {
  border-color: var(--hud-line-hi);
  box-shadow: 0 6px 18px rgba(3, 7, 14, 0.4);
}
.dcw-top { display: flex; gap: 8px; align-items: center; }
.dcw-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dcw-name {
  font-size: 9.5px;
  color: var(--hud-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcw-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  font-style: normal;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--hud-amber);
  background: rgba(246, 196, 83, 0.1);
  border: 1px solid rgba(246, 196, 83, 0.32);
  border-radius: 4px;
  vertical-align: 1px;
}
.dcw-cur {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.dcw-cur b {
  font-size: 16px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-shadow: 0 0 14px rgba(65, 200, 244, 0.28);
}
.dcw-cur i {
  font-style: normal;
  font-size: 9.5px;
  color: var(--hud-faint);
}
/* 工艺窗口带:标签 + 端点值 + 刻度轨(游标 = 当前设定值位置) */
.dcw-win {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 4px 8px;
  background: rgba(10, 17, 29, 0.72);
  border: 1px solid var(--hud-line-soft);
  border-radius: 7px;
}
.dcw-win em {
  flex: none;
  font-style: normal;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--hud-faint);
}
.dcw-win-num {
  flex: none;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim);
  font-variant-numeric: tabular-nums;
}
.dcw-win-track {
  position: relative;
  flex: 1;
  height: 4px;
  background: #1a2740;
  border-radius: 999px;
}
/* 窗口带内的可行域高亮 + 当前值游标 */
.dcw-win-track::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(90, 130, 175, 0.4), rgba(90, 130, 175, 0.14));
}
.dcw-win-track i {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  background: #dfeef8;
  border: 2px solid var(--hud-cyan);
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(65, 200, 244, 0.55);
  transform: translate(-50%, -50%);
  transition: left 0.3s var(--hud-ease);
}
/* 配方态:可行域转琥珀(工艺窗口是产线纪律,视觉权重高于全局量程) */
.dcw-win.recipe em { color: var(--hud-amber); }
.dcw-win.recipe .dcw-win-track::before {
  background: linear-gradient(90deg, rgba(246, 196, 83, 0.5), rgba(246, 196, 83, 0.16));
}
.dcw-win.recipe .dcw-win-track i {
  border-color: var(--hud-amber);
  box-shadow: 0 0 8px rgba(246, 196, 83, 0.55);
}
/* 下发行:深色输入 + 主色 write 按钮 */
.dcw-write { display: flex; gap: 6px; }
.dcw-write input {
  flex: 1;
  min-width: 0;
  height: 27px;
  padding: 0 9px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  transition: border-color 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.dcw-write input::placeholder { color: var(--hud-faint); font-size: 10px; }
.dcw-write input:focus {
  outline: none;
  border-color: var(--hud-accent);
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13);
}
.dcw-send {
  flex: none;
  height: 27px;
  padding: 0 14px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #04120c;
  background: var(--hud-accent-dim);
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.dcw-send:hover:not(:disabled) {
  background: var(--hud-accent);
  box-shadow: 0 0 14px rgba(53, 224, 160, 0.35);
}
.dcw-send:disabled { opacity: 0.38; cursor: default; }
.dcw-err {
  display: block;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--hud-danger);
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.28);
  border-radius: 6px;
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
dcw-write input,
.bind-select:focus-visible,
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
</style>
