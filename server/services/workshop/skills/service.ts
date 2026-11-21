/**
 * Skills 管理服务：发现、受管导入、启停、删除、受控资源读取。
 * 权限由 route 层 requireRole 决定；本服务只做数据与安全校验，不执行 Skill 内容。
 */
import { homedir } from 'node:os'
import { resolveRunMode } from '@/shared/config/home.mjs'
import { buildDefaultSkillRoots, discoverSkills, DEFAULT_SKILL_LIMITS } from './discovery'
import {
  findManagedRevision,
  importManagedRevision,
  listManagedRevisions,
  readManagedRevisionFile,
  removeManagedRevision,
  setManagedRevisionEnabled,
} from './store'
import type { SkillImportResult, SkillRecord, SkillRoot } from './types'
import { AppError } from '../../../utils/errors'

export interface SkillServiceOptions {
  configRoot?: string
  homeDir?: string
  packageRoot?: string
  env?: NodeJS.ProcessEnv
}

export interface SkillRootView {
  id: string
  path: string
  source: SkillRoot['source']
  managed: boolean
}

export function createSkillService(opts: SkillServiceOptions = {}) {
  const env = opts.env ?? process.env
  const configRoot = opts.configRoot ?? resolveRunMode({ env }).configRoot
  const home = opts.homeDir ?? homedir()
  const packageRoot = opts.packageRoot ?? env.AW_PACKAGE_ROOT ?? process.cwd()
  const roots = buildDefaultSkillRoots({ configRoot, homeDir: home, packageRoot, env })

  return {
    configRoot,
    roots(): SkillRootView[] {
      return roots.map(r => ({ id: r.id, path: r.path, source: r.source, managed: r.managed }))
    },
    discover(): Promise<SkillRecord[]> {
      return discoverSkills(roots, DEFAULT_SKILL_LIMITS)
    },
    listManaged() {
      return listManagedRevisions(configRoot)
    },
    findManaged(id: string) {
      return findManagedRevision(configRoot, id)
    },
    async importFromCatalog(catalogId: string, actorId: string): Promise<SkillImportResult> {
      const record = (await discoverSkills(roots, DEFAULT_SKILL_LIMITS)).find(x => x.id === catalogId)
      if (!record) throw new AppError(404, 'NOT_FOUND', '发现目录中不存在该 Skill，请刷新后重试')
      return importManagedRevision({ configRoot, record, actorId })
    },
    setEnabled(id: string, enabled: boolean, actorId: string) {
      return setManagedRevisionEnabled(configRoot, id, enabled, actorId)
    },
    remove(id: string) {
      removeManagedRevision(configRoot, id)
    },
    readFile(id: string, relativePath: string): string {
      return readManagedRevisionFile(configRoot, id, relativePath)
    },
  }
}

export type SkillService = ReturnType<typeof createSkillService>
