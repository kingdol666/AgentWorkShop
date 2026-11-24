// One HTTPS hop. Protocol policy (including redirects) lives in update.mjs.
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { assertPublicHost, isPublicAddress, validateUpdateUrl } from './update.mjs'
import { isManualProxyConfig, normalizeManualProxy } from './chrome/contract.mjs'

export function manualProxyRules(raw) {
  if (!isManualProxyConfig(raw)) throw new Error('invalid manual proxy configuration')
  const proxy = normalizeManualProxy(raw)
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  const endpoint = `${host}:${proxy.port}`
  // A single fixed proxy URI applies to the HTTPS-only GitHub update channel.
  // No credentials or bypass rules are accepted here.
  return `${proxy.protocol}://${endpoint}`
}

export function transportError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return error
  const code = /^\w{1,64}$/.test(error?.code ?? '')
    ? error.code
    : /\b(ERR_[A-Z0-9_]{1,60})\b/.exec(String(error?.message ?? ''))?.[1] ?? 'UPDATE_NETWORK'
  return Object.assign(new Error(`update network request failed (${code})`), { code })
}

function responseHeaders(raw) {
  const headers = new Headers()
  for (const [name, values] of Object.entries(raw ?? {})) {
    for (const value of Array.isArray(values) ? values : [values]) {
      if (value != null) headers.append(name, String(value))
    }
  }
  return headers
}

function safeHeaders(raw) {
  return Object.fromEntries([...new Headers(raw)].filter(([name]) =>
    !/^(?:host|cookie|authorization|proxy-authorization)$/i.test(name)))
}

function singleHop(start, { signal, method = 'GET' } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let stop
    let bodyAbort
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const fail = (error) => {
      const failure = signal?.aborted ? signal.reason : transportError(error)
      cleanup()
      if (settled) bodyAbort?.(failure)
      else {
        settled = true
        reject(failure)
      }
    }
    const onAbort = () => {
      fail(signal.reason)
      stop?.()
    }
    const finish = (incoming) => {
      if (settled) return
      try {
        const status = incoming.statusCode
        const noBody = method === 'HEAD' || [204, 205, 304].includes(status)
        let body = null
        if (noBody) {
          cleanup()
          incoming.resume()
        }
        else {
          const reader = Readable.toWeb(incoming, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          }).getReader()
          body = new ReadableStream({
            start(controller) {
              bodyAbort = (error) => {
                bodyAbort = undefined
                controller.error(error)
                void reader.cancel().catch(() => {})
              }
            },
            async pull(controller) {
              try {
                const { done, value } = await reader.read()
                if (!bodyAbort) return
                if (done) {
                  bodyAbort = undefined
                  cleanup()
                  controller.close()
                }
                else controller.enqueue(value)
              }
              catch (error) {
                fail(error)
              }
            },
            cancel() {
              bodyAbort = undefined
              cleanup()
              stop?.()
              return reader.cancel().catch(() => {})
            },
          })
        }
        const response = new Response(body, { status, headers: responseHeaders(incoming.headers) })
        settled = true
        resolve(response)
      }
      catch (error) {
        fail(error)
        stop?.()
      }
    }
    const redirect = (status, target) => {
      if (settled) return
      try {
        const response = new Response(null, { status, headers: { location: target } })
        settled = true
        cleanup()
        resolve(response)
        stop?.()
      }
      catch (error) {
        fail(error)
        stop?.()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const setStop = (callback) => {
        stop = callback
      }
      start({ finish, fail, redirect, setStop })
    }
    catch (error) {
      fail(error)
    }
  })
}

/** The caller supplies the dedicated in-memory Electron session configured in system mode. */
export function createSystemUpdateTransport({ net, session } = {}) {
  if (!net?.request || !session) throw new Error('Electron net and isolated update session are required')
  return {
    fetchImpl(rawUrl, init = {}) {
      const url = validateUpdateUrl(rawUrl)
      return singleHop(({ finish, fail, redirect, setStop }) => {
        const request = net.request({
          url: url.href,
          method: init.method ?? 'GET',
          session,
          redirect: 'manual',
          useSessionCookies: false,
          cache: 'no-store',
        })
        request.on('error', fail)
        request.on('login', (authInfo, callback) => {
          // Never supply credentials or prompt. System-managed authentication
          // may succeed before Chromium asks the application for credentials.
          fail(Object.assign(new Error('authentication required'), {
            code: authInfo.isProxy ? 'ERR_PROXY_AUTH_REQUESTED' : 'ERR_UPDATE_AUTH_REQUESTED',
          }))
          callback()
          request.abort()
        })
        request.on('response', finish)
        request.on('redirect', (status, _method, target) => redirect(status, target))
        for (const [name, value] of Object.entries(safeHeaders(init.headers))) request.setHeader(name, value)
        setStop(() => request.abort())
        request.end()
      }, init)
    },
  }
}

/** Pin this request to an already-validated DNS answer, without changing Host or TLS identity. */
export async function pinnedFetch(rawUrl, init = {}) {
  const url = validateUpdateUrl(rawUrl)
  const answers = init.addresses ?? await assertPublicHost(url.hostname)
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
    throw new Error('update host resolved to a non-public address')
  }
  const address = answers[0].address
  const family = isIP(address)
  return singleHop(({ finish, fail, setStop }) => {
    const request = (init.httpsRequestImpl ?? httpsRequest)(url, {
      method: init.method ?? 'GET',
      headers: safeHeaders(init.headers),
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address, family }])
        : callback(null, address, family),
    }, finish)
    request.on('error', fail)
    setStop(() => request.destroy())
    request.end()
  }, init)
}
