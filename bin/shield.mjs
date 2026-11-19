#!/usr/bin/env node
/**
 * Riga di comando di nuxt-shield-layer: gestisce l'archivio dello scudo anche a sito spento
 * (per esempio per sbloccare un amministratore rimasto fuori). Il sito in esecuzione recepisce
 * le modifiche entro un minuto.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFileShieldStore } from '../lib/file-store.mjs'
import { parseShieldKey, parseTrustedAddress } from '../lib/ip.mjs'
import { createMysqlShieldStore } from '../lib/mysql-store.mjs'

const HELP = `Uso: npx nuxt-shield <comando> [argomenti] [--dir <cartella> | --mysql <url>]

Comandi:
  list                          IP bloccati ora
  ban <ip> [ore] [motivo]       blocca un IP o una rete IPv6 /64 (ore: 24 di default, 0 = permanente)
  unban <ip>                    sblocca un IP e ne azzera la storia
  trusted                       IP fidati
  trust <ip|rete> [nota]        aggiunge un IP o una rete ai fidati (mai bloccati)
  untrust <ip|rete>             toglie un IP dai fidati
  countries                     paesi bloccati
  unblock-country <XX>          sblocca un paese (codice ISO, es. CN)

Archivio:
  su file (predefinito)         la cartella --dir, NUXT_SHIELD_DATA_DIR o ./.data/shield
  MySQL                         --mysql <url> o NUXT_SHIELD_MYSQL_URL (serve mysql2 nel progetto)

Il file .env della cartella corrente viene letto, come fa il sito.`

if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env')
  }
  catch {
    // Node senza loadEnvFile (prima della 20.12): si usano solo le variabili già impostate
  }
}

const flags = {}
const rest = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const match = arg.match(/^--(dir|mysql)(?:=(.*))?$/)
  if (match) flags[match[1]] = match[2] ?? argv[++i]
  else if (arg === '-h' || arg === '--help' || arg === 'help') flags.help = true
  else rest.push(arg)
}
const [command = 'list', ...params] = rest

const when = ms => new Date(ms).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
const day = iso => new Date(iso).toLocaleDateString('it-IT')

async function openStore() {
  const url = flags.mysql ?? process.env.NUXT_SHIELD_MYSQL_URL
  if (url) {
    let mysql
    try {
      mysql = await import('mysql2/promise')
    }
    catch {
      throw new Error('per usare MySQL installa mysql2 nel progetto (npm install mysql2)')
    }
    const pool = (mysql.default ?? mysql).createPool({ uri: url, connectionLimit: 1, dateStrings: true })
    return { store: createMysqlShieldStore(pool, { createTables: false }), close: () => pool.end(), where: 'MySQL' }
  }
  const dir = resolve(flags.dir ?? process.env.NUXT_SHIELD_DATA_DIR ?? './.data/shield')
  return { store: createFileShieldStore(dir), close: async () => {}, where: dir }
}

function requireKey(input) {
  const key = parseShieldKey(input ?? '')
  if (!key) throw new Error(`indirizzo IP non valido: ${input ?? ''}`)
  return key
}

async function run(store) {
  const now = Date.now()
  switch (command) {
    case 'list': {
      const bans = (await store.listBans()).filter(b => b.until > now).sort((a, b) => b.until - a.until)
      if (!bans.length) return console.log('Nessun IP bloccato.')
      for (const b of bans) {
        const until = b.until - now > 5 * 365 * 86_400_000 ? 'permanente      ' : `fino al ${when(b.until)}`
        console.log(`${b.key.padEnd(26)} ${until}  n.${b.count}${b.manual ? ' (manuale)' : ''}  ${b.reason}`)
      }
      return
    }
    case 'ban': {
      const key = requireKey(params[0])
      const hours = Number(params[1] ?? 24)
      if (!Number.isInteger(hours) || hours < 0) throw new Error('ore non valide')
      const reason = params.slice(2).join(' ')
      const previous = (await store.listBans()).find(b => b.key === key)
      const minutes = hours === 0 ? 10 * 365 * 24 * 60 : hours * 60
      await store.saveBan({
        key,
        reason: `manuale (riga di comando)${reason ? `: ${reason}` : ''}`.slice(0, 255),
        until: now + minutes * 60_000,
        count: (previous?.count ?? 0) + 1,
        manual: true,
        lastPath: null,
        userAgent: null,
      })
      return console.log(`✓ ${key} bloccato ${hours === 0 ? 'in modo permanente' : `per ${hours} ore`} (attivo sul sito entro un minuto)`)
    }
    case 'unban': {
      const key = requireKey(params[0])
      const existed = (await store.listBans()).some(b => b.key === key)
      await store.deleteBan(key)
      return console.log(existed ? `✓ ${key} sbloccato (attivo sul sito entro un minuto)` : `${key} non era bloccato`)
    }
    case 'trusted': {
      const list = await store.listTrusted()
      if (!list.length) return console.log('Nessun IP fidato.')
      for (const t of list) console.log(`${t.address.padEnd(26)} ${t.note ?? ''}  (aggiunto il ${day(t.createdAt)}${t.createdBy ? ` da ${t.createdBy}` : ''})`)
      return
    }
    case 'trust': {
      const address = parseTrustedAddress(params[0] ?? '')
      if (!address) throw new Error(`indirizzo non valido: ${params[0] ?? ''} (un IP, o una rete IPv4 almeno /16, IPv6 almeno /48)`)
      await store.saveTrusted({ address, note: params.slice(1).join(' ').slice(0, 120) || null, createdBy: 'riga di comando', createdAt: new Date().toISOString() })
      return console.log(`✓ ${address} aggiunto agli IP fidati (attivo sul sito entro un minuto)`)
    }
    case 'untrust': {
      const address = parseTrustedAddress(params[0] ?? '') ?? String(params[0] ?? '').trim().toLowerCase()
      await store.deleteTrusted(address)
      return console.log(`✓ ${address} tolto dagli IP fidati`)
    }
    case 'countries': {
      const list = await store.listCountries()
      if (!list.length) return console.log('Nessun paese bloccato.')
      for (const c of list) console.log(`${c.code}  bloccato il ${day(c.createdAt)}${c.createdBy ? ` da ${c.createdBy}` : ''}, intervalli del ${day(c.updatedAt)}`)
      return
    }
    case 'unblock-country': {
      const code = String(params[0] ?? '').trim().toUpperCase()
      if (!/^[A-Z][A-Z0-9]$/.test(code)) throw new Error(`codice paese non valido: ${params[0] ?? ''}`)
      const existed = (await store.listCountries()).some(c => c.code === code)
      await store.deleteCountry(code)
      return console.log(existed ? `✓ ${code} sbloccato (attivo sul sito entro un minuto)` : `${code} non era bloccato`)
    }
    default:
      throw new Error(`comando sconosciuto: ${command}\n\n${HELP}`)
  }
}

if (flags.help) {
  console.log(HELP)
}
else {
  let opened
  try {
    opened = await openStore()
    await run(opened.store)
  }
  catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 1
  }
  finally {
    await opened?.close()
  }
}
