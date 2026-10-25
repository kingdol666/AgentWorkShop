/** Optimizer 页面 REST 封装(与 Agent 工具共用同一服务层)。 */
import { apiFetch } from '~/composables/workshop/apiClient'

type JsonInit = Omit<RequestInit, 'body'> & { body?: unknown }

function withJson(init?: JsonInit): RequestInit | undefined {
  if (!init) return undefined
  const { body, ...rest } = init
  if (body === undefined) return rest
  return {
    ...rest,
    headers: { 'content-type': 'application/json', ...(rest.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
  }
}

export const optimizerApi = <T>(path: string, init?: JsonInit) =>
  apiFetch<T>({ base: '/api/workshop', path, init: withJson(init) })

export const processModelApi = <T>(path: string, init?: JsonInit) =>
  apiFetch<T>({ base: '/api/workshop/process-model', path, init: withJson(init) })
