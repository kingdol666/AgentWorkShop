/**
 * 小镇视图 — 场景控制(渲染档位/告警阈值/E-STOP/曝光与染色)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 帧率上限/画质档(持久化)、告警阈值与量程公式、E-STOP、曝光/领地染色/重置视角。
 */
import { ref } from 'vue'
import type { ShallowRef } from 'vue'
import { useStorage } from '@vueuse/core'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { AlarmItem } from './town-view-types'

/** 画质档(用户可选 自动/普通/高清/超清;持久化)。auto = 帧率自适应阶梯;三档手动固定 */
export type QualityMode = 'auto' | 'normal' | 'hd' | 'ultra'

export function useTownSceneControl(params: {
  scene3dRef: ShallowRef<TownScene3D | null>
  raiseAlarm: (txt: string, level?: AlarmItem['level'], src?: string) => void
}) {
  const { scene3dRef, raiseAlarm } = params
  const { t } = useI18n()

  /** 告警阈值(设计稿 rThresh 60~120%;>100 收紧,<100 放宽) */
  const threshPct = ref(100)

  /** 帧率上限(用户可选 60/120/∞;持久化)。只节流渲染帧,数据消费走帧通道与此无关 */
  const fpsCap = useStorage<'60' | '120' | '0'>('aw.twin.fpsCap', '60')
  const FPS_OPTIONS = [
    { v: '60', label: '60' },
    { v: '120', label: '120' },
    { v: '0', label: '∞' },
  ] as const
  function setFpsCap(v: '60' | '120' | '0'): void {
    fpsCap.value = v
    scene3dRef.value?.setFpsCap(Number(v))
  }

  /** 画质(用户可选 自动/普通/高清/超清;持久化)。auto = 帧率自适应阶梯;三档手动固定 */
  const qualityMode = useStorage<QualityMode>('aw.twin.quality', 'auto')
  const QUALITY_OPTIONS = [
    { v: 'auto', label: 'townView.qualityAuto' },
    { v: 'normal', label: 'townView.qualityNormal' },
    { v: 'hd', label: 'townView.qualityHD' },
    { v: 'ultra', label: 'townView.qualityUltra' },
  ] as const
  function setQualityMode(v: QualityMode): void {
    qualityMode.value = v
    scene3dRef.value?.setQualityMode(v)
  }
  /** 量程收紧后的告警上下界(设计稿公式:base ± 按阈值比例的内缩区间) */
  function alarmRange(min: number, max: number): { lo: number, hi: number } {
    const t = threshPct.value / 100
    const mid = (min + max) / 2
    return { lo: mid - (mid - min) * t, hi: mid + (max - mid) * t }
  }

  /** E-STOP(设计稿 btnEstop:全线停机态;告警面板置 crit;再次点击解除) */
  const estop = ref(false)
  function toggleEstop(): void {
    estop.value = !estop.value
    raiseAlarm(
      estop.value ? t('townView.kb157zk173') : t('townView.k1s9qzr9174'),
      estop.value ? 'crit' : 'info',
      'SYSTEM',
    )
  }

  /** 场景控制:曝光/领地染色/重置视角 */
  const exposure = ref(1.12)
  const tintOpacity = ref(1)
  /** 滑杆填充比例(--fill;轨道随值染色,设计稿 setSliderFill) */
  function sliderPct(v: number, min: number, max: number): string {
    return `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)).toFixed(1)}%`
  }
  function onExposureInput(e: Event): void {
    exposure.value = Number((e.target as HTMLInputElement).value) / 100
    scene3dRef.value?.setExposure(exposure.value)
  }
  function onTintInput(e: Event): void {
    tintOpacity.value = Number((e.target as HTMLInputElement).value) / 100
    scene3dRef.value?.setTerritoryOpacity(tintOpacity.value)
  }
  function onResetView(): void {
    scene3dRef.value?.resetView()
    exposure.value = 1.12
    tintOpacity.value = 1
    scene3dRef.value?.setExposure(1.12)
    scene3dRef.value?.setTerritoryOpacity(1)
  }

  return { threshPct, fpsCap, FPS_OPTIONS, setFpsCap, qualityMode, QUALITY_OPTIONS, setQualityMode, alarmRange, estop, toggleEstop, exposure, tintOpacity, sliderPct, onExposureInput, onTintInput, onResetView }
}
