import { BlockList, isIP } from 'node:net'
import type { H3Event } from 'h3'
import { normalizeIp } from '../../lib/ip.mjs'
import { shieldRuntime } from './config'

/**
 * IP reale del client.
 *
 * Dietro Cloudflare (ed eventualmente nginx o Docker) l'IP della connessione è quello del proxy, non
 * del visitatore: bloccarlo vorrebbe dire bloccare tutti. Per questo:
 *  - X-Forwarded-For si legge solo se la connessione arriva da un proxy fidato;
 *  - la catena si scorre da destra saltando i proxy fidati: il primo indirizzo non fidato è il client
 *    (le voci aggiunte a sinistra dal client sono falsificabili e vengono ignorate);
 *  - CF-Connecting-IP si usa solo se la richiesta è passata davvero da Cloudflare.
 */

/** https://www.cloudflare.com/ips/ (aggiornato al 2026-10-09) */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

/** Loopback e reti private: tipicamente nginx sulla stessa macchina o la rete di Docker. */
const LOCAL_RANGES = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
  '::1/128', 'fc00::/7', 'fe80::/10',
]

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')
const splitList = (value: unknown) => String(value ?? '').split(/[\s,]+/).filter(Boolean)

function buildList(entries: string[], label: string) {
  const list = new BlockList()
  for (const entry of entries) {
    const [addr, bits] = entry.trim().split('/')
    const ip = normalizeIp(addr)
    if (!ip) {
      if (entry.trim()) console.warn(`[shield] ${label}: indirizzo non valido ignorato "${entry}"`)
      continue
    }
    if (bits === undefined) list.addAddress(ip, family(ip))
    else list.addSubnet(ip, Number(bits), family(ip))
  }
  return list
}

interface IpLists {
  trusted: BlockList
  cloudflare: BlockList
  allow: BlockList
  useCloudflare: boolean
}

let lists: IpLists | undefined

/** Liste costruite una volta sola dalla configurazione (NUXT_SHIELD_*). */
export function shieldLists(): IpLists {
  if (!lists) {
    const config = shieldRuntime()
    lists = {
      trusted: buildList([...LOCAL_RANGES, ...splitList(config.trustedProxies)], 'trustedProxies'),
      cloudflare: buildList(config.cloudflare ? CLOUDFLARE_RANGES : [], 'cloudflare'),
      allow: buildList(splitList(config.allowlist), 'allowlist'),
      useCloudflare: config.cloudflare,
    }
  }
  return lists
}

/** È un proxy fidato (loopback, rete privata, Cloudflare, NUXT_SHIELD_TRUSTED_PROXIES): non va mai bloccato. */
export function isTrustedProxy(ip: string) {
  const { trusted, cloudflare } = shieldLists()
  return trusted.check(ip, family(ip)) || cloudflare.check(ip, family(ip))
}

/** IP fidati aggiunti dal pannello: riallineati ogni minuto e a ogni modifica. */
let trustedByAdmin = new BlockList()

export function setTrustedAddresses(addresses: string[]) {
  trustedByAdmin = buildList(addresses, 'IP fidati')
}

/** È tra gli IP fidati (NUXT_SHIELD_ALLOWLIST o aggiunti dal pannello): non viene mai bloccato. */
export function isShieldTrusted(ip: string) {
  const { allow } = shieldLists()
  return allow.check(ip, family(ip)) || trustedByAdmin.check(ip, family(ip))
}

interface ResolvedClient { ip: string | null, viaCloudflare: boolean }
const resolved = new WeakMap<H3Event, ResolvedClient>()

/** IP reale del client, oppure null se non si può stabilire (es. con `nuxi dev`). */
export function getClientIp(event: H3Event): string | null {
  return resolveClient(event).ip
}

/** La richiesta è passata da Cloudflare: solo allora i suoi header CF-* (es. CF-IPCountry) sono affidabili. */
export function viaCloudflare(event: H3Event): boolean {
  return resolveClient(event).viaCloudflare
}

function resolveClient(event: H3Event): ResolvedClient {
  let client = resolved.get(event)
  if (!client) {
    client = computeClient(event)
    resolved.set(event, client)
  }
  return client
}

function computeClient(event: H3Event): ResolvedClient {
  const peer = normalizeIp(event.node.req.socket?.remoteAddress)
  if (!peer || !isTrustedProxy(peer)) return { ip: peer, viaCloudflare: false }

  const { cloudflare, useCloudflare } = shieldLists()
  const forwarded = splitList(getRequestHeader(event, 'x-forwarded-for'))
    .map(normalizeIp)
    .filter((ip): ip is string => !!ip)

  // Scorre la catena da destra: [client, proxy1, proxy2, ...] + peer
  let viaCf = cloudflare.check(peer, family(peer))
  for (let i = forwarded.length - 1; i >= 0; i--) {
    const hop = forwarded[i]!
    if (!isTrustedProxy(hop)) {
      const cf = useCloudflare && viaCf
      return { ip: cf ? (cfIp(event) ?? hop) : hop, viaCloudflare: cf }
    }
    viaCf ||= cloudflare.check(hop, family(hop))
  }

  if (useCloudflare && viaCf) return { ip: cfIp(event) ?? forwarded[0] ?? peer, viaCloudflare: true }
  // Solo proxy fidati nella catena (es. una richiesta dalla stessa macchina): vale il primo della catena
  return { ip: forwarded[0] ?? peer, viaCloudflare: false }
}

function cfIp(event: H3Event) {
  return normalizeIp(getRequestHeader(event, 'cf-connecting-ip'))
}
