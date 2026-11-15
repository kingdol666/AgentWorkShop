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
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** nitropack 2.13.4 写入的 import.meta.url 占位兜底 */
const PLACEHOLDER = 'globalThis._importMeta_||{url:"file:///_entry.js",env:process.env}'
const PATCHED = 'globalThis._importMeta_||{url:import.meta.url,env:process.env}'

/** 需要打补丁的 chunk(相对 .output/server/chunks) */
const PATCH_TARGETS = [
  ['_', 'nitro.mjs'],
  ['virtual', 'entry.mjs'],
]

/**
 * 产物完整性:入口 + 全部外置运行时资产都在。
 * `aw start` 用它判断能否跳过构建 —— 只看 index.mjs 会在"上次构建失败留下半产物"时
 * 直接启动一个缺 prompts/schema/aml-python 的实例(运行期才炸)。
 */
export function outputAssetsReady(root) {
  const asDir = join(root, '.output', '.AgentWorkShop')
  return existsSync(join(root, '.output', 'server', 'index.mjs'))
    && existsSync(join(asDir, 'prompts'))
    && existsSync(join(asDir, 'schema.json'))
    && existsSync(join(asDir, 'aml-python'))
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
  const ship = (src, dest, label, { recursive = false } = {}) => {
    if (!existsSync(src)) throw new Error(`[build] 必需运行时资产缺失:${label}(${src})`)
    if (recursive) cpSync(src, dest, { recursive: true, force: true })
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
  ship(
    join(root, 'server', 'services', 'workshop', 'aml', 'python'),
    join(asDir, 'aml-python'),
    'aml-python',
    { recursive: true },
  )

  if (unresolved.length > 0) {
    throw new Error(
      `[build] import-meta 占位符补丁未能生效:${unresolved.join(', ')} —— `
      + '产物启动会抛 ERR_INVALID_FILE_URL_PATH。请检查 .output 是否被其他进程占用或只读。',
    )
  }
  return { patched, alreadyOk, missing, assets }
}
