import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { shieldOptions, shieldRuntime } from './config'
import { getClientIp } from './ip'

/**
 * Accesso al pannello e alle API /api/shield.
 *
 *  - custom:   il progetto decide con authorize() in configureShield() (es. il suo ruolo di amministratore);
 *  - password: si entra con NUXT_SHIELD_ADMIN_PASSWORD (cookie di sessione firmato, HttpOnly, SameSite=Strict);
 *  - none:     nessuno dei due è configurato, il pannello resta chiuso.
 */
export type ShieldAuthMode = 'custom' | 'password' | 'none'

const COOKIE = 'nuxt_shield_session'

export function shieldAuthMode(): ShieldAuthMode {
  if (shieldOptions().authorize) return 'custom'
  return shieldRuntime().adminPassword ? 'password' : 'none'
}

let temporarySecret: string | undefined

function sessionSecret() {
  const secret = shieldRuntime().sessionSecret
  if (secret) return secret
  if (!temporarySecret) {
    temporarySecret = randomBytes(32).toString('hex')
    console.warn('[shield] NUXT_SHIELD_SESSION_SECRET non impostata: uso una chiave temporanea, le sessioni del pannello scadono al riavvio.')
  }
  return temporarySecret
}

const sign = (payload: string) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url')

/** Confronto a tempo costante, anche con lunghezze diverse. */
function safeEqual(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

function validSession(token: string | undefined) {
  if (!token) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof data.exp === 'number' && data.exp > Date.now()
  }
  catch {
    return false
  }
}

function adminName(result: unknown): string | null {
  if (!result) return null
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    for (const field of ['email', 'name', 'username', 'id']) {
      if (r[field] !== undefined && r[field] !== null && r[field] !== '') return String(r[field])
    }
  }
  return 'admin'
}

/** Nome dell'amministratore che fa la richiesta; altrimenti lancia 401 (o 403 se il pannello è chiuso). */
export async function requireShieldAdmin(event: H3Event): Promise<string> {
  const { authorize } = shieldOptions()
  if (authorize) {
    const name = adminName(await authorize(event))
    if (!name) throw createError({ statusCode: 401, message: 'Accesso riservato agli amministratori' })
    return name
  }
  if (!shieldRuntime().adminPassword) {
    throw createError({ statusCode: 403, message: 'Pannello non configurato: imposta NUXT_SHIELD_ADMIN_PASSWORD oppure authorize in configureShield()' })
  }
  if (!validSession(getCookie(event, COOKIE))) {
    throw createError({ statusCode: 401, message: 'Accedi con la password del pannello', data: { login: true } })
  }
  return 'admin'
}

// --- Login con password -----------------------------------------------------------------------------

const MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60_000
const attempts = new Map<string, { count: number, resetAt: number }>()

/** Al massimo 10 password sbagliate ogni 15 minuti per IP, anche in modalità monitor. */
export function assertShieldLoginAllowed(event: H3Event) {
  const entry = attempts.get(getClientIp(event) ?? 'sconosciuto')
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_ATTEMPTS) {
    throw createError({ statusCode: 429, message: `Troppi tentativi. Riprova tra ${Math.ceil((entry.resetAt - Date.now()) / 60_000)} minuti.` })
  }
}

export function checkShieldPassword(event: H3Event, input: unknown) {
  const password = shieldRuntime().adminPassword
  const ok = !!password && typeof input === 'string' && !!input && safeEqual(input, password)
  const key = getClientIp(event) ?? 'sconosciuto'
  const now = Date.now()
  if (ok) {
    attempts.delete(key)
    return true
  }
  const entry = attempts.get(key)
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
  else entry.count++
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k)
  }
  return false
}

export function startShieldSession(event: H3Event) {
  const maxAge = Math.round(shieldRuntime().sessionHours * 3600)
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + maxAge * 1000 })).toString('base64url')
  setCookie(event, COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'strict',
    // "secure" solo in https (anche dietro un proxy): con un valore fisso il login non funzionerebbe in http locale
    secure: getRequestProtocol(event, { xForwardedProto: true }) === 'https',
    path: '/',
    maxAge,
  })
}

export function endShieldSession(event: H3Event) {
  deleteCookie(event, COOKIE, { path: '/' })
}
