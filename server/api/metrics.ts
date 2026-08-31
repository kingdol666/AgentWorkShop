/**
 * GET /api/metrics —— 运维指标端点(R4,production-readiness-plan)。
 *
 * text/plain 简易指标格式(键值行,Prometheus 可用 textfile/自定义采集器接入)。
 * 无鉴权:仅暴露聚合计数与时间戳,不含业务数据;内网部署语义。
 * 只读 globalThis 单例(不主动实例化),服务未装配时输出 0 —— 首次抓取即合法。
 */
import { defineEventHandler, setResponseHeader } from 'h3'
import { getOps } from '../services/workshop/ops/ops'

interface MetricLine { name: string, help: string, value: number | string }

function fmt(lines: MetricLine[]): string {
  return lines.map(l => `# HELP ${l.name} ${l.help}\n# TYPE ${l.name} gauge\n${l.name} ${l.value}`).join('\n') + '\n'
}

export default defineEventHandler(async (event) => {
  const g = globalThis as typeof globalThis & {
    __daqController?: { controllerState(): Record<string, number | boolean>, running?: boolean }
    __daqQueue?: { lost?: number }
    __daqQueueBackend?: string
    __toolApprovals?: { listPending(agentId?: string): unknown[] }
    __wsDbFlushFails?: number
    __awBackupLastAt?: string
  }

  const lines: MetricLine[] = []

  // ---- DAQ 数据链路(未运行/未装配时 controllerState 仍可读,计数为 0) ----
  const ctrl = g.__daqController
  if (ctrl) {
    const s = ctrl.controllerState()
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
    lines.push(
      { name: 'awshop_daq_running', help: 'DAQ controller running(1=运行中)', value: s.running ? 1 : 0 },
      { name: 'awshop_daq_nodes_total', help: 'DAQ nodes registered', value: num(s.nodesTotal) },
      { name: 'awshop_daq_nodes_online', help: 'DAQ nodes enabled', value: num(s.nodesOnline) },
      { name: 'awshop_daq_produced_total', help: 'Samples produced by runtimes', value: num(s.produced) },
      { name: 'awshop_daq_consumed_total', help: 'Samples consumed from queue', value: num(s.consumed) },
      { name: 'awshop_daq_dropped_total', help: 'Samples dropped(queue lost + late frames)', value: num(s.dropped) },
      { name: 'awshop_daq_samples_stored_total', help: 'Samples persisted to tsdb', value: num(s.samplesStored) },
      { name: 'awshop_daq_tsdb_dropped_total', help: 'Samples dropped by tsdb writer', value: num(s.tsdbDropped) },
      { name: 'awshop_daq_alarms_raised_total', help: 'Alarms raised(edge-trigger, idempotent)', value: num(s.alarmsRaised) },
    )
  }
  else {
    lines.push(
      { name: 'awshop_daq_running', help: 'DAQ controller running(1=运行中)', value: 0 },
      { name: 'awshop_daq_produced_total', help: 'Samples produced by runtimes', value: 0 },
      { name: 'awshop_daq_samples_stored_total', help: 'Samples persisted to tsdb', value: 0 },
      { name: 'awshop_daq_alarms_raised_total', help: 'Alarms raised(edge-trigger, idempotent)', value: 0 },
    )
  }
  lines.push(
    { name: 'awshop_daq_queue_lost_total', help: 'Frames lost at queue adapter(mqtt断连/inproc拥塞)', value: g.__daqQueue?.lost ?? 0 },
    { name: 'awshop_daq_queue_backend_info', help: 'Queue backend(inproc=0 / mqtt=1)', value: (g.__daqQueueBackend ?? 'inproc') === 'mqtt' ? 1 : 0 },
  )

  // ---- WS 实时通道(落库失败静默重试,只能靠计数观测) ----
  lines.push({ name: 'awshop_ws_db_flush_fails_total', help: 'Channel event batch DB-insert failures', value: g.__wsDbFlushFails ?? 0 })

  // ---- HITL:工具审批 + 高危操作复核待办 ----
  const toolPending = g.__toolApprovals?.listPending().length ?? 0
  const opsPending = getOps()?.approvalRequests.listPending().length ?? 0
  lines.push(
    { name: 'awshop_tool_approvals_pending', help: 'Pending agent tool approvals(HITL)', value: toolPending },
    { name: 'awshop_operation_approvals_pending', help: 'Pending dangerous-operation approval requests(maker-checker)', value: opsPending },
  )

  // ---- 备份(S6) ----
  lines.push({ name: 'awshop_backup_last_success_timestamp', help: 'Last successful backup ISO time(0=从未)', value: g.__awBackupLastAt ?? 0 })

  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return fmt(lines)
})
