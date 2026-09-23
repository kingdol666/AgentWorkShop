<script setup lang="ts">
/**
 * 配方编辑弹窗 —— 产品/名称/描述 + 参数节点级绑定(值/下限/上限)+ 数采监控窗口。
 * 表单对象由页面 useDcwRecipes 独占持有(经 v-model 就地读写同一 reactive 对象)。
 */
import type { DcwNodeView, ProductView } from '#shared/dcw-protocol'
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { DcwRecipeForm } from '../../pages/dcw/composables/useDcwRecipes'
import type { StaleRef } from '../../pages/dcw/composables/useDcwDetailScope'

defineProps<{
  lineProducts: ProductView[]
  lineNodes: DcwNodeView[]
  lineDaqNodes: DaqNodeLive[]
  lineId: string
  /** 编辑中的配方 id(null=新建;模板只取真值判定标题) */
  recipeEditing: string | null
  recipeSaving: boolean
  recipeError: string
  recipeStaleNote: string
  dcwTemplateRefCh: (templateRef?: string) => string
  nodeMin: (nodeId: string) => number | undefined
  nodeMax: (nodeId: string) => number | undefined
  paramStatus: (nodeId: string, lineId: string) => StaleRef | null
}>()

const emit = defineEmits<{ submit: [], close: [] }>()

const recipeOpen = defineModel<boolean>('open', { required: true })
const recipeForm = defineModel<DcwRecipeForm>('form', { required: true })
</script>

<template>
  <div
    v-if="recipeOpen"
    class="modal-mask"
    @click.self="recipeOpen = false"
  >
    <div class="modal">
      <h3 class="m-title">
        {{ recipeEditing ? $t('dcwDetail.k1iiwk0i163') : $t('dcwDetail.k1efq0r9176') }}
      </h3>
      <div class="f-grid">
        <label class="f">
          <span>{{ $t('dcwDetail.k1dw4fzf094') }}<em>*</em></span>
          <select
            v-model="recipeForm.productId"
            class="inp"
          >
            <option
              v-for="p in lineProducts"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k1l3f8so095') }}<em>*</em></span>
          <input
            v-model="recipeForm.name"
            class="inp"
            :placeholder="$t('dcwDetail.k12c11vm014')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k40gkk096') }}</span>
          <input
            v-model="recipeForm.description"
            class="inp"
            :placeholder="$t('dcwDetail.k1hxx8hy015')"
          >
        </label>
      </div>
      <p class="sec-label">
        {{ $t('dcwDetail.ka1kfgh097') }}
      </p>
      <div
        v-for="(p, i) in recipeForm.params"
        :key="i"
        class="param-row"
      >
        <label class="f">
          <span>{{ $t('dcwDetail.k1e2dtkt053') }}</span>
          <select
            v-model="p.nodeId"
            class="inp"
          >
            <option
              v-for="n in lineNodes"
              :key="n.id"
              :value="n.id"
            >
              {{ n.name }}({{ dcwTemplateRefCh(n.templateRef) }} · {{ n.min }}~{{ n.max }} {{ n.unit }})
            </option>
          </select>
          <span
            v-if="paramStatus(p.nodeId, lineId)"
            class="row-stale"
          >{{ paramStatus(p.nodeId, lineId)!.label }}</span>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k3renp2098') }}<em>*</em></span>
          <input
            v-model.number="p.value"
            type="number"
            class="inp"
            :step="0.1"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.k134rw3b146') }}{{ nodeMin(p.nodeId) ?? '-' }})</span>
          <input
            v-model.number="p.min"
            type="number"
            class="inp"
            :step="0.1"
            :placeholder="$t('dcwDetail.k5vew9z016')"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.khrv911147') }}{{ nodeMax(p.nodeId) ?? '-' }})</span>
          <input
            v-model.number="p.max"
            type="number"
            class="inp"
            :step="0.1"
            :placeholder="$t('dcwDetail.kzoh5pr017')"
          >
        </label>
        <button
          class="mini-btn danger param-del"
          @click="recipeForm.params.splice(i, 1)"
        >
          {{ $t('dcwDetail.k44idg099') }}
        </button>
      </div>
      <button
        class="mini-btn"
        @click="recipeForm.params.push({ nodeId: lineNodes[0]?.id ?? '', value: '', min: '', max: '' })"
      >
        {{ $t('dcwDetail.k1broh7h100') }}
      </button>
      <p class="sec-label">
        {{ $t('dcwDetail.k1h5gues101') }}
      </p>
      <div
        v-for="(w, i) in recipeForm.daqWindows"
        :key="`dw-${i}`"
        class="param-row"
      >
        <label class="f">
          <span>{{ $t('dcwDetail.k1empnnb102') }}</span>
          <select
            v-model="w.nodeId"
            class="inp"
          >
            <option
              v-for="n in lineDaqNodes"
              :key="n.id"
              :value="n.id"
            >
              {{ n.name }}({{ n.min }}~{{ n.max }} {{ n.unit }})
            </option>
          </select>
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.kqm08ap103') }}</span>
          <input
            v-model.number="w.min"
            type="number"
            class="inp"
            :step="0.1"
          >
        </label>
        <label class="f">
          <span>{{ $t('dcwDetail.kpypf8g104') }}</span>
          <input
            v-model.number="w.max"
            type="number"
            class="inp"
            :step="0.1"
          >
        </label>
        <button
          class="mini-btn danger param-del"
          @click="recipeForm.daqWindows.splice(i, 1)"
        >
          {{ $t('dcwDetail.k44idg099') }}
        </button>
      </div>
      <button
        class="mini-btn"
        :disabled="lineDaqNodes.length === 0"
        :title="lineDaqNodes.length === 0 ? $t('dcwDetail.noDaqTip') : ''"
        @click="recipeForm.daqWindows.push({ nodeId: lineDaqNodes[0]?.id ?? '', min: '', max: '' })"
      >
        {{ $t('dcwDetail.kv1de1p105') }}
      </button>
      <p
        v-if="recipeStaleNote"
        class="m-note"
      >
        {{ recipeStaleNote }}
      </p>
      <p
        v-if="recipeError"
        class="m-err"
      >
        {{ recipeError }}
      </p>
      <div class="m-actions">
        <button
          class="aw-pill outline"
          @click="recipeOpen = false"
        >
          {{ $t('dcwDetail.k3xdnn052') }}
        </button>
        <button
          class="pill-btn"
          :disabled="recipeSaving"
          @click="emit('submit')"
        >
          {{ recipeSaving ? $t('dcwDetail.k1b38d59164') : $t('dcwDetail.k1b3kwg0177') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.inp { padding: 5px 9px; font-size: 12.5px; color: var(--ink); background: var(--paper-deep); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

.sec-label { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); }

.modal-mask { position: fixed; z-index: 50; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--scrim); backdrop-filter: blur(2px); }
.modal { width: 680px; max-width: 94vw; max-height: 88vh; overflow-y: auto; padding: 22px 24px; background: var(--surface-glass-strong); backdrop-filter: var(--aurora-blur); border: 1px solid var(--glass-line); border-radius: var(--radius-panel); box-shadow: var(--glass-edge), var(--shadow-float); }
.m-title { margin: 0 0 14px; font-size: 17px; }

.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }

.param-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 8px; align-items: end; margin-bottom: 8px; }
.param-row .f { flex: 1; }
.param-del { margin-bottom: 2px; }
.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; }

.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }
.m-note { margin: 8px 0 0; font-size: 12px; color: var(--ink-faint); }

.row-stale { flex: none; padding: 1px 7px; font-size: 11.5px; color: var(--tone-danger-dot); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 30%, transparent); border-radius: var(--radius-chip); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn,
  .pill-btn,
  .aw-pill,
  .inp {
    min-height: 40px;
  }
  /* 弹窗表单:两列/三列在窄屏一律落成一列,否则标签被压成竖排字 */
  .f-grid { grid-template-columns: 1fr; }
  .param-row { grid-template-columns: 1fr 1fr; }
  .modal {
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    padding: 16px 14px;
  }
  .m-actions { flex-wrap: wrap; }
  .m-actions > * { flex: 1 1 auto; }
}
</style>
