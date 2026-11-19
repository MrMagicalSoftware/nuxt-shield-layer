import { isIP } from 'node:net'

/**
 * Indirizzi IP: normalizzazione e chiavi usate per punteggi e blocchi.
 * Nessuna dipendenza da Nuxt: lo usano sia il server sia la riga di comando.
 */

/** Normalizza un indirizzo: toglie porta, zone id e prefisso IPv4-mapped. null se non è un IP valido. */
export function normalizeIp(raw) {
  if (!raw) return null
  let ip = String(raw).trim().replace(/^"|"$/g, '')
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'))
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'))
  ip = ip.replace(/%.*$/, '')
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7)
  return isIP(ip) ? ip.toLowerCase() : null
}

/** Espande un IPv6 nei suoi 8 gruppi esadecimali (`::` e IPv4 incorporato inclusi). */
export function expandIpv6(ip) {
  let addr = ip
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number)
    addr = addr.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map(g => g.padStart(4, '0'))
}

/**
 * Chiave usata per punteggi e blocchi: l'IPv4 così com'è, per l'IPv6 il prefisso /64 (a un singolo
 * cliente viene assegnato un /64 intero: chi fa scanning può cambiare indirizzo all'infinito restando
 * nella stessa rete).
 */
export function shieldKey(ip) {
  if (isIP(ip) !== 6) return ip
  return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`
}

/** Valida un IP o una chiave /64 scritta a mano e la normalizza; null se non è valida. */
export function parseShieldKey(input) {
  const value = String(input ?? '').trim().toLowerCase()
  const prefix = value.match(/^(.+)\/64$/)
  const ip = normalizeIp(prefix ? prefix[1] : value)
  if (!ip || (prefix && isIP(ip) !== 6)) return null
  return shieldKey(ip)
}

/**
 * Valida un IP o una rete CIDR da aggiungere ai fidati. Le reti troppo ampie non sono ammesse
 * (IPv4 almeno /16, IPv6 almeno /48): renderebbero lo scudo inutile.
 */
export function parseTrustedAddress(input) {
  const [addr, bits] = String(input ?? '').trim().toLowerCase().split('/')
  const ip = normalizeIp(addr)
  if (!ip) return null
  if (bits === undefined) return ip
  const n = Number(bits)
  const v6 = isIP(ip) === 6
  if (!/^\d+$/.test(bits) || n > (v6 ? 128 : 32) || n < (v6 ? 48 : 16)) return null
  return `${ip}/${n}`
}
