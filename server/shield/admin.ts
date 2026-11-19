import type { H3Event } from 'h3'
import { shieldKey } from '../../lib/ip.mjs'
import type { ShieldState } from '../../shared/types'
import { shieldMode, shieldOptions } from './config'
import { listActiveBans, listTrusted, shieldStats } from './core'
import { listBlockedCountries, requestCountry } from './countries'
import { getClientIp, isShieldTrusted, isTrustedProxy } from './ip'
import { shieldAuthMode } from './auth'
import { shieldStore } from './store'

/** Funzioni comuni alle API del pannello (/api/shield). */

const PER_PAGE = 20

/** Corpo JSON della richiesta come oggetto (vuoto se manca o non è un oggetto). */
export async function readShieldBody(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readBody(event).catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

/** Testo obbligatorio o facoltativo, ripulito e con lunghezza massima; altrimenti 400 con il messaggio. */
export function bodyText(body: Record<string, unknown>, field: string, opts: { max: number, required?: string }) {
  const raw = body[field]
  const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : ''
  if (!value && opts.required) throw createError({ statusCode: 400, message: opts.required })
  if (value.length > opts.max) throw createError({ statusCode: 400, message: `Testo troppo lungo (${field}, massimo ${opts.max} caratteri)` })
  return value
}

/** L'IP di chi usa il pannello è protetto (fidato o proxy): non rischia di chiudersi fuori. */
export function adminIsProtected(event: H3Event) {
  const ip = getClientIp(event)
  return ip ? isShieldTrusted(ip) || isTrustedProxy(ip) : true
}

export const protectedCountries = () => (shieldOptions().protectedCountries ?? []).map(c => c.toUpperCase())

/** Stato dello scudo per il pannello, con gli IP bloccati paginati (ricerca per IP, motivo, percorso o user agent). */
export async function shieldState(event: H3Event, admin: string, query: { q?: string, page?: number }): Promise<ShieldState> {
  const ip = getClientIp(event)
  const search = query.q?.trim().toLowerCase()
  const page = Math.min(Math.max(Math.trunc(query.page ?? 1) || 1, 1), 100_000)
  const all = listActiveBans().filter(ban => !search || [ban.key, ban.reason, ban.lastPath, ban.userAgent].some(v => v?.toLowerCase().includes(search)))
  return {
    mode: shieldMode(),
    auth: shieldAuthMode(),
    admin,
    store: shieldStore().name,
    yourIp: ip,
    yourKey: ip ? shieldKey(ip) : null,
    protected: adminIsProtected(event),
    ...shieldStats(),
    trusted: await listTrusted().catch(() => []),
    countries: await listBlockedCountries().catch(() => []),
    yourCountry: requestCountry(event, ip),
    protectedCountries: protectedCountries(),
    total: all.length,
    page,
    perPage: PER_PAGE,
    bans: all.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(ban => ({
      ip: ban.key,
      reason: ban.reason,
      until: new Date(ban.until).toISOString(),
      count: ban.count,
      manual: ban.manual,
      path: ban.lastPath,
      userAgent: ban.userAgent,
    })),
  }
}
