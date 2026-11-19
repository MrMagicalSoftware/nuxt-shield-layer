import { BlockList, isIP } from 'node:net'
import type { H3Event } from 'h3'
import { parseShieldKey, shieldKey } from '../../lib/ip.mjs'
import type { StoredBan, TrustedAddress } from '../../lib/types.mjs'
import { shieldMode } from './config'
import { syncCountries } from './countries'
import { getClientIp, setTrustedAddresses } from './ip'
import { SHIELD_BAN_STEPS_MIN, SHIELD_DECAY_MS, SHIELD_SCORES, SHIELD_SEVERE_MIN_MIN, SHIELD_THRESHOLD, shieldRules } from './rules'
import { readyShieldStore } from './store'

/**
 * Punteggi e blocchi. Ogni IP accumula punti per i comportamenti sospetti, che calano col tempo;
 * oltre la soglia l'IP viene bloccato, con durata crescente a ogni recidiva.
 *
 * Lo stato vive in memoria (veloce, nessuna lettura dell'archivio per richiesta). I blocchi vengono
 * salvati nell'archivio, così sopravvivono ai riavvii e valgono per tutte le istanze; ogni minuto la
 * memoria si riallinea. Se l'archivio non risponde, lo scudo continua a funzionare in memoria.
 */

export type ShieldBan = StoredBan

interface Offender {
  score: number
  scoredAt: number
  /** Contatori dei limiti di frequenza: nome -> [inizio finestra, richieste]. */
  windows: Record<string, [number, number]>
  ban?: ShieldBan
  /** Numero di blocchi precedenti (ultimi 30 giorni), per la durata crescente. */
  history: number
  /** Il blocco corrente è stato scritto nell'archivio. */
  persisted: boolean
  seenAt: number
}

const MAX_TRACKED = 50_000
const RETENTION_DAYS = 30
const PERMANENT_MIN = 10 * 365 * 24 * 60
const offenders = new Map<string, Offender>()

function offender(key: string, now = Date.now()) {
  let entry = offenders.get(key)
  if (!entry) {
    if (offenders.size >= MAX_TRACKED) pruneOffenders(now, true)
    entry = { score: 0, scoredAt: now, windows: {}, history: 0, persisted: false, seenAt: now }
    offenders.set(key, entry)
  }
  entry.seenAt = now
  return entry
}

/** Blocco attivo per la chiave (IPv4 o rete IPv6 /64), se c'è. */
export function activeBan(key: string, now = Date.now()) {
  const ban = offenders.get(key)?.ban
  return ban && ban.until > now ? ban : undefined
}

/**
 * Aggiunge punti alla chiave. Restituisce il blocco se la soglia viene superata (in modalità monitor
 * il blocco viene solo scritto nel log).
 */
export function shieldScore(key: string, points: number, reason: string, ctx: { path?: string, userAgent?: string } = {}) {
  const now = Date.now()
  const entry = offender(key, now)
  if (activeBan(key, now)) return entry.ban
  entry.score = Math.max(0, entry.score - (now - entry.scoredAt) / SHIELD_DECAY_MS) + points
  entry.scoredAt = now
  if (entry.score < SHIELD_THRESHOLD) return undefined

  const severe = points >= SHIELD_SCORES.severe
  const step = SHIELD_BAN_STEPS_MIN[Math.min(entry.history, SHIELD_BAN_STEPS_MIN.length - 1)]!
  const minutes = severe ? Math.max(step, SHIELD_SEVERE_MIN_MIN) : step
  entry.score = 0

  if (shieldMode() === 'monitor') {
    console.warn(`[shield] (monitor) bloccherei ${key} per ${minutes} min: ${reason}`)
    return undefined
  }
  return banKey(key, { minutes, reason, manual: false, path: ctx.path, userAgent: ctx.userAgent })
}

/**
 * Punti all'IP della richiesta, per le regole del progetto (es. troppe letture di contenuti a pagamento).
 * Con 100 punti l'IP viene bloccato; i punti calano di 6 al minuto. Non fa nulla per gli IP fidati.
 */
export function shieldPenalize(event: H3Event, points: number, reason: string) {
  const ip = getClientIp(event)
  if (!ip) return undefined
  return shieldScore(shieldKey(ip), points, reason, {
    path: event.path.split('?', 1)[0],
    userAgent: getRequestHeader(event, 'user-agent') ?? '',
  })
}

/**
 * Limite di frequenza a finestra fissa di un minuto. Se è superato restituisce la regola e i secondi
 * da attendere, altrimenti null.
 */
export function shieldRateLimit(key: string, path: string, method: string) {
  const now = Date.now()
  const entry = offender(key, now)
  for (const rule of shieldRules().rateLimits) {
    if (!rule.match(path, method)) continue
    const window = entry.windows[rule.name]
    if (!window || now - window[0] >= 60_000) {
      entry.windows[rule.name] = [now, 1]
      continue
    }
    window[1]++
    if (window[1] > rule.limit) return { retryAfter: Math.ceil((window[0] + 60_000 - now) / 1000), rule }
  }
  return null
}

export function banKey(key: string, opts: { minutes: number, reason: string, manual: boolean, path?: string, userAgent?: string }) {
  const now = Date.now()
  const entry = offender(key, now)
  entry.history++
  const ban: ShieldBan = {
    key,
    reason: opts.reason.slice(0, 255),
    until: Math.max(activeBan(key, now)?.until ?? 0, now + opts.minutes * 60_000),
    count: entry.history,
    manual: opts.manual,
    lastPath: opts.path?.slice(0, 255) ?? null,
    userAgent: opts.userAgent?.slice(0, 255) ?? null,
  }
  entry.ban = ban
  entry.persisted = false
  console.warn(`[shield] bloccato ${key} per ${opts.minutes} min (blocco n. ${entry.history}): ${opts.reason}`)
  // Scrittura asincrona: la richiesta non aspetta l'archivio
  void persistBan(ban).then((ok) => {
    if (ok && entry.ban === ban) entry.persisted = true
  })
  return ban
}

/** Sblocca la chiave e ne azzera la storia (falso positivo). */
export async function unbanKey(key: string) {
  offenders.delete(key)
  try {
    await (await readyShieldStore()).deleteBan(key)
  }
  catch (error) {
    console.error('[shield] sblocco non salvato nell\'archivio:', (error as Error).message)
  }
}

/** Blocca un IP (o una rete IPv6 /64) dal codice del progetto. hours = 0: permanente. */
export function shieldBan(ip: string, opts: { hours?: number, reason?: string } = {}) {
  const key = parseShieldKey(ip)
  if (!key) throw new Error(`indirizzo IP non valido: ${ip}`)
  const hours = opts.hours ?? 24
  return banKey(key, { minutes: hours === 0 ? PERMANENT_MIN : hours * 60, reason: opts.reason ?? 'manuale', manual: true })
}

/** Sblocca un IP (o una rete IPv6 /64) dal codice del progetto. */
export async function shieldUnban(ip: string) {
  const key = parseShieldKey(ip)
  if (!key) throw new Error(`indirizzo IP non valido: ${ip}`)
  await unbanKey(key)
}

/** Blocco attivo dell'IP, se c'è. */
export function shieldActiveBan(ip: string) {
  const key = parseShieldKey(ip)
  return key ? activeBan(key) : undefined
}

export const PERMANENT_BAN_MINUTES = PERMANENT_MIN

export function listActiveBans(now = Date.now()) {
  const bans: ShieldBan[] = []
  for (const entry of offenders.values()) {
    if (entry.ban && entry.ban.until > now) bans.push(entry.ban)
  }
  return bans.sort((a, b) => b.until - a.until)
}

export function shieldStats() {
  return { tracked: offenders.size, banned: listActiveBans().length }
}

async function persistBan(ban: ShieldBan) {
  try {
    await (await readyShieldStore()).saveBan(ban)
    return true
  }
  catch (error) {
    console.error('[shield] blocco non salvato nell\'archivio:', (error as Error).message)
    return false
  }
}

// --- IP fidati (mai bloccati), gestiti dal pannello ------------------------------------------------

export async function listTrusted(): Promise<TrustedAddress[]> {
  return (await readyShieldStore()).listTrusted()
}

/** Rilegge gli IP fidati dall'archivio e li applica subito. */
export async function reloadTrusted() {
  const list = await listTrusted()
  setTrustedAddresses(list.map(t => t.address))
  return list
}

/** Aggiunge un IP o una rete ai fidati e toglie i blocchi che ricadono lì dentro. */
export async function addTrusted(address: string, note: string | null, createdBy: string | null) {
  await (await readyShieldStore()).saveTrusted({ address, note, createdBy, createdAt: new Date().toISOString() })
  await reloadTrusted()
  const network = new BlockList()
  const [ip, bits] = address.split('/') as [string, string | undefined]
  const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4'
  if (bits === undefined) network.addAddress(ip, type)
  else network.addSubnet(ip, Number(bits), type)
  for (const ban of listActiveBans()) {
    const v6 = ban.key.endsWith('/64')
    const keyIp = v6 ? ban.key.replace('/64', '') : ban.key
    const inside = v6
      ? type === 'ipv6' && (bits === undefined ? shieldKey(ip) === ban.key : Number(bits) <= 64 && network.check(keyIp, 'ipv6'))
      : type === 'ipv4' && network.check(keyIp, 'ipv4')
    if (inside) await unbanKey(ban.key)
  }
}

export async function removeTrusted(address: string) {
  await (await readyShieldStore()).deleteTrusted(address)
  await reloadTrusted()
}

// --- Allineamento con l'archivio ----------------------------------------------------------------------

let ready = false
let markReady: () => void = () => {}
const readyPromise = new Promise<void>((resolve) => {
  markReady = () => {
    ready = true
    resolve()
  }
})

/** Il primo allineamento con l'archivio è finito (riuscito o no). */
export const shieldReady = () => ready

/** Attende il primo allineamento, al massimo `ms`: subito dopo un riavvio gli IP bloccati non devono passare. */
export function waitShieldReady(ms = 3000) {
  if (ready) return Promise.resolve()
  return Promise.race([readyPromise, new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })])
}

/**
 * Allinea la memoria all'archivio (all'avvio e ogni minuto): carica blocchi e storico, anche quelli
 * creati da altre istanze o dalla riga di comando, e toglie quelli revocati altrove. Cancella i blocchi
 * scaduti da oltre 30 giorni (gli IP sono dati personali).
 */
export async function syncShield() {
  try {
    return await loadFromStore()
  }
  finally {
    markReady()
  }
}

async function loadFromStore() {
  const store = await readyShieldStore()
  const now = Date.now()
  // Un problema con fidati o paesi non deve impedire di caricare i blocchi
  await reloadTrusted().catch(e => console.error('[shield] IP fidati non caricati:', (e as Error).message))
  await syncCountries().catch(e => console.error('[shield] paesi bloccati non caricati:', (e as Error).message))
  await store.purgeBans(now - RETENTION_DAYS * 86_400_000)
  const rows = await store.listBans()

  const inStore = new Set<string>()
  for (const row of rows) {
    inStore.add(row.key)
    const entry = offenders.get(row.key) ?? offender(row.key, now)
    entry.history = Math.max(entry.history, row.count)
    if (row.until > now && (!entry.ban || entry.ban.until < row.until)) {
      entry.ban = { ...row }
      entry.persisted = true
    }
    else if (row.until <= now && entry.persisted && entry.ban && entry.ban.until > now) {
      // Accorciato altrove (es. sbloccato da un'altra istanza)
      entry.ban = undefined
    }
  }
  // Blocchi già salvati ma non più nell'archivio: revocati altrove
  for (const [key, entry] of offenders) {
    if (entry.persisted && !inStore.has(key)) offenders.delete(key)
  }
  return { loaded: rows.length, active: rows.filter(r => r.until > now).length, store: store.name }
}

/** Libera memoria: dimentica gli IP inattivi senza punteggio né blocchi. */
export function pruneOffenders(now = Date.now(), aggressive = false) {
  const idle = aggressive ? 60_000 : 10 * 60_000
  for (const [key, entry] of offenders) {
    const banned = entry.ban && entry.ban.until > now
    const score = entry.score - (now - entry.scoredAt) / SHIELD_DECAY_MS
    if (!banned && score <= 0 && entry.history === 0 && now - entry.seenAt > idle) offenders.delete(key)
  }
  // Ultima difesa contro un flood di IP diversi: si tengono comunque i blocchi
  if (offenders.size >= MAX_TRACKED) {
    for (const [key, entry] of offenders) {
      if (!(entry.ban && entry.ban.until > now)) offenders.delete(key)
      if (offenders.size < MAX_TRACKED * 0.8) break
    }
  }
}
