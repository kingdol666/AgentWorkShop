<script setup lang="ts">
import { useHitlStore } from '@/app/stores/workshop/hitl'
import { useHitlAnswer } from '@/app/composables/workshop/useHitlAnswer'

const { t } = useI18n()
const hitl = useHitlStore()
const {
  HITL_KINDS,
  hitlKindLabel,
  hitlGo,
  permsKnown,
  canAnswer,
  requestTypeOf,
  isQuestion,
  isNativeOptionApproval,
  qFree,
  slotOf,
  isChosen,
  chooseOption,
  questionsOf,
  submitQuestion,
  submitNativeOption,
  submitApproval,
  submitCancel,
  policyLabel,
} = useHitlAnswer()
</script>

<template>
  <a-dropdown
    v-if="hitl.count > 0"
    placement="bottomRight"
  >
    <button
      class="icon-btn hitl-bell"
      :title="t('appHeader.hitlBadge')"
    >
      <span class="i-tabler-bell-ringing" />
      <span class="hitl-count">{{ hitl.count }}</span>
    </button>
    <template #overlay>
      <div class="hitl-menu">
        <div class="hitl-menu-title">
          {{ t('appHeader.hitlBadge') }} · {{ hitl.count }}
        </div>
        <div
          v-for="item in hitl.items"
          :key="`${item.kind}:${item.id}`"
          class="hitl-item"
        >
          <!-- 头部:点击进运行时监控(定位 agent/channel);应答控件在下方独立区域 -->
          <button
            type="button"
            class="hitl-item-head"
            @click="hitlGo(item)"
          >
            <span class="hitl-item-top">
              <span class="hitl-item-agent">{{ item.agentName }}</span>
              <span class="hitl-item-kind">{{ hitlKindLabel(item.kind) }}</span>
              <span
                v-if="item.requestType || isQuestion(item)"
                class="hitl-item-reqtype"
                :data-type="requestTypeOf(item)"
              >{{ isQuestion(item) ? '提问' : '审批' }}</span>
            </span>
            <span class="hitl-item-title">{{ item.title }}</span>
            <span
              v-if="item.detail"
              class="hitl-item-detail"
            >{{ item.detail }}</span>
            <span
              v-if="item.message"
              class="hitl-item-detail"
            >{{ item.message }}</span>
            <span
              v-if="item.policy"
              class="hitl-item-policy"
            >
              <span class="i-tabler-shield-lock" /> 策略:{{ policyLabel(item) }}
            </span>
          </button>

          <!-- 应答控件:仅具备审批资格的调用者可见(服务端策略 owner_only/any_member) -->
          <div
            v-if="!HITL_KINDS.includes(item.kind)"
            class="hitl-answer-note"
          >
            该类型待办需在对应引擎界面处理
          </div>
          <div
            v-else-if="!permsKnown(item)"
            class="hitl-answer-note"
          >
            读取审批权限…
          </div>
          <div
            v-else-if="!canAnswer(item)"
            class="hitl-answer-note"
          >
            无审批权限{{ item.policy ? `(${policyLabel(item)})` : '' }}
          </div>
          <div
            v-else
            class="hitl-answer"
          >
            <!-- 提问型:有 questions 时逐题收集;否则单个自由文本/选项组 -->
            <template v-if="isQuestion(item)">
              <div
                v-for="(q, qi) in questionsOf(item)"
                :key="`${item.kind}:${item.id}:${q.id}:${qi}`"
                class="hitl-q"
              >
                <div
                  v-if="item.questions && item.questions.length > 1"
                  class="hitl-q-title"
                >
                  {{ qi + 1 }}. {{ q.header || q.question }}
                </div>
                <div
                  v-if="q.header && q.question"
                  class="hitl-q-desc"
                >
                  {{ q.question }}
                </div>
                <div
                  v-if="q.options && q.options.length > 0"
                  class="hitl-opts"
                >
                  <button
                    v-for="o in q.options"
                    :key="o.label"
                    type="button"
                    class="hitl-opt"
                    :class="{ on: isChosen(item, q, o.label) }"
                    :title="o.description || o.label"
                    @click="chooseOption(item, q, o.label)"
                  >
                    {{ o.label }}
                  </button>
                </div>
                <a-textarea
                  v-if="!(q.options && q.options.length > 0) || q.freeText"
                  v-model:value="qFree[slotOf(item, q.id)]"
                  :rows="2"
                  :placeholder="q.options && q.options.length > 0 ? '补充说明(可选)' : '输入答案'"
                />
              </div>
              <div class="hitl-btns">
                <a-button
                  size="small"
                  type="primary"
                  :loading="hitl.answering === `${item.kind}:${item.id}`"
                  @click="submitQuestion(item)"
                >
                  提交答案
                </a-button>
                <a-button
                  size="small"
                  :disabled="hitl.answering === `${item.kind}:${item.id}`"
                  @click="submitCancel(item)"
                >
                  取消请求
                </a-button>
              </div>
            </template>

            <!-- 授权型:批准/拒绝(引擎原生枚举的 kind 另给选项按钮) -->
            <template v-else>
              <div
                v-if="isNativeOptionApproval(item)"
                class="hitl-opts"
              >
                <button
                  v-for="o in item.options"
                  :key="o"
                  type="button"
                  class="hitl-opt"
                  @click="submitNativeOption(item, o)"
                >
                  {{ o }}
                </button>
              </div>
              <div class="hitl-btns">
                <a-button
                  size="small"
                  type="primary"
                  :loading="hitl.answering === `${item.kind}:${item.id}`"
                  @click="submitApproval(item, true)"
                >
                  {{ t('appHeader.hitlApprove') }}
                </a-button>
                <a-button
                  size="small"
                  danger
                  :disabled="hitl.answering === `${item.kind}:${item.id}`"
                  @click="submitApproval(item, false)"
                >
                  {{ t('appHeader.hitlReject') }}
                </a-button>
                <a-button
                  size="small"
                  :disabled="hitl.answering === `${item.kind}:${item.id}`"
                  @click="submitCancel(item)"
                >
                  取消
                </a-button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </a-dropdown>
</template>

<style scoped>
/* 幽灵图标钮:无描边,悬停浮 surface(open-tag tp-close 声部) */
/* 触发钮是 a-dropdown 的 slot 后代,scope id 不会从 AppHeader 继承过来(单根继承链
 * 在 Trigger 的 Fragment 根处断开),所以与父组件同一组规则在此原样重述 —— 且必须
 * 排在 .hitl-bell 之前,才能像原来那样让琥珀色覆盖基色。CSS 声明逐字未改。 */
.collapse-btn,
.icon-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.collapse-btn:active,
.icon-btn:active {
  transform: scale(0.94);
}

/* ── HITL 待办铃标(琥珀警示;角标数字极简,无装饰堆砌) ── */
.hitl-bell {
  position: relative;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-count {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  color: var(--on-accent, #fff);
  text-align: center;
  background: var(--tone-danger-dot, #e05252);
  border-radius: 8px;
}
.hitl-menu {
  min-width: 300px;
  max-width: 380px;
  max-height: 70vh;
  padding: 6px;
  overflow-y: auto;
  background: var(--paper, #fff);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 10px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
}
.hitl-menu-title {
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.hitl-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-panel-sm, 8px);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.hitl-item:hover {
  background: var(--paper-deep);
  border-color: var(--line);
}
/* 头部是按钮(点击进运行时监控);应答控件在其下方独立成区,不触发跳转 */
.hitl-item-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 0;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.hitl-item-top {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
}
.hitl-item-agent {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.hitl-item-kind {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-item-reqtype {
  flex: none;
  padding: 0 5px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.hitl-item-reqtype[data-type='question'] { color: var(--tone-info-dot, #3b82f6); border-color: color-mix(in srgb, var(--tone-info-dot, #3b82f6) 40%, transparent); }
.hitl-item-title {
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
}
.hitl-item-detail {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-faint);
  text-overflow: ellipsis;
}
.hitl-item-policy {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  color: var(--ink-fainter);
}
.hitl-answer-note {
  padding: 3px 0;
  font-size: 10.5px;
  color: var(--ink-fainter);
}
.hitl-answer {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
.hitl-q {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hitl-q-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink);
}
.hitl-q-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-faint);
}
.hitl-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.hitl-opt {
  padding: 3px 9px;
  font-family: var(--font-body);
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper, #fff);
  border: 1px solid var(--line-strong, var(--line));
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
}
.hitl-opt:hover { color: var(--ink); border-color: var(--ink-fainter); }
.hitl-opt.on {
  font-weight: 600;
  color: var(--on-accent, #fff);
  background: var(--accent, #2f2a26);
  border-color: var(--accent, #2f2a26);
}
.hitl-btns {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
</style>
