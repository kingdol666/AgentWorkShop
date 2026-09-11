/**
 * AML 运行时装配:db + 数据根目录 + 仓储访问器(插件 workshop.ts 装配,REST/工具读取)。
 *
 * 数据落盘布局(<项目根>/aml/ —— 见 shared/config/home.mjs resolveAmlRoot):
 *   .venv/             uv 创建的 Python 环境(固定位置,整体可删重建)
 *   datasets/<dsId>/   spec.json + manifest.json + report.json + arrays/*.f32
 *   jobs/<jobId>/      job.json + workspace/(train.py, amlkit.py) + run.log + artifacts/
 *   models/<modelId>/  model.onnx + io_spec.json(注册时从作业工件拷贝,不可变)
 *   runtime/           运行时状态(uv.json 安装记录 / env.json 探针缓存)
 *   tools/             项目本地自动安装的 uv 二进制(免管理员、不改 PATH)
 *
 * 元数据(SQLite 四表)与实体(磁盘目录)以 id 一一对应:
 *   aml_datasets.id ↔ datasets/<id>/,aml_jobs.id ↔ jobs/<id>/,aml_models.id ↔ models/<id>/
 * reconcileEntity() 负责两侧对账(元数据在而实体丢失 → 标记;实体在而元数据丢失 → 认领/清理)。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { ensureAmlDir, resolveAmlRoot } from '@/shared/config/home.mjs'
import { createAmlRepo, type AmlRepo } from './aml.repo'

export interface AmlRuntime {
  db: DatabaseSync
  /** <项目根>/aml 绝对路径 */
  root: string
  /** 数据根解析来源(env/repo/home/cwd;UI 显示与排障用) */
  rootMode: string
  projectRoot: string | null
  repo: AmlRepo
  datasetsDir: string
  jobsDir: string
  modelsDir: string
  /** uv venv 落点: <root>/.venv */
  venvDir: string
  /** 项目本地 uv 二进制落点: <root>/tools */
  toolsDir: string
  /** 运行时状态(安装记录/探针缓存): <root>/runtime */
  runtimeDir: string
}

const g = globalThis as typeof globalThis & { __amlRuntime?: AmlRuntime }

/** 目录骨架说明文件(首次创建时落盘,便于人工理解 ./aml 的用途与清理方式) */
const README = `# AML 平台数据目录

本目录是 AgentWorkShop 自动建模(AML)平台的**全部资产根**,由服务自动创建与维护。

## 目录约定

| 路径 | 内容 | 可否手删 |
| --- | --- | --- |
| \`.venv/\` | uv 创建/管理的 Python 环境(依赖锁定在平台的 requirements.txt) | 可删,下次供给自动重建 |
| \`datasets/<id>/\` | 数据集实体:\`spec.json\` 取数规格、\`manifest.json\` 列定义、\`report.json\` 质量报告、\`arrays/*.f32\` 列式数组 | 先删元数据行,再删目录 |
| \`jobs/<id>/\` | 训练作业实体:\`job.json\` 提交契约、\`workspace/\`(train.py + amlkit.py)、\`run.log\`、\`artifacts/\`(产出模型) | 同上 |
| \`models/<id>/\` | 模型实体:\`model.onnx\` + \`io_spec.json\`(输入输出契约,不可变) | 同上 |
| \`runtime/\` | 平台运行时状态:uv 安装记录(\`uv.json\`)、环境探针快照(\`env.json\`) | 可删,自动重建 |
| \`tools/\` | 平台自动安装的 uv 二进制(免管理员、不改系统 PATH) | 可删,可重新一键安装 |

## 元数据与实体的关系

平台用 SQLite 四表保存**元数据**(数据集/作业/实验/模型),用本目录保存**实体**。
两者以 id 一一对应;REST 的 \`/api/workshop/aml/*\` 提供元数据 CRUD,
删除元数据时同步清理对应实体目录(有引用的数据集会被拒绝删除)。

## 迁移到别的机器

整个 \`aml/\` 目录可直接拷贝(含 \`.venv\` 与模型工件);目标机若无同版本 Python,
删掉 \`.venv/\` 让平台按本机解释器重建即可 —— 数据集与模型工件不受影响。
`

const GITIGNORE = `# AML 运行时资产:体积大且与机器绑定,不入库
.venv/
tools/
runtime/
datasets/
jobs/
models/
`

export function configureAmlRuntime(db: DatabaseSync, _dataDir?: string): AmlRuntime {
  if (g.__amlRuntime) return g.__amlRuntime
  const resolved = resolveAmlRoot({})
  const root = ensureAmlDir()
  const rt: AmlRuntime = {
    db,
    root,
    rootMode: resolved.mode,
    projectRoot: resolved.projectRoot,
    repo: createAmlRepo(db),
    datasetsDir: join(root, 'datasets'),
    jobsDir: join(root, 'jobs'),
    modelsDir: join(root, 'models'),
    venvDir: join(root, '.venv'),
    toolsDir: join(root, 'tools'),
    runtimeDir: join(root, 'runtime'),
  }
  mkdirSync(rt.venvDir, { recursive: true })
  // 目录自述与忽略规则只在缺失时写,不覆盖用户改动
  try {
    if (!existsSync(join(root, 'README.md'))) writeFileSync(join(root, 'README.md'), README)
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), GITIGNORE)
  }
  catch { /* 元信息落盘失败不阻断平台装配 */ }
  g.__amlRuntime = rt
  return rt
}

export function getAmlRuntime(): AmlRuntime {
  if (!g.__amlRuntime) {
    throw new AppError(503, 'AML_NOT_READY', 'AML 尚未初始化(workshop 插件未执行)')
  }
  return g.__amlRuntime
}

/** 数据根解析来源的中文说明(UI 展示) */
export function amlRootSourceLabel(mode: string): string {
  switch (mode) {
    case 'env': return '环境变量 AW_AML_DIR 指定'
    case 'repo': return '项目检出根(./aml)'
    case 'home': return '用户配置根(~/.AgentWorkShop/aml)'
    default: return '当前工作目录(./aml)'
  }
}

/**
 * 路径是否位于 AML 资产根内 —— 删除实体目录前的越界防护。
 * 元数据行里的 path 字段来自历史写入,不能无条件信任:它理论上可能是任意绝对路径,
 * 直接 rmSync 会造成"删一条元数据把用户别处的目录删掉"。
 */
export function isInsideAmlRoot(rt: AmlRuntime, p: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = norm(rt.root)
  const target = norm(p)
  return target === root || target.startsWith(`${root}/`)
}
