/**
 * 状态文件路径 / 启停集合读写 / 插件目录发现
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { modePaths } from './config.mjs'

export function statePathFor(homeDir) {
  return join(homeDir, 'plugins-state.json')
}

export function readDisabledSet(homeDir) {
  try {
    const j = JSON.parse(readFileSync(statePathFor(homeDir), 'utf8'))
    return new Set(Array.isArray(j.disabled) ? j.disabled : [])
  }
  catch {
    return new Set()
  }
}

export function writeDisabledSet(homeDir, disabled) {
  const p = statePathFor(homeDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: [...disabled] }, null, 2)}\n`, 'utf8')
  renameSync(tmp, p)
}

/** 发现插件入口,三作用域。**同名 builtin 优先**(先扫先占,`seen` 去重),
 *  即优先级 builtin > project > user —— 与 CLI 指令注册表(cli/core/registry.mjs,
 *  后扫覆盖 → project > user > builtin)方向相反,勿照搬。
 *  实现见下方循环顺序 [builtin, project, user] + `if (seen.has(name)) continue`。 */
export function discoverPluginDirs(cwd = process.cwd()) {
  const { builtinDir, projectDir, userDir } = modePaths(cwd)
  const out = []
  const seen = new Set()
  for (const [dir, scope] of [[builtinDir, 'builtin'], [projectDir, 'project'], [userDir, 'user']]) {
    if (!dir || !existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name)
      if (!existsSync(join(sub, 'index.mjs'))) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ dir: sub, scope })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * 装载插件宿主(idempotent;nitro 启动期调用一次)。
 */
