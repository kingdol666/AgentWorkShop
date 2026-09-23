/**
 * useDeviceTwinDcwWrite —— 智控设定写入态(每张设备卡:当前 set 值展示 + 窗口内直写下发)。
 *
 * 自 DeviceTwinPanel.vue 抽出(纯搬移,行为逐字保持):
 *   - 草稿/错误按智控节点 id 键控、busy 为单值 —— 整面板一份:面板 setup 建并 provide,
 *     智控通道区经 useDeviceTwinDcwWriteContext() 取回同一份,不新建响应式副本;
 *   - 下发先本地窗口校验(不越限),再走 server write(配方联锁二道门)。
 */
import { inject, provide, reactive, type InjectionKey } from 'vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { useDcwStream } from './useDcwStream'
import type { DcwLiveRow } from './device-twin-types'

export interface DeviceTwinDcwWriteStore {
  /** 写入草稿(智控节点 id 键控) */
  drafts: Record<string, number | ''>
  /** 写入错误(智控节点 id 键控) */
  errs: Record<string, string>
  /** 正在下发的通道 id(空 = 空闲) */
  busy: string
  /** 智控上下限文案(无穷大显示 ±∞) */
  winText(r: DcwLiveRow): string
  /** 下发设定值:先本地窗口校验(不越限),再走 server write(配方联锁二道门) */
  write(r: DcwLiveRow): void
}

export function useDeviceTwinDcwWrite(): DeviceTwinDcwWriteStore {
  const { t } = useI18n()
  const dcw = useDcwStream()

  const store: DeviceTwinDcwWriteStore = reactive({
    drafts: {},
    errs: {},
    busy: '',
    /** 智控上下限文案(无穷大显示 ±∞) */
    winText: (r: DcwLiveRow): string =>
      `${Number.isFinite(r.lo) ? r.lo : '-∞'} ~ ${Number.isFinite(r.hi) ? r.hi : '+∞'} ${r.unit}`,
    write(r: DcwLiveRow): void {
      const raw = store.drafts[r.id]
      if (raw == null || raw === '') return
      const v = Number(raw)
      if (v < r.lo || v > r.hi) {
        store.errs[r.id] = t('deviceTwinPanel.kxddket010', { p0: r.src === 'recipe' ? t('deviceTwinPanel.kq2jssk008') : t('deviceTwinPanel.k1iwj796009'), p1: store.winText(r) })
        return
      }
      store.errs[r.id] = ''
      store.busy = r.id
      void dcw.write(r.id, v).then((out) => {
        if (!out.ok) store.errs[r.id] = out.message
      }).catch((err: unknown) => {
        store.errs[r.id] = apiErrorMessage(err)
      }).finally(() => {
        store.busy = ''
      })
    },
  })
  return store
}

export type DeviceTwinDcwWriteApi = ReturnType<typeof useDeviceTwinDcwWrite>

/** 注入键:整面板共享同一份智控写入态 */
export const deviceTwinDcwWriteKey: InjectionKey<DeviceTwinDcwWriteApi> = Symbol('aw.deviceTwin.dcwWrite')

/** 拥有方(DeviceTwinPanel)侧:创建智控写入态并提供给子树 */
export function provideDeviceTwinDcwWrite(): DeviceTwinDcwWriteApi {
  const api = useDeviceTwinDcwWrite()
  provide(deviceTwinDcwWriteKey, api)
  return api
}

/** 消费方(DeviceTwinDcwSection)侧:取祖先提供的同一份智控写入态 */
export function useDeviceTwinDcwWriteContext(): DeviceTwinDcwWriteApi {
  const api = inject(deviceTwinDcwWriteKey)
  if (!api) throw new Error('[deviceTwin] useDeviceTwinDcwWriteContext: 缺少 provideDeviceTwinDcwWrite()')
  return api
}
