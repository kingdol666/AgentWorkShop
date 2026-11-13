const g = globalThis as typeof globalThis & { __awApiToken?: string }

/** 显式 API-token 登录的短生命周期凭据；浏览器 session 不写入此处。 */
export function readApiToken(): string | null {
  return g.__awApiToken ?? null
}

export function setApiToken(token: string | null): void {
  g.__awApiToken = token || undefined
}
