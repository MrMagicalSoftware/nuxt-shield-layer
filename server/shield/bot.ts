import { promises as dns } from 'node:dns'

/**
 * Verifica dei crawler dei motori di ricerca con il metodo indicato da Google e Bing: DNS inverso
 * dell'IP → nome nel dominio del motore → DNS diretto del nome, che deve riportare allo stesso IP.
 * Il risultato resta in cache per IP.
 */
export type BotCheck = 'verified' | 'fake' | 'unknown'

const cache = new Map<string, { result: BotCheck, until: number }>()
const TTL_MS = 24 * 60 * 60_000
const UNKNOWN_TTL_MS = 10 * 60_000
const TIMEOUT_MS = 2000
const MAX_ENTRIES = 50_000

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function check(ip: string, domains: string[]): Promise<BotCheck> {
  try {
    const hosts = await withTimeout(dns.reverse(ip))
    const host = hosts.find(h => domains.some(d => h === d || h.endsWith(`.${d}`)))
    if (!host) return 'fake'
    const addresses = await withTimeout(ip.includes(':') ? dns.resolve6(host) : dns.resolve4(host))
    return addresses.includes(ip) ? 'verified' : 'fake'
  }
  catch (error) {
    // Nessun record PTR: un crawler vero lo ha sempre. Altri errori (timeout, DNS non
    // raggiungibile) non devono far bloccare nessuno.
    const code = (error as { code?: string }).code
    return code === 'ENOTFOUND' || code === 'ENODATA' ? 'fake' : 'unknown'
  }
}

export async function verifySearchBot(ip: string, domains: string[]): Promise<BotCheck> {
  const now = Date.now()
  const hit = cache.get(ip)
  if (hit && hit.until > now) return hit.result
  const result = await check(ip, domains)
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(ip, { result, until: now + (result === 'unknown' ? UNKNOWN_TTL_MS : TTL_MS) })
  return result
}
