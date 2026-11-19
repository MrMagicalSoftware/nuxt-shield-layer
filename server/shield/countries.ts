import { isIP } from 'node:net'
import type { H3Event } from 'h3'
import { expandIpv6 } from '../../lib/ip.mjs'
import type { CountryRanges } from '../../lib/types.mjs'
import { TOR_NETWORK } from '../../shared/countries'
import { viaCloudflare } from './ip'
import { readyShieldStore } from './store'

/**
 * Blocco per paese, gestito dal pannello: le richieste da un paese bloccato ricevono un 403, senza
 * punti né blocchi dell'IP (sbloccando il paese tornano subito ammesse).
 *
 * Da dove viene il paese:
 *  - richieste passate da Cloudflare: l'header CF-IPCountry, il dato più preciso (e l'unico per la rete
 *    Tor, T1). Ci si fida dell'header solo se la richiesta è arrivata davvero da Cloudflare;
 *  - richieste dirette al server: gli intervalli di indirizzi del paese, presi da ipdeny.com (liste
 *    aggregate ricavate dai registri regionali RIR), salvati nell'archivio e riscaricati ogni 7 giorni.
 */

const REFRESH_EVERY_MS = 7 * 86_400_000
const RETRY_AFTER_MS = 60 * 60_000
const MAX_BYTES = 8 * 1024 * 1024
const SOURCE = {
  v4: (c: string) => `https://www.ipdeny.com/ipblocks/data/aggregated/${c}-aggregated.zone`,
  v6: (c: string) => `https://www.ipdeny.com/ipv6/ipaddresses/aggregated/${c}-aggregated.zone`,
}

/** Paese bloccato in memoria: intervalli ordinati e uniti, come coppie [inizio, fine, inizio, fine, ...]. */
interface LoadedCountry {
  updatedAt: string
  v4: Uint32Array
  v6: bigint[]
  v4Networks: number
  v6Networks: number
  v4Addresses: number
}

const loaded = new Map<string, LoadedCountry>()
/** Richieste respinte per paese dall'avvio del server (solo questa istanza). */
const rejected = new Map<string, number>()
let refreshing = false
let lastRefreshAttempt = 0

/** BigInt(1) e non 1n: il target di compilazione di Nitro (es2019) non ammette i letterali BigInt. */
const ONE = BigInt(1)

const v4Number = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0)
const v6Number = (ip: string) => BigInt(`0x${expandIpv6(ip).join('')}`)

/** Righe valide (CIDR della famiglia giusta) di una lista scaricata. */
function validLines(lines: string[], fam: 4 | 6): string[] {
  const max = fam === 4 ? 32 : 128
  return lines.map(r => r.trim()).filter((line) => {
    const [ip, bits] = line.split('/')
    return !!ip && bits !== undefined && /^\d{1,3}$/.test(bits) && Number(bits) <= max && isIP(ip) === fam
  })
}

/** Intervalli ordinati, con quelli sovrapposti o adiacenti uniti. */
function merge<T extends number | bigint>(ranges: [T, T][], one: T): T[] {
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out: T[] = []
  for (const [start, end] of ranges) {
    const n = out.length
    if (n && start <= (out[n - 1]! as number) + (one as number)) {
      if (end > out[n - 1]!) out[n - 1] = end
    }
    else out.push(start, end)
  }
  return out
}

function load(ranges: CountryRanges, updatedAt: string): LoadedCountry {
  const v4 = validLines(ranges.v4, 4).map((line): [number, number] => {
    const [ip, bits] = line.split('/') as [string, string]
    const size = 2 ** (32 - Number(bits))
    const start = Math.floor(v4Number(ip) / size) * size
    return [start, start + size - 1]
  })
  const v6 = validLines(ranges.v6, 6).map((line): [bigint, bigint] => {
    const [ip, bits] = line.split('/') as [string, string]
    const shift = BigInt(128 - Number(bits))
    const start = (v6Number(ip) >> shift) << shift
    return [start, start + (ONE << shift) - ONE]
  })
  return {
    updatedAt,
    v4: Uint32Array.from(merge(v4, 1)),
    v6: merge(v6, ONE),
    v4Networks: v4.length,
    v6Networks: v6.length,
    v4Addresses: v4.reduce((n, [a, b]) => n + b - a + 1, 0),
  }
}

/** Ricerca binaria in coppie ordinate [inizio, fine, ...]. */
function contains<T extends number | bigint>(pairs: ArrayLike<T>, x: T) {
  let lo = 0
  let hi = pairs.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (x < pairs[mid * 2]!) hi = mid - 1
    else if (x > pairs[mid * 2 + 1]!) lo = mid + 1
    else return true
  }
  return false
}

/** Paese bloccato che contiene l'IP secondo gli intervalli, se c'è. */
function countryFromRanges(ip: string): string | null {
  const v6 = isIP(ip) === 6
  const n = v6 ? v6Number(ip) : v4Number(ip)
  for (const [code, country] of loaded) {
    if (v6 ? contains(country.v6, n as bigint) : contains(country.v4, n as number)) return code
  }
  return null
}

/** Paese indicato da Cloudflare, solo se la richiesta è passata da Cloudflare (XX = sconosciuto). */
export function cloudflareCountry(event: H3Event): string | null {
  if (!viaCloudflare(event)) return null
  const code = getRequestHeader(event, 'cf-ipcountry')?.trim().toUpperCase()
  return code && /^[A-Z][A-Z0-9]$/.test(code) && code !== 'XX' ? code : null
}

/**
 * Paese bloccato da cui arriva la richiesta, oppure null. Con l'header di Cloudflare vale solo quello
 * (gli intervalli dei registri a volte indicano il paese della società, non quello in cui si usa l'IP).
 */
export function blockedCountry(event: H3Event, ip: string): string | null {
  if (!loaded.size) return null
  const cf = cloudflareCountry(event)
  if (cf) return loaded.has(cf) ? cf : null
  return countryFromRanges(ip)
}

export function countRejected(code: string) {
  rejected.set(code, (rejected.get(code) ?? 0) + 1)
}

/** Paese dell'amministratore che usa il pannello, per non fargli bloccare il proprio. */
export function requestCountry(event: H3Event, ip: string | null) {
  const cf = cloudflareCountry(event)
  if (cf) return { code: cf, source: 'cloudflare' as const }
  const fromRanges = ip ? countryFromRanges(ip) : null
  return { code: fromRanges, source: fromRanges ? 'ranges' as const : null }
}

// --- Scaricamento e archivio ---------------------------------------------------------------------------

async function download(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'nuxt-shield-layer' } })
  if (res.status === 404) return ''
  if (!res.ok) throw new Error(`ipdeny.com ha risposto ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('lista troppo grande')
  return text
}

/** Scarica gli intervalli del paese (IPv4 e IPv6) e lo blocca; se era già bloccato li aggiorna. */
export async function blockCountry(code: string, createdBy: string | null) {
  let ranges: CountryRanges = { v4: [], v6: [] }
  if (code !== TOR_NETWORK) {
    const c = code.toLowerCase()
    const [t4, t6] = await Promise.all([download(SOURCE.v4(c)), download(SOURCE.v6(c))])
    ranges = { v4: validLines(t4.split(/\r?\n/), 4), v6: validLines(t6.split(/\r?\n/), 6) }
    if (!ranges.v4.length && !ranges.v6.length) throw new Error(`nessun intervallo di indirizzi trovato per ${code}`)
  }
  const now = new Date().toISOString()
  await (await readyShieldStore()).saveCountry({ code, createdBy, createdAt: now, updatedAt: now }, ranges)
  await syncCountries()
}

export async function unblockCountry(code: string) {
  await (await readyShieldStore()).deleteCountry(code)
  loaded.delete(code)
  rejected.delete(code)
}

export interface BlockedCountryInfo {
  code: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  v4Networks: number
  v6Networks: number
  v4Addresses: number
  rejected: number
}

export async function listBlockedCountries(): Promise<BlockedCountryInfo[]> {
  const list = await (await readyShieldStore()).listCountries()
  return list.map((c) => {
    const country = loaded.get(c.code)
    return {
      ...c,
      v4Networks: country?.v4Networks ?? 0,
      v6Networks: country?.v6Networks ?? 0,
      v4Addresses: country?.v4Addresses ?? 0,
      rejected: rejected.get(c.code) ?? 0,
    }
  })
}

/**
 * Allinea la memoria all'archivio (ogni minuto): carica i paesi aggiunti o aggiornati, anche da altre
 * istanze, e toglie quelli sbloccati. Gli intervalli più vecchi di 7 giorni vengono riscaricati in
 * sottofondo; se ipdeny.com non risponde restano quelli che ci sono.
 */
export async function syncCountries() {
  const store = await readyShieldStore()
  const list = await store.listCountries()
  const inStore = new Set<string>()
  for (const c of list) {
    inStore.add(c.code)
    if (loaded.get(c.code)?.updatedAt === c.updatedAt) continue
    const ranges = await store.getCountryRanges(c.code)
    if (ranges) loaded.set(c.code, load(ranges, c.updatedAt))
  }
  for (const code of loaded.keys()) {
    if (!inStore.has(code)) loaded.delete(code)
  }

  const now = Date.now()
  const stale = list.filter(c => c.code !== TOR_NETWORK && now - Date.parse(c.updatedAt) > REFRESH_EVERY_MS)
  if (stale.length && !refreshing && now - lastRefreshAttempt > RETRY_AFTER_MS) {
    refreshing = true
    lastRefreshAttempt = now
    void (async () => {
      for (const { code } of stale) {
        try {
          await blockCountry(code, null)
          console.info(`[shield] intervalli IP di ${code} aggiornati`)
        }
        catch (error) {
          console.error(`[shield] intervalli IP di ${code} non aggiornati:`, (error as Error).message)
        }
      }
    })().finally(() => {
      refreshing = false
    })
  }
  return { countries: loaded.size }
}
