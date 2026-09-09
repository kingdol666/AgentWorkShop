/**
 * AML 运行时装配:db + 数据根目录 + 仓储访问器(插件 workshop.ts 装配,REST/工具读取)。
 * 数据落盘布局(<configRoot>/data/aml/):
 *   datasets/<dsId>/   spec.json + manifest.json + report.json + arrays/*.f32
 *   jobs/<jobId>/      job.json + workspace/(train.py, amlkit.py) + run.log + artifacts/
 *   models/<modelId>/  model.onnx + io_spec.json(注册时从作业工件拷贝,不可变)
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { createAmlRepo, type AmlRepo } from './aml.repo'

export interface AmlRuntime {
  db: DatabaseSync
  /** <configRoot>/data/aml 绝对路径 */
  root: string
  repo: AmlRepo
  datasetsDir: string
  jobsDir: string
  modelsDir: string
}

const g = globalThis as typeof globalThis & { __amlRuntime?: AmlRuntime }

export function configureAmlRuntime(db: DatabaseSync, dataDir: string): AmlRuntime {
  if (g.__amlRuntime) return g.__amlRuntime
  const root = join(dataDir, 'aml')
  const rt: AmlRuntime = {
    db,
    root,
    repo: createAmlRepo(db),
    datasetsDir: join(root, 'datasets'),
    jobsDir: join(root, 'jobs'),
    modelsDir: join(root, 'models'),
  }
  g.__amlRuntime = rt
  return rt
}

export function getAmlRuntime(): AmlRuntime {
  if (!g.__amlRuntime) {
    throw new AppError(503, 'AML_NOT_READY', 'AML 尚未初始化(workshop 插件未执行)')
  }
  return g.__amlRuntime
}
