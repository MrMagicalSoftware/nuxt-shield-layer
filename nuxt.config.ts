import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { NuxtPage } from 'nuxt/schema'

const currentDir = dirname(fileURLToPath(import.meta.url))

// Configurazione del layer. Il progetto che lo estende può sovrascrivere ogni valore nel proprio
// nuxt.config.ts oppure con le variabili d'ambiente:
//
//   NUXT_SHIELD_MODE              block (default), monitor (blocchi solo nel log), off
//   NUXT_SHIELD_ALLOWLIST         IP o reti CIDR mai bloccati, separati da virgola
//   NUXT_SHIELD_TRUSTED_PROXIES   proxy fidati oltre a loopback, reti private e Cloudflare
//   NUXT_SHIELD_CLOUDFLARE        false se il sito non è dietro Cloudflare
//   NUXT_SHIELD_DATA_DIR          cartella dei dati con l'archivio su file (default ./.data/shield)
//   NUXT_SHIELD_ADMIN_PASSWORD    password del pannello /admin/shield (se il progetto non usa authorize)
//   NUXT_SHIELD_SESSION_SECRET    chiave che firma il cookie di sessione del pannello
//   NUXT_SHIELD_SESSION_HOURS     durata della sessione del pannello (default 12)
//   NUXT_SHIELD_CONTACT           contatto mostrato a chi viene bloccato (es. info@miosito.it)
//
// Le regole (archivio, login del sito, percorsi...) si impostano con configureShield() in un plugin Nitro.

/** Pagine del progetto, lette quando serve (dopo che tutti i moduli hanno aggiunto le loro). */
let appPages: NuxtPage[] = []

/** Primo segmento statico di un percorso (null se è un parametro, es. /:slug). */
function firstSegment(path: string) {
  const segment = path.split('/')[1] ?? ''
  return /^[\w.-]+$/.test(segment) ? segment.toLowerCase() : null
}

/** Modulo #nuxt-shield/app-routes: pagine e route del server, che lo scudo non tratta mai come trappole. */
function appRoutesModule(handlers: Array<{ route?: string, middleware?: boolean }>) {
  const segments = new Set<string>()
  for (const page of appPages) {
    const segment = firstSegment(page.path)
    if (segment) segments.add(segment)
  }
  const exact = new Set<string>()
  const prefixes = new Set<string>()
  for (const handler of handlers) {
    if (handler.middleware || !handler.route) continue
    const route = handler.route.toLowerCase()
    const dynamic = route.search(/[:*]/)
    if (dynamic === -1) exact.add(route)
    else {
      // /blog-media/** → /blog-media/ (mai solo "/": vorrebbe dire nessuna trappola)
      const prefix = route.slice(0, dynamic)
      if (prefix.length > 1 && prefix.endsWith('/')) prefixes.add(prefix)
    }
  }
  return [
    `export const pageSegments = ${JSON.stringify([...segments])}`,
    `export const exactRoutes = ${JSON.stringify([...exact])}`,
    `export const routePrefixes = ${JSON.stringify([...prefixes])}`,
  ].join('\n')
}

export default defineNuxtConfig({
  runtimeConfig: {
    shield: {
      mode: 'block',
      allowlist: '',
      trustedProxies: '',
      cloudflare: true,
      dataDir: './.data/shield',
      adminPassword: '',
      sessionSecret: '',
      sessionHours: 12,
      contact: '',
    },
  },

  // Il pannello è una pagina privata disegnata solo nel browser
  routeRules: {
    '/admin/shield': { ssr: false, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } },
    '/api/shield/**': { headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } },
  },

  hooks: {
    'pages:extend'(pages) {
      appPages = pages
    },
    'nitro:init'(nitro) {
      // Nitro prende i middleware cartella per cartella, sempre prima quella del progetto. Il firewall sta in
      // una cartella sua messa in testa: così filtra le richieste prima di qualsiasi middleware del progetto.
      const firewall = join(currentDir, 'firewall')
      nitro.options.scanDirs = [firewall, ...nitro.options.scanDirs.filter(dir => dir !== firewall)]
      nitro.options.virtual['#nuxt-shield/app-routes'] = () => appRoutesModule([...nitro.scannedHandlers, ...nitro.options.handlers])
    },
  },
})
