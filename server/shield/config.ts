import { resolve } from 'node:path'
import type { H3Event } from 'h3'
import type { ShieldStore } from '../../lib/types.mjs'

/**
 * Configurazione dello scudo.
 *
 * - Impostazioni del server (modalità, IP fidati, proxy, cartella dei dati, password del pannello):
 *   runtimeConfig.shield nel nuxt.config.ts o variabili NUXT_SHIELD_*.
 * - Regole e collegamenti con il sito (archivio, login dell'admin, percorsi): configureShield(),
 *   chiamata da un plugin Nitro del progetto.
 */

export type ShieldMode = 'block' | 'monitor' | 'off'

/** Una stringa vale come prefisso del percorso (maiuscole e minuscole indifferenti), una RegExp come espressione. */
export type ShieldPathRule = string | RegExp

export interface ShieldOptions {
  /** Dove salvare blocchi, IP fidati e paesi bloccati. Predefinito: file nella cartella NUXT_SHIELD_DATA_DIR. */
  store?: ShieldStore
  /**
   * Chi può usare il pannello e le API /api/shield: restituisce il nome (o l'email) dell'amministratore,
   * oppure lancia un errore 401/403. Senza, si entra con la password NUXT_SHIELD_ADMIN_PASSWORD.
   */
  authorize?: (event: H3Event) => unknown
  /** Login del sito (POST): una risposta 401 conta come tentativo fallito; hanno il limite di frequenza stretto. */
  loginPaths?: ShieldPathRule[]
  /** Altre API delicate con il limite stretto (POST): registrazioni, recupero password... */
  authPaths?: ShieldPathRule[]
  /** Richieste al minuto per IP: auth (login e authPaths, predefinito 20), api (/api/, 300), pages (tutto, 600). */
  rateLimits?: { auth?: number, api?: number, pages?: number }
  /** Percorsi-trappola in più (es. un link invisibile vietato in robots.txt): chi li apre viene bloccato. */
  honeypots?: ShieldPathRule[]
  /** Percorsi mai considerati trappole, anche se hanno estensioni sospette (es. file caricati .zip). */
  allowPaths?: ShieldPathRule[]
  /** Percorsi i cui 404 non contano (cartelle di file statici che potrebbero mancare). */
  ignore404?: ShieldPathRule[]
  /** Blocco di strumenti di copia e crawler per l'IA (predefinito attivo): false lo spegne, exclude esclude dei percorsi. */
  scraping?: boolean | { exclude?: ShieldPathRule[] }
  /** Percorsi mai bloccati per paese (es. webhook dei pagamenti, che arrivano dai server del fornitore). */
  countryExempt?: ShieldPathRule[]
  /** Paesi che non si possono bloccare dal pannello (es. ['IT'] per un sito italiano). */
  protectedCountries?: string[]
  /** Eccezioni al limite sulla dimensione del corpo delle richieste (es. upload di un'area admin autenticata). */
  allowLargeBody?: (event: H3Event) => boolean | Promise<boolean>
  /** Dimensione massima del corpo delle richieste in byte (predefinito 1 MB). */
  maxBodyBytes?: number
  /** Testi delle risposte a chi viene respinto. */
  messages?: { blocked?: string, country?: string, tooMany?: string }
}

let options: ShieldOptions = {}
let version = 0

/** Configura lo scudo da un plugin Nitro del progetto (server/plugins/shield.ts). */
export function configureShield(next: ShieldOptions) {
  options = { ...options, ...next }
  version++
}

export const shieldOptions = (): Readonly<ShieldOptions> => options
/** Cambia a ogni configureShield: le regole compilate si rifanno. */
export const shieldOptionsVersion = () => version

export interface ShieldRuntime {
  mode: ShieldMode
  allowlist: string
  trustedProxies: string
  cloudflare: boolean
  dataDir: string
  adminPassword: string
  sessionSecret: string
  sessionHours: number
  contact: string
}

/** runtimeConfig.shield con i valori risolti (percorsi assoluti, numeri, booleani). */
export function shieldRuntime(): ShieldRuntime {
  const c = (useRuntimeConfig() as { shield?: Record<string, unknown> }).shield ?? {}
  const mode = String(c.mode || 'block')
  return {
    mode: mode === 'off' || mode === 'monitor' ? mode : 'block',
    allowlist: String(c.allowlist ?? ''),
    trustedProxies: String(c.trustedProxies ?? ''),
    cloudflare: String(c.cloudflare) !== 'false',
    dataDir: resolve(process.cwd(), String(c.dataDir || './.data/shield')),
    adminPassword: String(c.adminPassword ?? ''),
    sessionSecret: String(c.sessionSecret ?? ''),
    sessionHours: Number(c.sessionHours) > 0 ? Number(c.sessionHours) : 12,
    contact: String(c.contact ?? ''),
  }
}

export const shieldMode = (): ShieldMode => shieldRuntime().mode
