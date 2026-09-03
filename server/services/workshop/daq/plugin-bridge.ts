import type { DaqTemplateDef } from '../../../../shared/daq-protocol'
import { getDaqTemplateRegistry } from './daq-templates'
import { registerPluginDriver } from './drivers'
import { registerFrameProcessor } from './frames'

interface DaqPluginBridge {
  pendingDrivers: unknown[]
  pendingProcessors: Array<{ kind: string, name: string, fn: unknown }>
  pendingTemplates: unknown[]
  /** 回放槽(drain 接管后设置;注册即时回调) */
  _drain?: () => void
  registerDriver(d: unknown): void
  registerProcessor(kind: string, name: string, fn: unknown): void
  registerTemplate(t: unknown): void
  drain(onDriver: (d: unknown) => void, onProcessor: (kind: string, name: string, fn: unknown) => void, onTemplate: (t: unknown) => void): void
}

/** 自建桥(仅队列 + drain 槽;宿主后到时由其接管) */
function makeDaqBridge(): DaqPluginBridge {
  return {
    pendingDrivers: [],
    pendingProcessors: [],
    pendingTemplates: [],
    registerDriver(d) {
      this.pendingDrivers.push(d)
      this._drain?.()
    },
    registerProcessor(kind, name, fn) {
      this.pendingProcessors.push({ kind, name, fn })
      this._drain?.()
    },
    registerTemplate(t) {
      this.pendingTemplates.push(t)
      this._drain?.()
    },
    drain(onDriver, onProcessor, onTemplate) {
      this._drain = () => {
        for (const d of this.pendingDrivers.splice(0)) onDriver(d)
        for (const p of this.pendingProcessors.splice(0)) onProcessor(p.kind, p.name, p.fn)
        for (const t of this.pendingTemplates.splice(0)) onTemplate(t)
      }
      this._drain()
    },
  }
}

let attached = false

export function attachDaqPluginBridge(): void {
  if (attached) return
  attached = true
  // 顺序无关:daq 先于插件宿主装载时桥尚不存在 → 此处自建(仅队列+drain 槽);
  // 反之宿主已建桥则直接接管。drain 设槽即回放,后续注册实时到达。
  const g = globalThis as { __daqPluginExt?: DaqPluginBridge }
  const bridge: DaqPluginBridge = g.__daqPluginExt ?? makeDaqBridge()
  g.__daqPluginExt = bridge
  bridge.drain(
    d => registerPluginDriver(d as Parameters<typeof registerPluginDriver>[0]),
    (kind, name, fn) => registerFrameProcessor({
      name,
      applies: kind === 'vector' ? 'vector' : kind === 'image' ? 'image' : 'any',
      process: fn as Parameters<typeof registerFrameProcessor>[0]['process'],
    }),
    (t) => {
      try {
        getDaqTemplateRegistry().registerPlugin(t as DaqTemplateDef)
      }
      catch (err) {
        console.error('[daq] 插件模板注册失败:', err instanceof Error ? err.message : err)
      }
    },
  )
}
