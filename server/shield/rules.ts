/// <reference path="./app-routes.d.ts" />
import { exactRoutes, pageSegments, routePrefixes } from '#nuxt-shield/app-routes'
import { shieldOptions, shieldOptionsVersion, type ShieldPathRule } from './config'

/**
 * Regole dello scudo: punteggi, trappole, payload d'attacco, strumenti di scanning e di copia.
 *
 * Le trappole sono percorsi che un sito Nuxt non serve mai (WordPress, phpMyAdmin, file .env...):
 * chi li cerca sta facendo scanning. Per non colpire mai il sito stesso, le pagine e le route del
 * server del progetto vengono escluse in automatico (vedi nuxt.config.ts del layer, #nuxt-shield/app-routes).
 */

/** Punteggio oltre il quale l'IP viene bloccato. */
export const SHIELD_THRESHOLD = 100

/** Il punteggio cala di 1 punto ogni 10 secondi (6 al minuto). */
export const SHIELD_DECAY_MS = 10_000

export const SHIELD_SCORES = {
  /** Percorso-trappola, payload d'attacco, scanner noto: blocco immediato. */
  severe: SHIELD_THRESHOLD,
  /** Metodo HTTP anomalo (TRACE, PROPFIND...): due richieste e scatta il blocco. */
  badMethod: 60,
  /** URL lunghissimo, tipico dei fuzzer. */
  longUrl: 20,
  /** Login fallito: circa 10 tentativi ravvicinati portano al blocco. */
  failedLogin: 10,
  /** Pagina inesistente: circa 20 errori ravvicinati portano al blocco. */
  notFound: 5,
  /** Ogni richiesta respinta per superamento del limite di frequenza. */
  rateLimited: 1,
  /** Finto motore di ricerca (user agent di Googlebot da un IP che non è di Google). */
  fakeBot: 50,
  /** Strumento di copia o crawler per l'addestramento di IA. */
  scraper: 10,
} as const

/** Durata dei blocchi successivi per lo stesso IP (nell'arco di 30 giorni), in minuti. */
export const SHIELD_BAN_STEPS_MIN = [60, 6 * 60, 24 * 60, 7 * 24 * 60]

/** I blocchi per motivi gravi durano almeno 24 ore. */
export const SHIELD_SEVERE_MIN_MIN = 24 * 60

export const SHIELD_MAX_URL_LENGTH = 2048
export const SHIELD_MAX_BODY_BYTES = 1024 * 1024

/** Percorsi cercati dagli scanner di vulnerabilità. */
const HONEYPOT_PREFIX = new RegExp(`^/(${[
  'wp-admin', 'wp-login', 'wp-content', 'wp-includes', 'wp-json', 'wordpress', 'xmlrpc\\.php',
  'phpmyadmin', 'pma', 'myadmin', 'mysqladmin', 'adminer', 'dbadmin', 'sqladmin',
  '\\.env', '\\.git', '\\.svn', '\\.hg', '\\.bzr', '\\.ds_store', '\\.aws', '\\.ssh', '\\.docker',
  '\\.htaccess', '\\.htpasswd', '\\.vscode', '\\.idea', '\\.npmrc', '\\.travis', '\\.circleci',
  'cgi-bin', 'vendor/phpunit', 'phpunit', 'actuator', 'solr', 'jenkins', 'manager/html',
  'server-status', 'server-info', 'boaform', 'hnap1', 'owa', 'autodiscover', 'ecp',
  'remote/login', 'remote/fgt_lang', 'druid', 'telescope', '_ignition', 'debug/default',
  'console', 'jmx-console', 'web-console', 'invoker', 'axis2', 'struts', 'shell', 'cmd',
  'administrator/index', 'user/login\\.php', 'setup\\.cgi', 'goform', 'sdk', 'evox', 'hudson',
  'storage/logs', 'backup', 'backups', 'old', 'dump', 'database\\.sql', 'db\\.sql', 'sql\\.',
  'config', 'credentials', 'id_rsa', 'package\\.json', 'package-lock\\.json',
  'composer\\.(json|lock)', 'docker-compose', 'dockerfile', 'appsettings', 'web\\.config',
  'settings\\.py', 'wallet', 'keys', 'secrets', 'global-protect', 'ssl-vpn', 'dana-na',
  'vpn', 'portal/redlion', 'aspera', 'mifs', 'cf_scripts', 'ws_ftp', 'ftp', 'sftp-config',
].join('|')})(?:[/?#.]|$)`, 'i')

/** Estensioni di file che un sito Nuxt non serve mai. */
const HONEYPOT_EXT = /\.(php\d?|phtml|phar|asp|aspx|ashx|asmx|axd|jsp|jspa|jspx|do|action|cgi|pl|py|rb|sh|env|ini|sql|bak|old|orig|save|swp|swo|backup|dist|log|tar|tgz|gz|bz2|zip|rar|7z|war|jar|db|sqlite3?|mdb|pem|key|crt|p12|pfx|yml|yaml|toml|conf|cfg|htaccess|htpasswd)$/i

/** Payload di attacco nell'URL (path traversal, SQLi, XSS, RCE, Log4Shell...). */
const ATTACK_URL = new RegExp([
  '\\.\\./', '\\.\\.\\\\', '%2e%2e', '%252e', '%00', '\\x00',
  '/etc/(passwd|shadow|hosts|group)', '\\bwin\\.ini\\b', 'boot\\.ini', '/proc/self', 'c:\\\\windows',
  '\\$\\{jndi:', '\\$\\{\\$\\{', '<script', '</script', 'javascript:', 'vbscript:', '\\bon(error|load|mouseover)\\s*=',
  '\\bunion(\\s|\\+|/\\*.*?\\*/)+(all(\\s|\\+)+)?select\\b', '\\bselect\\b.+\\bfrom\\b.+\\binformation_schema\\b',
  '\\b(sleep|benchmark|pg_sleep)\\s*\\(', '\\bwaitfor\\s+delay\\b', '\'\\s*or\\s+\'?1\'?\\s*=\\s*\'?1', '\\bxp_cmdshell\\b',
  '[;|`]\\s*(wget|curl|nc|ncat|bash|sh|chmod|python|perl|powershell)\\b', '\\$\\((wget|curl|id|whoami|cat)\\b',
  'cmd\\.exe', '/bin/(ba)?sh', '<\\?php', 'base64_decode\\s*\\(', '\\beval\\s*\\(', 'phpinfo',
  '(php|file|expect|data|zip|phar|gopher|dict)://', 'allow_url_include', 'auto_prepend_file',
  '169\\.254\\.169\\.254', 'metadata\\.google\\.internal',
].join('|'), 'i')

/** Payload d'attacco negli header (Log4Shell, Shellshock). */
const ATTACK_HEADER = /\$\{(jndi|\$\{|lower:|upper:|env:)|\(\)\s*\{\s*:\s*;\s*\}/i

/** User agent degli strumenti di scanning e attacco più diffusi. */
const SCANNER_UA = new RegExp(`(${[
  'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab', 'zmap', 'nuclei', 'gobuster', 'dirbuster', '\\bdirb\\b',
  'wfuzz', '\\bffuf\\b', 'feroxbuster', 'wpscan', 'joomscan', 'droopescan', 'acunetix', 'netsparker',
  'invicti', 'nessus', 'openvas', 'qualys', 'w3af', 'arachni', 'skipfish', 'havij', 'jorgee', 'zmeu',
  'morfeus', 'fimap', 'commix', 'xsstrike', 'whatweb', 'wappalyzer', 'hydra', 'medusa', 'burp',
  'interactsh', 'l9explore', 'l9tcpid', 'leakix', 'censysinspect', 'internet-measurement', 'expanse',
  'cortex xpanse', 'odin\\.io', 'shodan', 'netcraftsurvey', 'researchscan', 'katana',
  'project discovery', 'fuzz faster', 'webshag', 'vega/',
].join('|')})`, 'i')

/**
 * Crawler che raccolgono contenuti per addestrare modelli di IA. Gli assistenti di ricerca che portano
 * visitatori (OAI-SearchBot, ChatGPT-User, PerplexityBot) restano ammessi.
 */
const AI_TRAINING_UA = /\b(gptbot|claudebot|claude-web|anthropic-ai|ccbot|bytespider|meta-externalagent|meta-externalfetcher|facebookbot|diffbot|cohere-ai|cohere-training-data-crawler|imagesiftbot|omgilibot|omgili|timpibot|pangubot|ai2bot|ai2bot-dolma|applebot-extended|google-extended|img2dataset|webzio-extended|velenpublicwebcrawler|youbot|amazonbot|scrapy)\b/i

/** Programmi per scaricare o copiare siti interi e librerie usate dagli scraper. */
const SCRAPER_UA = /\b(httrack|webcopier|webzip|teleport ?pro|offline explorer|sitesucker|websitecopier|webreaper|getright|wget|curl|python-requests|python-urllib|python-httpx|aiohttp|httpx|go-http-client|java\/|libwww-perl|lwp-trivial|mechanize|node-fetch|axios|got \(|undici|headlesschrome|phantomjs|puppeteer|playwright|selenium|scrapinghub|zyte|crawler4j|nutch|heritrix|colly|apify|mj12bot|dotbot|blexbot|dataforseobot|serpstatbot|barkrowler|seekportbot|megaindex)\b/i

/**
 * Crawler dei motori di ricerca e delle anteprime dei social: non vengono penalizzati per 404 né per la
 * frequenza, se l'IP è verificato. Le regole gravi (trappole, payload, scanner) valgono anche per loro.
 */
const SEARCH_BOT_UA = /\b(googlebot|google-inspectiontool|adsbot-google|mediapartners-google|storebot-google|bingbot|bingpreview|adidxbot|applebot|duckduckbot|yandexbot|baiduspider|petalbot|qwantbot|ecosia|seznambot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot)\b/i

/** Domini a cui deve risolvere l'IP (DNS inverso + diretto) dei crawler che dichiarano di essere un motore di ricerca. */
const BOT_DOMAINS: Array<[RegExp, string[]]> = [
  [/googlebot|google-inspectiontool|adsbot-google|mediapartners-google|storebot-google/i, ['googlebot.com', 'google.com', 'googleusercontent.com']],
  [/bingbot|bingpreview|adidxbot/i, ['search.msn.com']],
  [/applebot/i, ['applebot.apple.com']],
  [/yandexbot/i, ['yandex.ru', 'yandex.net', 'yandex.com']],
  [/baiduspider/i, ['baidu.com', 'baidu.jp']],
  [/petalbot/i, ['petalsearch.com', 'aspiegel.com']],
]

/** Metodi HTTP ammessi (le API possono usare CORS, quindi anche OPTIONS). */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** 404 di risorse statiche (immagini, font, stili...): capitano anche ai visitatori veri, non contano. */
const STATIC_ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp3|mp4|m4a|ogg|oga|webm|wav|pdf)$/i

/** Percorsi predefiniti: Nuxt, file che i browser cercano da soli, pannello dello scudo, nuxt-blog-layer. */
const DEFAULT_LOGIN_PATHS = ['/api/shield/login', '/api/blog/admin/login']
const DEFAULT_IGNORE_404 = [
  '/_nuxt/', '/__nuxt', '/favicon', '/apple-touch-icon', '/android-chrome', '/site.webmanifest', '/manifest.json',
  '/manifest.webmanifest', '/browserconfig.xml', '/robots.txt', '/sitemap', '/ads.txt', '/app-ads.txt',
  '/.well-known/', '/api/_nuxt_icon/', '/blog-media/',
]
const DEFAULT_SCRAPING_EXCLUDE = ['/_nuxt/', '/__nuxt', '/favicon', '/robots.txt', '/sitemap', '/.well-known/', '/api/_nuxt_icon/', '/api/shield/']
const DEFAULT_ALLOW = ['/blog-media/']

export interface ShieldVerdict {
  score: number
  reason: string
  /** Codice HTTP con cui rispondere subito (la richiesta non arriva al sito). */
  status?: number
}

export interface ShieldRateRule {
  name: string
  limit: number
  score: number
  match: (path: string, method: string) => boolean
}

type PathMatcher = (path: string) => boolean

function matcher(rules: ShieldPathRule[] = []): PathMatcher {
  const prefixes = rules.filter((r): r is string => typeof r === 'string' && !!r).map(r => r.toLowerCase())
  const regexps = rules.filter((r): r is RegExp => r instanceof RegExp)
  if (!prefixes.length && !regexps.length) return () => false
  return (path) => {
    const lower = path.toLowerCase()
    return prefixes.some(p => lower.startsWith(p)) || regexps.some((re) => {
      re.lastIndex = 0
      return re.test(path)
    })
  }
}

interface CompiledRules {
  version: number
  login: PathMatcher
  honeypot: PathMatcher
  allow: PathMatcher
  ignore404: PathMatcher
  scraping: boolean
  scrapingExclude: PathMatcher
  countryExempt: PathMatcher
  rateLimits: ShieldRateRule[]
}

let compiled: CompiledRules | undefined

/** Regole della configurazione, compilate una volta (e di nuovo dopo ogni configureShield). */
export function shieldRules(): CompiledRules {
  const version = shieldOptionsVersion()
  if (compiled?.version === version) return compiled
  const o = shieldOptions()
  const login = matcher([...DEFAULT_LOGIN_PATHS, ...(o.loginPaths ?? [])])
  const auth = matcher(o.authPaths)
  const scraping = o.scraping ?? true
  compiled = {
    version,
    login,
    honeypot: matcher(o.honeypots),
    allow: matcher([...DEFAULT_ALLOW, ...(o.allowPaths ?? [])]),
    ignore404: matcher([...DEFAULT_IGNORE_404, ...(o.ignore404 ?? [])]),
    scraping: scraping !== false,
    scrapingExclude: matcher([...DEFAULT_SCRAPING_EXCLUDE, ...(typeof scraping === 'object' ? scraping.exclude ?? [] : [])]),
    countryExempt: matcher(o.countryExempt),
    rateLimits: [
      // Login e registrazioni: protezione dagli attacchi a forza bruta
      { name: 'auth', limit: o.rateLimits?.auth ?? 20, score: 5, match: (path, method) => method === 'POST' && (login(path) || auth(path)) },
      { name: 'api', limit: o.rateLimits?.api ?? 300, score: SHIELD_SCORES.rateLimited, match: path => path.startsWith('/api/') },
      { name: 'pages', limit: o.rateLimits?.pages ?? 600, score: SHIELD_SCORES.rateLimited, match: () => true },
    ],
  }
  return compiled
}

// --- Pagine e route del progetto: mai trappole ----------------------------------------------------

const PAGE_SEGMENTS = new Set(pageSegments)
const EXACT_ROUTES = new Set(exactRoutes)

/** Il percorso appartiene a una route del server del progetto (es. /blog-media/**, /sitemap.xml). */
function isAppRoute(path: string) {
  const lower = path.toLowerCase()
  return EXACT_ROUTES.has(lower) || routePrefixes.some(p => lower.startsWith(p))
}

/** Il primo segmento del percorso è quello di una pagina del sito (es. /backup se esiste pages/backup.vue). */
function isAppPage(path: string) {
  return PAGE_SEGMENTS.has((path.split('/')[1] ?? '').toLowerCase())
}

// --- Esame delle richieste --------------------------------------------------------------------------

export function isSearchBot(userAgent: string) {
  return SEARCH_BOT_UA.test(userAgent)
}

/** Domini attesi per un crawler verificabile, null se l'UA non ne dichiara uno. */
export function verifiableBotDomains(userAgent: string) {
  return BOT_DOMAINS.find(([re]) => re.test(userAgent))?.[1] ?? null
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

/** Esamina una richiesta prima che arrivi al sito: null se è innocua, altrimenti punti ed eventuale status. */
export function inspectRequest(input: { method: string, url: string, userAgent: string, referer: string }): ShieldVerdict | null {
  const { method, url, userAgent, referer } = input

  if (SCANNER_UA.test(userAgent)) return { score: SHIELD_SCORES.severe, reason: `scanner: ${userAgent.slice(0, 60)}`, status: 403 }
  if (ATTACK_HEADER.test(userAgent) || ATTACK_HEADER.test(referer)) {
    return { score: SHIELD_SCORES.severe, reason: 'payload negli header', status: 403 }
  }
  if (!ALLOWED_METHODS.has(method)) return { score: SHIELD_SCORES.badMethod, reason: `metodo ${method}`, status: 405 }
  if (url.length > SHIELD_MAX_URL_LENGTH) return { score: SHIELD_SCORES.longUrl, reason: 'URL troppo lungo', status: 414 }

  const decoded = safeDecode(safeDecode(url))
  const path = decoded.split(/[?#]/, 1)[0]!.replace(/\/{2,}/g, '/')
  if (ATTACK_URL.test(decoded) || ATTACK_URL.test(url)) {
    return { score: SHIELD_SCORES.severe, reason: `payload: ${path.slice(0, 80)}`, status: 403 }
  }

  const rules = shieldRules()
  if (rules.allow(path) || isAppRoute(path)) return null
  // Ai percorsi-trappola si risponde 404, come se non esistessero
  if ((HONEYPOT_PREFIX.test(path) && !isAppPage(path)) || HONEYPOT_EXT.test(path) || rules.honeypot(path)) {
    return { score: SHIELD_SCORES.severe, reason: `percorso-trappola: ${path.slice(0, 80)}`, status: 404 }
  }
  return null
}

/** Strumenti di copia e crawler per l'IA: valgono per pagine e API, non per i percorsi esclusi. */
export function inspectCopying(path: string, userAgent: string): ShieldVerdict | null {
  const rules = shieldRules()
  if (!rules.scraping || rules.scrapingExclude(path)) return null
  if (AI_TRAINING_UA.test(userAgent)) return { score: SHIELD_SCORES.scraper, reason: `crawler IA: ${userAgent.slice(0, 60)}`, status: 403 }
  if (SCRAPER_UA.test(userAgent)) return { score: SHIELD_SCORES.scraper, reason: `scraper: ${userAgent.slice(0, 60)}`, status: 403 }
  // I browser e i crawler veri dichiarano sempre chi sono
  if (!userAgent.trim() && !path.startsWith('/api/')) return { score: SHIELD_SCORES.scraper, reason: 'user agent assente', status: 403 }
  return null
}

/** Punti in base all'esito della risposta: login falliti e 404 ripetuti (scansione di percorsi). */
export function inspectResponse(path: string, method: string, status: number): ShieldVerdict | null {
  const rules = shieldRules()
  if (status === 401 && method === 'POST' && rules.login(path)) {
    return { score: SHIELD_SCORES.failedLogin, reason: 'login fallito' }
  }
  if (status === 404 && !STATIC_ASSET.test(path) && !rules.ignore404(path)) {
    return { score: SHIELD_SCORES.notFound, reason: `404 ripetuti: ${path.slice(0, 80)}` }
  }
  return null
}
