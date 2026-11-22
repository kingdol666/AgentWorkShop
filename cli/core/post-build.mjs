// ============================================================
// 构建产物后处理 —— nuxt build 完成**之后**必须做的事
// ------------------------------------------------------------
// 为什么要有这一步(而不是全塞进 nuxt.config 的 compiled 钩子):
//   `compiled` 钩子与 nitro 的 chunk 落盘存在竞态 —— 实测出现过 nitro.mjs /
//   virtual/entry.mjs 在钩子跑完之后才被写回,补丁静默失效。失效的后果很重:
//   `globalThis._importMeta_.url` 保持占位符 "file:///_entry.js",任何模块级
//   fileURLToPath(import.meta.url) 在启动瞬间抛 ERR_INVALID_FILE_URL_PATH,
//   整进程起不来(且报错指向内部 URL 代码,很难定位到构建期)。
//   因此这里在 nuxt build **返回之后**再做一遍,并且**校验失败即报错**,
//   把"静默失效"变成"构建失败"。
//
// 三件事:
//   ① import-meta 占位符补丁(必须命中,否则产物不可启动)
//   ② 随产物分发的外置资产:prompts / schema.json / AML python 资产
//      (运行时经 fs 读取,nitro 不会打包它们)
//   ③ 结果汇报(便于 CI 与排障)
// ============================================================
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** nitropack 2.13.4 写入的 import.meta.url 占位兜底 */
const PLACEHOLDER = 'globalThis._importMeta_||{url:"file:///_entry.js",env:process.env}'
const PATCHED = 'globalThis._importMeta_||{url:import.meta.url,env:process.env}'

/** 需要打补丁的 chunk(相对 .output/server/chunks) */
const PATCH_TARGETS = [
  ['_', 'nitro.mjs'],
  ['virtual', 'entry.mjs'],
]

const AML_PY_FILES = ['amlkit.py', 'aml_eval.py', 'requirements.txt', 'train-example.py', 'train-hybrid-example.py']
const OPTIMIZER_PY_FILES = ['worker.py', 'problems.py', 'probe.py']

/** Worker 源码/产物均必须含有完整协议实现,不能只依赖目录存在。 */
function optimizerAssetsReady(dir) {
  return OPTIMIZER_PY_FILES.every(file => existsSync(join(dir, file)))
}

/**
 * 产物完整性:入口 + 全部外置运行时资产都在。
 * `aw start` 用它判断能否跳过构建 —— 缺少 Python worker 时必须在启动前失败。
 */
export function outputAssetsReady(root) {
  const asDir = join(root, '.output', '.AgentWorkShop')
  return existsSync(join(root, '.output', 'server', 'index.mjs'))
    && existsSync(join(asDir, 'prompts', 'host-tools.json'))
    && existsSync(join(asDir, 'schema.json'))
    && AML_PY_FILES.every(file => existsSync(join(asDir, 'aml-python', file)))
    && optimizerAssetsReady(join(asDir, 'optimizer-python'))
    && existsSync(join(root, '.output', 'skills'))
}

/**
 * 执行全部后处理。
 * @param {string} root 项目根(nuxt build 的 cwd)
 * @returns {{ patched: string[], alreadyOk: string[], missing: string[], assets: string[] }}
 * @throws {Error} import-meta 占位符仍残留在**已生成**的 chunk 里时抛错(产物不可启动)
 */
export function postBuildArtifacts(root) {
  const outputRoot = join(root, '.output')
  const chunks = join(outputRoot, 'server', 'chunks')
  const patched = []
  const alreadyOk = []
  const missing = []
  const unresolved = []

  for (const parts of PATCH_TARGETS) {
    const file = join(chunks, ...parts)
    const rel = parts.join('/')
    if (!existsSync(file)) {
      missing.push(rel)
      continue
    }
    const src = readFileSync(file, 'utf8')
    if (!src.includes(PLACEHOLDER)) {
      // 要么本就没有占位符(nitro 版本变更),要么已被 compiled 钩子修好
      alreadyOk.push(rel)
      continue
    }
    writeFileSync(file, src.replaceAll(PLACEHOLDER, PATCHED))
    // 复读校验:确认真的落盘(防写入失败静默通过)
    const after = readFileSync(file, 'utf8')
    if (after.includes(PLACEHOLDER)) unresolved.push(rel)
    else patched.push(rel)
  }

  // 外置资产随产物分发(运行时 fs 读取;缺了它们不是启动失败而是运行期才炸)
  const assets = []
  const ship = (src, dest, label, { recursive = false, filter = undefined } = {}) => {
    if (!existsSync(src)) throw new Error(`[build] 必需运行时资产缺失:${label}(${src})`)
    if (recursive) cpSync(src, dest, { recursive: true, force: true, filter })
    else {
      mkdirSync(join(dest, '..'), { recursive: true })
      copyFileSync(src, dest)
    }
    if (!existsSync(dest)) throw new Error(`[build] 必需运行时资产复制后不存在:${label}(${dest})`)
    assets.push(label)
  }
  const asDir = join(outputRoot, '.AgentWorkShop')
  mkdirSync(asDir, { recursive: true })
  ship(join(root, '.AgentWorkShop', 'prompts'), join(asDir, 'prompts'), 'prompts', { recursive: true })
  ship(join(root, 'shared', 'config', 'schema.json'), join(asDir, 'schema.json'), 'schema.json')
  const copyPythonAssets = (sourceParts, name, required) => {
    const src = join(root, 'server', 'services', 'workshop', ...sourceParts, 'python')
    const dest = join(asDir, name)
    for (const file of required) {
      if (!existsSync(join(src, file))) throw new Error(`[build] ${name} 资产缺少 ${file}`)
    }
    ship(src, dest, name, {
      recursive: true,
      filter: entry => !entry.includes('__pycache__') && !entry.includes('.mimosa'),
    })
  }
  copyPythonAssets(['aml'], 'aml-python', AML_PY_FILES)
  copyPythonAssets(['optimization'], 'optimizer-python', OPTIMIZER_PY_FILES)
  // 内置 Agent Skills：源码/安装包根目录与 standalone .output 都可发现
  ship(join(root, 'skills'), join(outputRoot, 'skills'), 'skills', { recursive: true })
  // Nitro 在混合依赖(zod 3 直依赖 + 传递 zod 4)时可能把传递版本复制到产物根，
  // 而应用代码按 zod 3 的入口导入；用直依赖覆盖产物根，传递依赖的嵌套副本保持不变。
  const directZod = join(root, 'node_modules', 'zod')
  const outputZod = join(outputRoot, 'server', 'node_modules', 'zod')
  if (existsSync(join(directZod, 'index.js')) && existsSync(outputZod)) {
    rmSync(outputZod, { recursive: true, force: true })
    cpSync(directZod, outputZod, { recursive: true, force: true, dereference: true })
    assets.push('zod-direct')
  }

  if (unresolved.length > 0) {
    throw new Error(
      `[build] import-meta 占位符补丁未能生效:${unresolved.join(', ')} —— `
      + '产物启动会抛 ERR_INVALID_FILE_URL_PATH。请检查 .output 是否被其他进程占用或只读。',
    )
  }
  return { patched, alreadyOk, missing, assets }
}
