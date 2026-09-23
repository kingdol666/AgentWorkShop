/**
 * 小镇视图 — 告警系统(阈值越限/状态流转)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 阈值越限自动告警 + 状态流转 待处理→处理中→已确认。
 */
import { computed, ref } from 'vue'
import type { AlarmItem } from './town-view-types'

export function useTownAlarms() {
  const { t } = useI18n()

  /* ============================================================
   * 告警系统(设计稿:阈值越限自动告警 + 状态流转 待处理→处理中→已确认)
   * ============================================================ */
  const alarms = ref<AlarmItem[]>([])
  let alarmTid = 0
  const ALARM_STATES = [t('townView.k3ng94k170'), t('townView.k3mi2n0171'), t('townView.k3ncnxl172')] as const
  function raiseAlarm(txt: string, level: AlarmItem['level'] = 'warn', src = 'SYSTEM'): void {
    const d = new Date()
    const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
    alarms.value.unshift({ id: ++alarmTid, txt, src, time, state: 0, level })
    if (alarms.value.length > 30) alarms.value.pop()
  }
  const activeAlarmCount = computed(() => alarms.value.filter(a => a.state < 2).length)
  function advanceAlarm(id: number): void {
    const a = alarms.value.find(x => x.id === id)
    if (!a) return
    a.state = Math.min(2, a.state + 1) as AlarmItem['state']
  }
  function clearAlarms(): void {
    alarms.value = alarms.value.map(a => ({ ...a, state: 2 as const }))
  }

  return { alarms, ALARM_STATES, raiseAlarm, activeAlarmCount, advanceAlarm, clearAlarms }
}
