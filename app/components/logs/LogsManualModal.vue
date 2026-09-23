<script setup lang="ts">
/**
 * 人工记录弹窗:摘要(必填)+ 可选详情 + 归属维度(产线/产品/Recipe),Teleport 到 body。
 *
 * 草稿由本组件持有:打开时按页面给出的筛选口径重置(关闭不清空,下一次打开再重置);
 * 提交流程在页面(useLogsManual):成功后关窗并重查,失败时弹窗保持打开、输入不丢,
 * 错误经 error 属性呈现(useOpsLog.error.post),不在此处再弹一层提示。
 *
 * 级联选项仍按筛选口径过滤(与原实现一致):弹窗内改选产线不会重建选项列表,
 * 只清空下游选择 —— 这是既有行为,不要"顺手修正"成按草稿过滤。
 */
import { computed, reactive, watch } from 'vue'
import type { LogsManualDraft, LogsManualScope } from '@/app/pages/logs/composables/useLogsManual'
import { useLogsScope } from '@/app/pages/logs/composables/useLogsScope'

const props = defineProps<{
  /** 筛选口径(= 筛选区当前维度):草稿初值与级联选项都取它 */
  scope: LogsManualScope
  /** 提交中(提交按钮置灰) */
  posting: boolean
  /** 提交失败信息(空串 = 无错误) */
  error: string
}>()

const emit = defineEmits<{
  submit: [draft: LogsManualDraft]
}>()

/** 开合经 v-model 回流页面:页面持有唯一副本,页头入口与遮罩/取消按钮都落在它上面 */
const open = defineModel<boolean>('open', { required: true })

const draft = reactive<LogsManualDraft>({ summary: '', detail: '', lineId: '', productId: '', recipeId: '' })

const { lines, productsOfLine, recipesOfScope } = useLogsScope()

const productOptions = computed(() => productsOfLine(props.scope.lineId))
const recipeOptions = computed(() => recipesOfScope(props.scope.lineId, props.scope.productId))

// 打开即重置草稿(与筛选区同维度起步);关闭不清空,避免失败重试时丢输入
watch(open, (on) => {
  if (!on) return
  draft.summary = ''
  draft.detail = ''
  draft.lineId = props.scope.lineId
  draft.productId = props.scope.productId
  draft.recipeId = props.scope.recipeId
})

function close(): void {
  open.value = false
}

/** 产线变更 → 产品/Recipe 选择失效 */
function onLineChange(): void {
  draft.productId = ''
  draft.recipeId = ''
}

/** 产品变更 → Recipe 选择失效 */
function onProductChange(): void {
  draft.recipeId = ''
}

/** 提交取当前草稿快照(值在点击瞬间定稿,后续编辑不影响已发请求) */
function onSubmit(): void {
  emit('submit', { ...draft })
}
</script>

<template>
  <!-- 人工记录弹窗 -->
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-mask"
      @click.self="close"
    >
      <div class="modal">
        <h3 class="m-title">
          {{ $t('logs.manual') }}
        </h3>
        <label class="m-f">
          <span>{{ $t('logs.mSummary') }} *</span>
          <textarea
            v-model="draft.summary"
            rows="3"
            :placeholder="$t('logs.mSummaryPh')"
          />
        </label>
        <label class="m-f">
          <span>{{ $t('logs.mDetail') }}</span>
          <textarea
            v-model="draft.detail"
            rows="2"
            :placeholder="$t('logs.mDetailPh')"
          />
        </label>
        <div class="m-grid">
          <label class="m-f">
            <span>{{ $t('logs.fLine') }}</span>
            <select
              v-model="draft.lineId"
              class="inp-sel"
              @change="onLineChange"
            >
              <option value="">
                {{ $t('logs.all') }}
              </option>
              <option
                v-for="l in lines"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select>
          </label>
          <label class="m-f">
            <span>{{ $t('logs.fProduct') }}</span>
            <select
              v-model="draft.productId"
              class="inp-sel"
              @change="onProductChange"
            >
              <option value="">
                {{ $t('logs.all') }}
              </option>
              <option
                v-for="p in productOptions"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name }}
              </option>
            </select>
          </label>
          <label class="m-f">
            <span>Recipe</span>
            <select
              v-model="draft.recipeId"
              class="inp-sel"
            >
              <option value="">
                {{ $t('logs.all') }}
              </option>
              <option
                v-for="r in recipeOptions"
                :key="r.id"
                :value="r.id"
              >
                {{ r.name }}
              </option>
            </select>
          </label>
        </div>
        <p
          v-if="error"
          class="err"
        >
          {{ error }}
        </p>
        <div class="m-actions">
          <button
            class="ghost-btn"
            @click="close"
          >
            {{ $t('common.cancel') }}
          </button>
          <button
            class="pill-btn"
            :disabled="posting || !draft.summary.trim()"
            @click="onSubmit"
          >
            {{ $t('logs.mSubmit') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 错误条:结果表内的同名规则是逐字复制(样式随标记走,不抽公共 css) */
.err { margin: 0; padding: 8px 14px; font-size: 13px; color: var(--tone-danger-dot); }
/* 输入框工具类:筛选卡内的同名规则是逐字复制(同上;.m-f .inp-sel 的更高特异性压制它,
   与原页面同一层叠关系) */
.inp-sel {
  min-width: 0; padding: 6px 9px; font-size: 13px; color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
}
.inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }

.m-title { margin: 0 0 10px; font-size: 15px; color: var(--ink); }
.modal-mask {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
  backdrop-filter: blur(3px);
}
.modal {
  width: min(560px, 94vw);
  padding: 16px 18px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 12px;
  backdrop-filter: blur(calc(var(--aurora-blur) * 1.4)) saturate(1.2);
}
.m-f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.m-f textarea, .m-f .inp-sel {
  padding: 7px 9px; font-size: 13px; color: var(--ink);
  background: var(--frost-bg); border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
  font-family: inherit; resize: vertical;
}
.m-f textarea:focus, .m-f .inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }
.m-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
.m-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }

@media (max-width: 899px) {
  /* 手指命中区:弹窗动作按钮的原始高度偏小。
     同一组声明(原页面 scoped 块 @media 899 内)按"样式随标记走"的约束
     逐字复制进需要它的每个组件 —— 此处与 LogsPageHead/LogsFilterCard/LogsEventTable
     的对应块是有意重复,不要合并成公共 css。 */
  .m-actions .pill-btn,
  .m-actions .ghost-btn {
    min-height: 40px;
    padding: 8px 14px;
  }
}
</style>
