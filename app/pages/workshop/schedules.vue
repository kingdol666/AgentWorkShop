<script setup lang="ts">
/**
 * 定时任务中心(v16):绑定 Channel 的周期任务编排。
 * - 两种触发模式:interval 固定间隔(下限 1 分钟)/ daily 每日定点(本地时区 HH:MM)。
 * - 到点 → 服务端以「定时任务」身份向绑定 Channel 提交任务(与人类提交同链路);
 *   Channel 有未收口任务时置 waiting,等全部收口后下一 tick 自动补触发。
 * - 运行历史:每次触发的留痕(timer/manual、RUNNING/COMPLETED/FAILED、错误)。
 * - 熔断:连续失败达阈值自动停用;重新启用即重置计数并重新计时。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ScheduleDto, type ScheduleRunDto, type ChannelDto } from '../../composables/workshop/useWorkshopApi'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
const schedules = ref<ScheduleDto[]>([])
const channels = ref<ChannelDto[]>([])
const loading = ref(false)

const load = async (): Promise<void> => {
  loading.value = true
  try {
    const [s, ch] = await Promise.all([
      api.listSchedules(),
      api.listChannels().catch(() => null),
    ])
    schedules.value = (s as unknown as { data?: ScheduleDto[] })?.data ?? []
    channels.value = (ch as unknown as { data?: ChannelDto[] } | null)?.data ?? []
  }
  finally {
    loading.value = false
  }
}
// SSR 安全:axios 相对 baseURL 仅客户端有效(同 agents/channel-templates 页)
if (import.meta.client) void load()

// 轻量轮询:runtime 状态(waiting/running)与 next_run_at 由服务端推进,5s 静默对齐
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(() => {
    void api.listSchedules().then((s) => {
      schedules.value = (s as unknown as { data?: ScheduleDto[] })?.data ?? []
    }).catch(() => { /* 轮询失败静默,下一轮重试 */ })
  }, 5000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

// ===== 呈现辅助 =====
// 显式列(项目惯例,users.vue 同款):不传 columns 时 antd 从数据行推断,
// headerCell/bodyCell 插槽的 column 在推断路径上可能为 undefined → 渲染崩(实测踩过)
const columns = computed(() => [
  { key: 'name', title: t('sched.colName'), dataIndex: 'name' },
  { key: 'channel', title: t('sched.colChannel'), dataIndex: 'channelName' },
  { key: 'state', title: t('sched.colState'), width: 150 },
  { key: 'plan', title: t('sched.colPlan') },
  { key: 'lastRun', title: t('sched.colLastRun') },
  { key: 'action', title: t('common.actions'), width: 168 },
])

const shortTime = (iso: string | null | undefined): string =>
  iso ? iso.slice(0, 16).replace('T', ' ') : '—'

const modeLabel = (s: ScheduleDto): string =>
  s.mode === 'daily'
    ? t('sched.modeDaily', { p0: s.dailyTime })
    : t('sched.modeInterval', { p0: humanInterval(s.intervalMs) })

const humanInterval = (ms: number): string => {
  if (ms < 3600_000) return t('sched.minutes', { p0: Math.round(ms / 60_000) })
  if (ms % 3600_000 === 0) return t('sched.hours', { p0: ms / 3600_000 })
  return t('sched.minutes', { p0: Math.round(ms / 60_000) })
}

interface StateTag { text: string, color: string }
const stateTag = (s: ScheduleDto): StateTag => {
  if (s.enabled !== 1) {
    return s.state === 'failed'
      ? { text: t('sched.stateTripped'), color: 'red' }
      : { text: t('sched.stateDisabled'), color: 'default' }
  }
  switch (s.state) {
    case 'running': return { text: t('sched.stateRunning'), color: 'blue' }
    case 'waiting': return { text: t('sched.stateWaiting'), color: 'orange' }
    case 'failed': return { text: t('sched.stateFailed'), color: 'red' }
    default: return { text: t('sched.stateIdle'), color: 'green' }
  }
}

// ===== 新建 / 编辑 =====
const editOpen = ref(false)
const editingId = ref<string | null>(null) // null = 新建
const saving = ref(false)
const form = reactive({
  name: '',
  channelId: undefined as string | undefined,
  title: '',
  description: '',
  mode: 'interval' as 'interval' | 'daily',
  intervalMinutes: 30,
  dailyTime: '09:00',
  maxConsecutiveFailures: 0,
})

const channelOptions = computed(() => channels.value.map(c => ({
  value: c.id,
  label: `${c.name}${c.scheduledCount ? t('sched.channelHasSched') : ''}`,
})))

const openCreate = (): void => {
  editingId.value = null
  form.name = ''
  form.channelId = channels.value[0]?.id
  form.title = ''
  form.description = ''
  form.mode = 'interval'
  form.intervalMinutes = 30
  form.dailyTime = '09:00'
  form.maxConsecutiveFailures = 0
  editOpen.value = true
}

const openEdit = (s: ScheduleDto): void => {
  editingId.value = s.id
  form.name = s.name
  form.channelId = s.channelId
  form.title = s.title
  form.description = s.description
  form.mode = s.mode
  form.intervalMinutes = Math.max(1, Math.round(s.intervalMs / 60_000))
  form.dailyTime = s.dailyTime || '09:00'
  form.maxConsecutiveFailures = s.maxConsecutiveFailures
  editOpen.value = true
}

const save = async (): Promise<void> => {
  if (!form.name.trim()) {
    message.warning(t('sched.nameRequired'))
    return
  }
  if (!form.channelId) {
    message.warning(t('sched.channelRequired'))
    return
  }
  if (!form.title.trim()) {
    message.warning(t('sched.titleRequired'))
    return
  }
  if (form.mode === 'daily' && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(form.dailyTime)) {
    message.warning(t('sched.badDailyTime'))
    return
  }
  saving.value = true
  try {
    if (editingId.value) {
      await api.updateSchedule(editingId.value, {
        name: form.name.trim(),
        title: form.title.trim(),
        description: form.description,
        mode: form.mode,
        intervalMs: form.mode === 'interval' ? form.intervalMinutes * 60_000 : undefined,
        dailyTime: form.mode === 'daily' ? form.dailyTime : undefined,
        maxConsecutiveFailures: form.maxConsecutiveFailures,
      })
      message.success(t('sched.saved'))
    }
    else {
      await api.createSchedule({
        channelId: form.channelId,
        name: form.name.trim(),
        title: form.title.trim(),
        description: form.description,
        mode: form.mode,
        intervalMs: form.mode === 'interval' ? form.intervalMinutes * 60_000 : undefined,
        dailyTime: form.mode === 'daily' ? form.dailyTime : undefined,
        maxConsecutiveFailures: form.maxConsecutiveFailures,
      })
      message.success(t('sched.created'))
    }
    editOpen.value = false
    await load()
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    saving.value = false
  }
}

// ===== 启停 / 删除 / 立即执行 =====
const toggleEnabled = async (s: ScheduleDto, next: boolean): Promise<void> => {
  try {
    await api.updateSchedule(s.id, { enabled: next ? 1 : 0 })
    message.success(next ? t('sched.enabledMsg') : t('sched.disabledMsg'))
    await load()
  }
  catch (e) {
    message.error(apiErrorMessage(e))
    await load()
  }
}

const runNow = async (s: ScheduleDto): Promise<void> => {
  try {
    const r = await api.runSchedule(s.id)
    const data = (r as unknown as { data?: { taskId?: string } })?.data
    message.success(t('sched.runAccepted', { p0: data?.taskId?.slice(0, 8) ?? '' }))
    await load()
  }
  catch (e) {
    // Channel 忙(409)是预期语义:如实转述,不作为异常弹出
    message.warning(apiErrorMessage(e))
    await load()
  }
}

const remove = async (s: ScheduleDto): Promise<void> => {
  try {
    await api.deleteSchedule(s.id)
    message.success(t('sched.deleted'))
    await load()
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
}

// ===== 运行历史 =====
const historyOpen = ref(false)
const historySchedule = ref<ScheduleDto | null>(null)
const historyRuns = ref<ScheduleRunDto[]>([])
const historyLoading = ref(false)
const openHistory = async (s: ScheduleDto): Promise<void> => {
  historySchedule.value = s
  historyOpen.value = true
  historyLoading.value = true
  try {
    const r = await api.listScheduleRuns(s.id, 50)
    historyRuns.value = (r as unknown as { data?: ScheduleRunDto[] })?.data ?? []
  }
  catch (e) {
    message.error(apiErrorMessage(e))
  }
  finally {
    historyLoading.value = false
  }
}
const runStateTag = (r: ScheduleRunDto): StateTag =>
  r.state === 'COMPLETED'
    ? { text: t('sched.runDone'), color: 'green' }
    : r.state === 'FAILED'
      ? { text: t('sched.runFail'), color: 'red' }
      : { text: t('sched.runOngoing'), color: 'blue' }

useHead({ title: () => t('titles.schedules') })
</script>

<template>
  <div class="page-wrap">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          workshop / schedules
        </p>
        <h1>
          {{ t('sched.title') }}
        </h1>
        <p class="sub">
          {{ t('sched.sub') }}
        </p>
      </div>
      <button
        class="aw-pill im"
        @click="openCreate"
      >
        <span class="i-tabler-clock-plus im-pop" />
        {{ t('sched.newBtn') }}
      </button>
    </div>

    <a-card
      :bordered="false"
      class="table-card"
    >
      <a-table
        :data-source="schedules"
        :columns="columns"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
        :locale="{ emptyText: t('sched.empty') }"
      >
        <template #headerCell="{ column }">
          <template v-if="column.key === 'state'">
            <span class="i-tabler-activity head-ico" /> {{ t('sched.colState') }}
          </template>
          <template v-else-if="column.key === 'plan'">
            <span class="i-tabler-clock head-ico" /> {{ t('sched.colPlan') }}
          </template>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div class="cell-name">
              {{ (record as ScheduleDto).name }}
            </div>
            <div class="cell-sub">
              {{ (record as ScheduleDto).title }}
            </div>
          </template>
          <template v-else-if="column.key === 'channel'">
            <span class="aw-mono">#</span> {{ (record as ScheduleDto).channelName }}
          </template>
          <template v-else-if="column.key === 'state'">
            <a-space size="small">
              <a-tag :color="stateTag(record as ScheduleDto).color">
                {{ stateTag(record as ScheduleDto).text }}
              </a-tag>
              <a-switch
                :checked="(record as ScheduleDto).enabled === 1"
                size="small"
                :title="t('sched.enableToggle')"
                @change="(v: any) => toggleEnabled(record as ScheduleDto, !!v)"
              />
            </a-space>
          </template>
          <template v-else-if="column.key === 'plan'">
            <div class="cell-plan">
              {{ modeLabel(record as ScheduleDto) }}
            </div>
            <div class="cell-sub">
              {{ t('sched.nextRun') }} {{ shortTime((record as ScheduleDto).nextRunAt) }}
            </div>
          </template>
          <template v-else-if="column.key === 'lastRun'">
            <div>{{ shortTime((record as ScheduleDto).lastRunAt) }}</div>
            <div class="cell-sub">
              {{ t('sched.statLine', { p0: (record as ScheduleDto).runCount, p1: (record as ScheduleDto).failCount }) }}
              <template v-if="(record as ScheduleDto).maxConsecutiveFailures > 0">
                · {{ t('sched.fuseLine', { p0: (record as ScheduleDto).consecutiveFailures, p1: (record as ScheduleDto).maxConsecutiveFailures }) }}
              </template>
            </div>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space size="small">
              <a-button
                size="small"
                type="text"
                :disabled="(record as ScheduleDto).state === 'running' || (record as ScheduleDto).enabled !== 1"
                :title="t('sched.runNowTitle')"
                @click="runNow(record as ScheduleDto)"
              >
                <span class="i-tabler-player-play" />
              </a-button>
              <a-button
                size="small"
                type="text"
                :title="t('sched.historyTitle')"
                @click="openHistory(record as ScheduleDto)"
              >
                <span class="i-tabler-history" />
              </a-button>
              <a-button
                size="small"
                type="text"
                :title="t('common.edit')"
                @click="openEdit(record as ScheduleDto)"
              >
                <span class="i-tabler-pencil" />
              </a-button>
              <a-popconfirm
                :title="t('sched.deleteConfirm')"
                @confirm="remove(record as ScheduleDto)"
              >
                <a-button
                  size="small"
                  type="text"
                  danger
                  :title="t('common.delete')"
                >
                  <span class="i-tabler-trash" />
                </a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 新建 / 编辑 -->
    <a-modal
      v-model:open="editOpen"
      :title="editingId ? t('sched.editTitle') : t('sched.createTitle')"
      :confirm-loading="saving"
      :ok-text="$t('common.save')"
      :cancel-text="$t('common.cancel')"
      @ok="save"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('sched.fName')">
          <a-input
            v-model:value="form.name"
            :placeholder="t('sched.fNamePh')"
          />
        </a-form-item>
        <a-form-item :label="t('sched.fChannel')">
          <a-select
            v-model:value="form.channelId"
            :options="channelOptions"
            show-search
            :placeholder="t('sched.fChannelPh')"
          />
        </a-form-item>
        <a-form-item :label="t('sched.fTitle')">
          <a-input
            v-model:value="form.title"
            :placeholder="t('sched.fTitlePh')"
          />
        </a-form-item>
        <a-form-item :label="t('sched.fDesc')">
          <a-textarea
            v-model:value="form.description"
            :rows="3"
            :placeholder="t('sched.fDescPh')"
          />
        </a-form-item>
        <a-form-item :label="t('sched.fMode')">
          <a-radio-group v-model:value="form.mode">
            <a-radio-button value="interval">
              {{ t('sched.modeIntervalRadio') }}
            </a-radio-button>
            <a-radio-button value="daily">
              {{ t('sched.modeDailyRadio') }}
            </a-radio-button>
          </a-radio-group>
        </a-form-item>
        <a-form-item
          v-if="form.mode === 'interval'"
          :label="t('sched.fInterval')"
        >
          <a-input-number
            v-model:value="form.intervalMinutes"
            :min="1"
            :max="43200"
            style="width: 160px"
          />
          <span class="ws-hint">{{ t('sched.fIntervalUnit') }}</span>
        </a-form-item>
        <a-form-item
          v-else
          :label="t('sched.fDailyTime')"
        >
          <a-time-picker
            v-model:value="form.dailyTime"
            format="HH:mm"
            value-format="HH:mm"
            :allow-clear="false"
          />
          <span class="ws-hint">{{ t('sched.fDailyHint') }}</span>
        </a-form-item>
        <a-form-item :label="t('sched.fFuse')">
          <a-input-number
            v-model:value="form.maxConsecutiveFailures"
            :min="0"
            :max="999"
            style="width: 160px"
          />
          <span class="ws-hint">{{ t('sched.fFuseHint') }}</span>
        </a-form-item>
        <a-form-item>
          <span class="ws-hint">{{ t('sched.fSubmitHint') }}</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 运行历史 -->
    <a-drawer
      v-model:open="historyOpen"
      :title="t('sched.historyTitle') + ' · ' + (historySchedule?.name ?? '')"
      width="560"
    >
      <a-spin :spinning="historyLoading">
        <div
          v-if="historyRuns.length === 0"
          class="history-empty"
        >
          {{ t('sched.historyEmpty') }}
        </div>
        <div
          v-for="r in historyRuns"
          :key="r.id"
          class="run-row"
        >
          <div class="run-head">
            <a-tag
              size="small"
              :color="runStateTag(r).color"
            >
              {{ runStateTag(r).text }}
            </a-tag>
            <a-tag
              size="small"
              color="default"
            >
              {{ r.triggerKind === 'manual' ? t('sched.triggerManual') : t('sched.triggerTimer') }}
            </a-tag>
            <span class="run-time">{{ shortTime(r.startedAt) }}<template v-if="r.endedAt"> → {{ shortTime(r.endedAt) }}</template></span>
          </div>
          <div
            v-if="r.taskId"
            class="run-task"
          >
            {{ t('sched.runTask') }} <span class="aw-mono">{{ r.taskId.slice(0, 8) }}</span>
          </div>
          <div
            v-if="r.error"
            class="run-error"
          >
            {{ r.error }}
          </div>
        </div>
      </a-spin>
    </a-drawer>
  </div>
</template>

<style scoped>
.page-wrap {
  max-width: 1120px;
  margin: 0 auto;
}
.sub { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-faint); }
.head-ico { margin-right: 4px; vertical-align: -2px; }
.cell-name { font-weight: 600; }
.cell-plan { font-family: var(--font-mono); font-size: 12px; }
.cell-sub { margin-top: 2px; font-size: 11px; color: var(--ink-faint); }
.ws-hint { margin-left: 10px; font-size: 11px; color: var(--ink-faint); }
.history-empty { padding: 40px 0; text-align: center; font-size: 12.5px; color: var(--ink-faint); }
.run-row {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 8px);
}
.run-head { display: flex; gap: 6px; align-items: center; }
.run-time { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); }
.run-task { margin-top: 6px; font-size: 11.5px; color: var(--ink-soft); }
.run-error { margin-top: 6px; font-size: 11.5px; color: var(--tone-danger, #e5484d); word-break: break-all; }
</style>
