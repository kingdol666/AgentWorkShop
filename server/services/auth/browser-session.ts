import { randomBytes, createHash } from 'node:crypto'
import { getCookie, type H3Event } from 'h3'
import { userRepository } from '../../repositories/user.repository'
import type { User } from '../../types/user'

const SESSION_COOKIE = 'aw.session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TICKET_TTL_MS = 60_000

export interface BrowserSession {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
}

export interface WsTicket {
  ticket: string
  userId: string
  expiresAt: number
}

const tickets = new Map<string, WsTicket>()

function rawCredential(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

export function sessionCookieName(): string {
  return SESSION_COOKIE
}

export function sessionCookieOptions(secure: boolean): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: '/'
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }
}

export function issueBrowserSession(userId: string, ttlMs = SESSION_TTL_MS): { credential: string, session: BrowserSession } {
  const credential = rawCredential('bs-')
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const session = userRepository.createBrowserSession(userId, credential, createdAt, expiresAt)
  return { credential, session }
}

export function resolveBrowserSession(credential: string): (User & { sessionId: string }) | null {
  return userRepository.findByBrowserSession(credential)
}

export function resolveBrowserSessionFromEvent(event: H3Event): (User & { sessionId: string }) | null {
  const credential = getCookie(event, SESSION_COOKIE)
  return credential ? resolveBrowserSession(credential) : null
}

export function resolveBrowserSessionFromCookieHeader(header: string | undefined): (User & { sessionId: string }) | null {
  const credential = header?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1]
  return credential ? resolveBrowserSession(decodeURIComponent(credential)) : null
}

export function resolveWsTicketUser(ticket: string): User | null {
  const row = consumeWsTicket(ticket)
  if (!row) return null
  const user = userRepository.findById(row.userId)
  return user && user.status === 'active' ? user : null
}

export function revokeBrowserSession(credential: string): boolean {
  return userRepository.revokeBrowserSession(credential)
}

export function issueWsTicket(userId: string, ttlMs = TICKET_TTL_MS): WsTicket {
  const ticket = rawCredential('wt-')
  const expiresAt = Date.now() + ttlMs
  tickets.set(ticket, { ticket, userId, expiresAt })
  sweepTickets()
  return { ticket, userId, expiresAt }
}

export function consumeWsTicket(ticket: string, expectedUserId?: string): WsTicket | null {
  const row = tickets.get(ticket)
  if (!row) return null
  tickets.delete(ticket)
  if (row.expiresAt <= Date.now()) return null
  if (expectedUserId && row.userId !== expectedUserId) return null
  return row
}

function sweepTickets(): void {
  const now = Date.now()
  for (const [key, row] of tickets) {
    if (row.expiresAt <= now) tickets.delete(key)
  }
  if (tickets.size > 10_000) {
    const oldest = [...tickets.values()].sort((a, b) => a.expiresAt - b.expiresAt).slice(0, tickets.size - 10_000)
    for (const row of oldest) tickets.delete(row.ticket)
  }
}

/** Only used by tests and diagnostics; the persisted session lookup remains hash-only. */
export function credentialHash(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}
