/**
 * DaqControllerDriverProbe —— 驱动探测、目录与遗留孪生补齐
 * (拆分层,承 DaqControllerCrud;方法体与原文件逐行一致)
 */
import { DaqControllerCrud } from './crud'
import type { DaqDriverKind, DriverTestResult } from '../../../../../shared/daq-protocol'
import { DaqNode } from '../daq-node'
import { driverCatalog, normalizeDriverKind, probeDriverAvailability, resolveDaqDriver } from '../drivers'
import { getDaqHostPorts } from '../host-ports'

export abstract class DaqControllerDriverProbe extends DaqControllerCrud {
  /** 连接测试:按协议参数建连 + 读一次(前端"测试连接"按钮直达) */
  async testDriver(kind: DaqDriverKind, driverConfig: Record<string, unknown>): Promise<DriverTestResult> {
    const drv = resolveDaqDriver(normalizeDriverKind(kind))
    if (!(await drv.available())) {
      return { ok: false, message: `协议栈不可用(包未安装或加载失败): ${kind}` }
    }
    return drv.test(driverConfig)
  }

  /** 存量节点连接测试(用节点已保存参数) */
  async testNode(id: string): Promise<DriverTestResult> {
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    return this.testDriver(node.driver, node.driverConfig)
  }

  /** 驱动可用性(meta;包缺失 → planned 提示而非硬失败;含插件驱动) */
  async driverAvailability(): Promise<Record<string, boolean>> {
    return probeDriverAvailability()
  }

  /** 驱动目录(内置 + 插件自描述合并;前端「添加节点」下拉/动态参数表单数据源) */
  async driverCatalog(): Promise<ReturnType<typeof driverCatalog>> {
    return driverCatalog()
  }

  // ---------- 存量迁移(device-twins kind=daq → DaqNode 幂等供给) ----------

  /**
   * 旧前端把数采实例存成 device-twins(kind='daq');切换为服务端权威实体后,
   * 首次访问把存量孪生逐条升格为 DaqNode(位置/名称沿用)。幂等:确定性主键
   * `dn-lg-<twinId>` —— 重复供给/HMR 双实例都不会产生第二条。
   */
  provisionLegacyTwins(): void {
    this.ensureLoop()
    const twins = getDaqHostPorts()?.telemetry.listDaqTwins() ?? []
    for (const t of twins) {
      if (!t.modelRef) continue
      const stableId = `dn-lg-${t.id}`
      if (this.repo.byId(stableId)) continue
      const node = new DaqNode({
        id: stableId,
        templateRef: t.modelRef,
        name: t.name,
        posX: t.posX,
        posZ: t.posZ,
      })
      ;(node as unknown as { sourceTwinId?: string }).sourceTwinId = t.id
      this.repo.insert(node)
    }
    this.syncRuntimes()
  }
}
