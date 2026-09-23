/**
 * SystemConfigServiceContracts —— **跨层能力契约**。
 *
 * 拆成 8 层后,有 5 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   broadcast  → 由 mutate.ts 实现
 *   eventTail  → 由 mutate.ts 实现
 *   migrateLegacyPluginKeys  → 由 plugins.ts 实现
 *   reloadFromDisk  → 由 recompute.ts 实现
 *   watchFiles  → 由 snapshot.ts 实现
 */
import type { ConfigEventPayload } from './types'

export abstract class SystemConfigServiceContracts {
  protected abstract broadcast(payload: ConfigEventPayload): void
  /** 原方法无返回类型标注,此处按实现体的实际返回形状显式写出(契约签名不能省类型) */
  protected abstract eventTail(): {
    restartRequired: string[]
    effective: Record<string, unknown>
    sources: Record<string, unknown>
    overrides: Record<string, unknown>
    at: string
  }
  protected abstract migrateLegacyPluginKeys(): { changed: string[] }
  abstract reloadFromDisk(): { changed: string[] }
  protected abstract watchFiles(): void
}
