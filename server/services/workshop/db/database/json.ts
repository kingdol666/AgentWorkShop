/**
 * JSON 列读写小工具
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  }
  catch {
    return fallback
  }
}
