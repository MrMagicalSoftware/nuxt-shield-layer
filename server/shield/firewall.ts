import type { H3Event } from 'h3'
import { shieldKey } from '../../lib/ip.mjs'
import { shieldMode, shieldOptions, shieldRuntime } from './config'
import { activeBan, shieldRateLimit, shieldReady, shieldScore, waitShieldReady } from './core'
import { blockedCountry, countRejected } from './countries'
import { getClientIp, isShieldTrusted, isTrustedProxy } from './ip'
import { inspectCopying, inspectRequest, inspectResponse, isSearchBot, SHIELD_MAX_BODY_BYTES, SHIELD_SCORES, shieldRules, verifiableBotDomains } from './rules'
import { verifySearchBot } from './bot'

/**
 * Il firewall: primo middleware del sito (vedi nuxt.config.ts del layer), filtra ogni richiesta prima
 * che arrivi a pagine e API. I file statici (/_nuxt, public/) sono serviti da Nitro prima dei middleware
 * e non passano di qui.
 */
export default defineEventHandler(async (event) => {
  const mode = shieldMode()
  if (mode === 'off') return

  const ip = getClientIp(event)
  // Mai bloccare gli IP fidati o i proxy stessi (vorrebbe dire bloccare tutti i visitatori)
  if (!ip || isShieldTrusted(ip) || isTrustedProxy(ip)) return

  // Subito dopo un riavvio: prima di decidere si aspetta che i blocchi salvati siano caricati
  if (!shieldReady()) await waitShieldReady()

  const key = shieldKey(ip)
  const enforce = mode === 'block'
  const ban = activeBan(key)
  if (ban && enforce) return deny(event, 403, Math.ceil((ban.until - Date.now()) / 1000), messages().blocked)

  const method = event.method
  const url = event.node.req.originalUrl || event.node.req.url || '/'
  const path = event.path.split('?', 1)[0]!
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const ctx = { path, userAgent }

  const verdict = inspectRequest({ method, url, userAgent, referer: getRequestHeader(event, 'referer') ?? '' })
  if (verdict) {
    shieldScore(key, verdict.score, verdict.reason, ctx)
    if (enforce && verdict.status) return deny(event, verdict.status)
  }

  // Copia dei contenuti: strumenti di scraping e crawler per l'addestramento di IA
  const copying = inspectCopying(path, userAgent)
  if (copying) {
    shieldScore(key, copying.score, copying.reason, ctx)
    if (enforce) return deny(event, 403)
  }

  // Corpi enormi servono solo a saturare il server (eccezioni: allowLargeBody in configureShield)
  const options = shieldOptions()
  const length = Number(getRequestHeader(event, 'content-length') || 0)
  if (enforce && length > (options.maxBodyBytes ?? SHIELD_MAX_BODY_BYTES) && !(options.allowLargeBody && await options.allowLargeBody(event))) {
    return deny(event, 413)
  }

  // Chi si presenta come Googlebot, Bingbot... deve venire davvero dai loro IP: solo allora è esente dai
  // limiti, i travestimenti vengono respinti. I bot non verificabili (anteprime dei social...) seguono le
  // regole normali, che bastano
  let searchBot = false
  const domains = isSearchBot(userAgent) ? verifiableBotDomains(userAgent) : null
  if (domains) {
    const check = await verifySearchBot(ip, domains)
    if (check === 'fake') {
      shieldScore(key, SHIELD_SCORES.fakeBot, `finto motore di ricerca: ${userAgent.slice(0, 60)}`, ctx)
      if (enforce) return deny(event, 403)
    }
    searchBot = check === 'verified'
  }

  // Paesi bloccati dal pannello: passano comunque i motori di ricerca verificati e i percorsi esclusi
  const rules = shieldRules()
  const country = searchBot || rules.countryExempt(path) ? null : blockedCountry(event, ip)
  if (country) {
    countRejected(country)
    if (enforce) return deny(event, 403, undefined, messages().country)
  }

  const limited = searchBot ? null : shieldRateLimit(key, path, method)
  if (limited) {
    shieldScore(key, limited.rule.score, `troppe richieste (${limited.rule.name})`, ctx)
    if (enforce) return deny(event, 429, limited.retryAfter, messages().tooMany)
  }

  // Valuta l'esito: 404 ripetuti (scansione di percorsi) e login falliti
  if (searchBot) return
  event.node.res.once('finish', () => {
    const outcome = inspectResponse(path, method, event.node.res.statusCode)
    if (outcome) shieldScore(key, outcome.score, outcome.reason, ctx)
  })
})

function messages() {
  const { contact } = shieldRuntime()
  const custom = shieldOptions().messages ?? {}
  const suffix = contact ? ` Se pensi sia un errore, scrivi a ${contact}.` : ''
  return {
    blocked: custom.blocked ?? `Accesso temporaneamente bloccato per attività sospetta.${suffix}`,
    country: custom.country ?? `Il sito non è disponibile dal tuo paese.${suffix}`,
    tooMany: custom.tooMany ?? 'Troppe richieste, riprova tra poco.',
  }
}

const STATUS_TEXT: Record<number, string> = {
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
}

/** Risposta breve in testo semplice: la richiesta non arriva al sito (né al rendering delle pagine). */
function deny(event: H3Event, status: number, retryAfter?: number, message?: string) {
  setResponseStatus(event, status)
  setResponseHeaders(event, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'close',
    ...(retryAfter && retryAfter > 0 ? { 'retry-after': retryAfter } : {}),
  })
  if (message) return message
  if (status === 403) return messages().blocked
  if (status === 429) return messages().tooMany
  return STATUS_TEXT[status] ?? 'Forbidden'
}
