import type { DcwWriteDriver } from './drivers'
import { registerPluginWriteDriver } from './drivers'

interface DcwPluginBridge {
  pendingDrivers: unknown[]
  /** 回放槽(drain 接管后设置;注册即时回调) */
  _drain?: () => void
  registerWriteDriver(d: unknown): void
  drain(onDriver: (d: unknown) => void): void
}

/** 自建桥(仅队列 + drain 槽;宿主后到时由其接管) */
function makeDcwBridge(): DcwPluginBridge {
  return {
    pendingDrivers: [],
    registerWriteDriver(d) {
      this.pendingDrivers.push(d)
      this._drain?.()
    },
    drain(onDriver) {
      this._drain = () => {
        for (const d of this.pendingDrivers.splice(0)) onDriver(d)
      }
      this._drain()
    },
  }
}

let attached = false

/**
 * DCW 写驱动插件桥 —— 与数采侧 attachDaqPluginBridge 同构:
 * 插件宿主与 dcw 模块装载顺序无关(谁后到谁接管,先到的注册项排队回放)。
 * 在 dcw-controller 模块装载时调用一次。
 */
export function attachDcwPluginBridge(): void {
  if (attached) return
  attached = true
  const g = globalThis as { __dcwPluginExt?: DcwPluginBridge }
  const bridge: DcwPluginBridge = g.__dcwPluginExt ?? makeDcwBridge()
  g.__dcwPluginExt = bridge
  bridge.drain(
    d => registerPluginWriteDriver(d as DcwWriteDriver),
  )
}
