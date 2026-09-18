/**
 * GET /api/workshop/aml/datasets/:id —— 数据集详情(元数据行 + 实体装载)。
 * 实体经 entity.loadDatasetEntity 按 <amlRoot>/datasets/<id> 规范路径加载并校验契约,
 * 不信任元数据行里的 path 字段(历史写入/被搬移后可能失效)。
 * 实体缺失时返回 410 + 元数据行,让 UI 能提示"元数据在、数据没了"而不是整个 500。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { loadDatasetEntity } from '@/server/services/workshop/aml/entity'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const ds = rt.repo.dataset.get(id)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${id} 不存在`)
  requireLineMode(user, ds.lineId, 'readonly')
  try {
    const ent = loadDatasetEntity(id)
    return {
      dataset: ds,
      report: ent.report,
      manifest: ent.manifest,
      spec: ent.spec,
      entity: {
        dir: ent.dir,
        arrays: ent.arrays,
        sizeBytes: ent.sizeBytes,
        healthy: true,
        // 实体是否自带 spec.json(自描述);false = 规格仅存于元数据行(旧快照)
        specFromEntity: ent.specFromEntity,
      },
    }
  }
  catch (err) {
    // ⚠️ 类型漂移记录:AppError 的权威定义只有 status(见 server/utils/errors.ts),没有 statusCode。
    // 原判定读的是不存在的属性 ⇒ 运行时恒为 undefined,这段「实体丢失 → 200 + 元数据告警」兜底
    // **从未命中**(实际行为:loadDatasetEntity 抛 AppError(410) → defineApiHandler 统一转 410 错误信封)。
    // 依「不改变运行时行为」约束,这里只把该事实写实、判定结果保持不变;
    // 若要启用本兜底(与上方文件注释「实体缺失时返回 410 + 元数据行」及前端 report: ... | null 一致),
    // 把下面的 legacyStatusCode 换成 err.status 即可(一行)。
    const legacyStatusCode = (err as { statusCode?: number } | undefined)?.statusCode
    if (err instanceof AppError && legacyStatusCode === 410) {
      // 元数据仍在但实体丢了:仍然 200 返回元数据 + 明确的实体告警,便于 UI 展示与清理引导
      return { dataset: ds, report: null, manifest: null, spec: null, entity: { dir: null, arrays: [], sizeBytes: 0, healthy: false, specFromEntity: false, warning: err.message } }
    }
    throw err
  }
})
