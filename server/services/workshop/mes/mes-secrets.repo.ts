/**
 * MES 运行时凭据仓(secretRef → token)。
 *
 * 存在理由:mes-rest 的 secretRef 原先只有 env(AW_MES_<REF>_TOKEN)一条配置路径,
 * 换凭据必须重启进程并改环境;运行时设置 mes.secret.<ref> 又是自由键,未注册
 * schema 描述符 → loadEffective 通常取不到值(见 mes-rest resolveMesSecret 的 TODO)。
 *
 * 零明文原则:
 *  - 源码/示例/测试不写凭据字面量;凭据只落运行时数据目录(server/data/mes-secrets.json),
 *    与 daqs/recipes 等同属运行数据,不进版本库;
 *  - listRefs 只回引用名与更新时间,任何管理面/日志都不回 value;
 *  - 解析顺序 env > 本仓 > runtime settings(env 永远最高,便于运维应急覆盖)。
 */
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

export interface MesSecretEntry {
  updatedAt: string
  updatedBy: string
}

interface SecretRow extends MesSecretEntry {
  value: string
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 引用名合法性:非空、≤64、仅字母数字与 ._-;拒绝路径分隔符/空白/控制字符 */
export function isValidSecretRef(ref: string): boolean {
  return REF_RE.test(ref)
}

class MesSecretsRepo {
  private readonly file: string
  private data: Record<string, SecretRow>

  constructor(file?: string) {
    this.file = file ?? join(ensureDataDir(), 'mes-secrets.json')
    this.data = this.load()
  }

  private load(): Record<string, SecretRow> {
    const parsed = loadJsonFile(this.file, {}) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, SecretRow> = {}
    for (const [ref, row] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isValidSecretRef(ref)) continue
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const value = typeof r.value === 'string' ? r.value : ''
      if (!value) continue
      out[ref] = {
        value,
        updatedAt: String(r.updatedAt ?? ''),
        updatedBy: String(r.updatedBy ?? ''),
      }
    }
    return out
  }

  private flush(): void {
    saveJsonFileAtomic(this.file, this.data)
  }

  /** 读取凭据原文(只给请求构造路径用;永不入日志/响应) */
  getSecret(ref: string): string | null {
    const name = String(ref ?? '').trim()
    if (!isValidSecretRef(name)) return null
    return this.data[name]?.value ?? null
  }

  setSecret(ref: string, value: string, by: string): MesSecretEntry {
    const name = String(ref ?? '').trim()
    if (!isValidSecretRef(name)) throw new Error('凭据引用名非法(1~64 位字母数字与 ._-)')
    const v = String(value ?? '')
    if (v.trim() === '') throw new Error('凭据值不能为空')
    const entry: SecretRow = { value: v, updatedAt: new Date().toISOString(), updatedBy: String(by ?? '') }
    this.data[name] = entry
    this.flush()
    return { updatedAt: entry.updatedAt, updatedBy: entry.updatedBy }
  }

  /** 列引用名(无 value) */
  listRefs(): Array<{ ref: string } & MesSecretEntry> {
    return Object.entries(this.data)
      .map(([ref, row]) => ({ ref, updatedAt: row.updatedAt, updatedBy: row.updatedBy }))
      .sort((a, b) => a.ref.localeCompare(b.ref))
  }

  deleteSecret(ref: string): boolean {
    const name = String(ref ?? '').trim()
    if (!isValidSecretRef(name) || !(name in this.data)) return false
    const next: Record<string, SecretRow> = {}
    for (const [k, v] of Object.entries(this.data)) {
      if (k !== name) next[k] = v
    }
    this.data = next
    this.flush()
    return true
  }

  /** 测试/诊断:仓内引用数(不暴露值) */
  size(): number {
    return Object.keys(this.data).length
  }
}

let singleton: MesSecretsRepo | null = null

export function getMesSecretsRepo(): MesSecretsRepo {
  if (!singleton) singleton = new MesSecretsRepo()
  return singleton
}

/** 单测入口:构造独立文件实例,不污染进程单例 */
export function createMesSecretsRepo(file: string): MesSecretsRepo {
  return new MesSecretsRepo(file)
}
