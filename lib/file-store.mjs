import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Archivio su file, quello predefinito: nessun database, solo una cartella.
 *
 *   bans/<ip>.json           un file per IP bloccato (gli IPv6 per rete /64)
 *   trusted.json             IP fidati
 *   countries.json           paesi bloccati
 *   countries/<XX>-v4.txt    intervalli IP del paese, uno per riga (come su ipdeny.com)
 *   countries/<XX>-v6.txt
 *
 * Ogni scrittura è atomica (file temporaneo + rename): un riavvio a metà non lascia file rotti.
 * Per sbloccare un IP a mano basta cancellare il suo file in bans/: il server se ne accorge entro un minuto.
 * Più istanze che condividono la cartella vedono le modifiche delle altre entro un minuto.
 */

/** Nome del file di un blocco: "2001:0db8:0001:0002::/64" → "2001-0db8-0001-0002--_64". */
const banFile = key => `${String(key).toLowerCase().replace(/[^0-9a-f.:/]/g, '').replace(/:/g, '-').replace(/\//g, '_')}.json`
const codeOf = code => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2)
const lines = text => (text ? text.split(/\r?\n/).map(r => r.trim()).filter(Boolean) : [])

async function writeAtomic(file, data) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  }
  catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** File JSON assente = valore iniziale; file rovinato = errore (meglio fermarsi che sovrascriverlo con un elenco vuoto). */
async function readJson(file, fallback) {
  const text = await readText(file)
  return text === null || !text.trim() ? fallback : JSON.parse(text)
}

const json = value => `${JSON.stringify(value, null, 2)}\n`

async function removeFile(file) {
  try {
    await unlink(file)
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** @param {string} dir cartella dei dati (viene creata se manca) */
export function createFileShieldStore(dir) {
  const bansDir = join(dir, 'bans')
  const countriesDir = join(dir, 'countries')
  const trustedFile = join(dir, 'trusted.json')
  const countriesFile = join(dir, 'countries.json')
  const rangeFile = (code, family) => join(countriesDir, `${codeOf(code)}-v${family}.txt`)

  // Le modifiche di trusted.json e countries.json (leggi, cambia, scrivi) avvengono una alla volta
  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  async function readBans() {
    let names
    try {
      names = await readdir(bansDir)
    }
    catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const bans = await Promise.all(names.filter(n => n.endsWith('.json')).map(async (file) => {
      try {
        const b = JSON.parse(await readFile(join(bansDir, file), 'utf8'))
        const until = Date.parse(b.until)
        if (typeof b.key !== 'string' || !Number.isFinite(until)) return null
        return {
          file,
          ban: {
            key: b.key,
            reason: String(b.reason ?? ''),
            until,
            count: Number(b.count) || 1,
            manual: !!b.manual,
            lastPath: b.lastPath ?? null,
            userAgent: b.userAgent ?? null,
          },
        }
      }
      catch {
        // File appena cancellato da un'altra istanza, oppure modificato a mano in modo errato
        return null
      }
    }))
    return bans.filter(Boolean)
  }

  return {
    name: 'file',
    dir,

    async init() {
      await mkdir(bansDir, { recursive: true })
      await mkdir(countriesDir, { recursive: true })
    },

    async listBans() {
      return (await readBans()).map(b => b.ban)
    },

    async saveBan(ban) {
      await mkdir(bansDir, { recursive: true })
      await writeAtomic(join(bansDir, banFile(ban.key)), json({
        key: ban.key,
        reason: ban.reason,
        until: new Date(ban.until).toISOString(),
        count: ban.count,
        manual: ban.manual,
        lastPath: ban.lastPath,
        userAgent: ban.userAgent,
        updatedAt: new Date().toISOString(),
      }))
    },

    deleteBan: key => removeFile(join(bansDir, banFile(key))),

    async purgeBans(before) {
      for (const { file, ban } of await readBans()) {
        if (ban.until < before) await removeFile(join(bansDir, file))
      }
    },

    async listTrusted() {
      const list = await readJson(trustedFile, [])
      return Array.isArray(list) ? list : []
    },

    saveTrusted: entry => serial(async () => {
      const list = await readJson(trustedFile, [])
      const existing = list.find(t => t.address === entry.address)
      if (existing) existing.note = entry.note
      else list.unshift(entry)
      await mkdir(dir, { recursive: true })
      await writeAtomic(trustedFile, json(list))
    }),

    deleteTrusted: address => serial(async () => {
      const list = await readJson(trustedFile, [])
      const rest = list.filter(t => t.address !== address)
      if (rest.length !== list.length) await writeAtomic(trustedFile, json(rest))
    }),

    async listCountries() {
      const meta = await readJson(countriesFile, {})
      return Object.entries(meta)
        .map(([code, m]) => ({ code, createdBy: m.createdBy ?? null, createdAt: m.createdAt, updatedAt: m.updatedAt }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    },

    async getCountryRanges(code) {
      const meta = await readJson(countriesFile, {})
      if (!meta[codeOf(code)]) return null
      const [v4, v6] = await Promise.all([readText(rangeFile(code, 4)), readText(rangeFile(code, 6))])
      return { v4: lines(v4), v6: lines(v6) }
    },

    saveCountry: (entry, ranges) => serial(async () => {
      const code = codeOf(entry.code)
      await mkdir(countriesDir, { recursive: true })
      // Prima gli intervalli, poi l'elenco: chi legge l'elenco trova sempre gli intervalli
      await writeAtomic(rangeFile(code, 4), `${ranges.v4.join('\n')}\n`)
      await writeAtomic(rangeFile(code, 6), `${ranges.v6.join('\n')}\n`)
      const meta = await readJson(countriesFile, {})
      const prev = meta[code]
      meta[code] = {
        createdBy: prev ? prev.createdBy ?? null : entry.createdBy,
        createdAt: prev?.createdAt ?? entry.createdAt,
        updatedAt: entry.updatedAt,
      }
      await writeAtomic(countriesFile, json(meta))
    }),

    deleteCountry: code => serial(async () => {
      const c = codeOf(code)
      const meta = await readJson(countriesFile, {})
      if (meta[c]) {
        delete meta[c]
        await writeAtomic(countriesFile, json(meta))
      }
      await removeFile(rangeFile(c, 4))
      await removeFile(rangeFile(c, 6))
    }),
  }
}
