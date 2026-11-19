/**
 * Archivio su MySQL / MariaDB, per i siti che hanno già un database: i blocchi valgono per tutte le
 * istanze e sopravvivono ai deploy senza volumi. Usa un pool di mysql2 (`mysql2/promise`), che si
 * passa così com'è o con una funzione che lo restituisce (utile se il pool si crea dopo l'avvio).
 *
 * Le tabelle (shield_ban, shield_fidato, shield_paese) si creano da sole al primo avvio.
 * Le date sono salvate in UTC.
 */

const toSql = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const fromSql = value => Date.parse(`${String(value).replace(' ', 'T')}Z`)
const toIso = value => new Date(fromSql(value)).toISOString()
/** Le date tornano sempre come testo, qualunque sia l'opzione dateStrings del pool. */
const date = column => `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s')`
const lines = text => (text ? String(text).split(/\r?\n/).map(r => r.trim()).filter(Boolean) : [])

export const SHIELD_MYSQL_TABLES = [
  `CREATE TABLE IF NOT EXISTS shield_ban (
    ip varchar(64) NOT NULL,
    reason varchar(255) NOT NULL,
    banned_until datetime NOT NULL,
    ban_count int NOT NULL DEFAULT 1,
    manual tinyint(1) NOT NULL DEFAULT 0,
    last_path varchar(255) DEFAULT NULL,
    user_agent varchar(255) DEFAULT NULL,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ip),
    KEY idx_shield_ban_until (banned_until)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS shield_fidato (
    indirizzo varchar(64) NOT NULL,
    nota varchar(120) DEFAULT NULL,
    creato_da varchar(120) DEFAULT NULL,
    creato_il datetime NOT NULL,
    PRIMARY KEY (indirizzo)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS shield_paese (
    codice char(2) NOT NULL,
    intervalli_v4 mediumtext NOT NULL,
    intervalli_v6 mediumtext NOT NULL,
    creato_da varchar(120) DEFAULT NULL,
    creato_il datetime NOT NULL,
    aggiornato_il datetime NOT NULL,
    PRIMARY KEY (codice)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]

/**
 * @param {object | (() => object | Promise<object>)} pool pool di mysql2/promise (o funzione che lo restituisce)
 * @param {{ createTables?: boolean }} [options] createTables: false se le tabelle le crea il progetto
 */
export function createMysqlShieldStore(pool, options = {}) {
  const createTables = options.createTables !== false

  async function query(sql, params = []) {
    const client = typeof pool === 'function' ? await pool() : pool
    const result = await client.query(sql, params)
    // mysql2 restituisce [righe, campi]; altri client direttamente le righe
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []
  }

  return {
    name: 'mysql',

    async init() {
      if (!createTables) return
      for (const ddl of SHIELD_MYSQL_TABLES) await query(ddl)
    },

    async listBans() {
      const rows = await query(`SELECT ip, reason, ${date('banned_until')} AS banned_until, ban_count, manual, last_path, user_agent FROM shield_ban`)
      return rows.map(r => ({
        key: r.ip,
        reason: r.reason,
        until: fromSql(r.banned_until),
        count: Number(r.ban_count),
        manual: !!Number(r.manual),
        lastPath: r.last_path ?? null,
        userAgent: r.user_agent ?? null,
      }))
    },

    async saveBan(ban) {
      await query(
        `INSERT INTO shield_ban (ip, reason, banned_until, ban_count, manual, last_path, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), banned_until = VALUES(banned_until), ban_count = VALUES(ban_count),
           manual = VALUES(manual), last_path = VALUES(last_path), user_agent = VALUES(user_agent)`,
        [ban.key, ban.reason, toSql(ban.until), ban.count, ban.manual ? 1 : 0, ban.lastPath, ban.userAgent],
      )
    },

    async deleteBan(key) {
      await query('DELETE FROM shield_ban WHERE ip = ?', [key])
    },

    async purgeBans(before) {
      await query('DELETE FROM shield_ban WHERE banned_until < ?', [toSql(before)])
    },

    async listTrusted() {
      const rows = await query(`SELECT indirizzo, nota, creato_da, ${date('creato_il')} AS creato_il FROM shield_fidato ORDER BY creato_il DESC`)
      return rows.map(r => ({ address: r.indirizzo, note: r.nota ?? null, createdBy: r.creato_da ?? null, createdAt: toIso(r.creato_il) }))
    },

    async saveTrusted(entry) {
      await query(
        'INSERT INTO shield_fidato (indirizzo, nota, creato_da, creato_il) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nota = VALUES(nota)',
        [entry.address, entry.note, entry.createdBy, toSql(Date.parse(entry.createdAt))],
      )
    },

    async deleteTrusted(address) {
      await query('DELETE FROM shield_fidato WHERE indirizzo = ?', [address])
    },

    async listCountries() {
      const rows = await query(`SELECT codice, creato_da, ${date('creato_il')} AS creato_il, ${date('aggiornato_il')} AS aggiornato_il FROM shield_paese ORDER BY creato_il DESC`)
      return rows.map(r => ({ code: r.codice, createdBy: r.creato_da ?? null, createdAt: toIso(r.creato_il), updatedAt: toIso(r.aggiornato_il) }))
    },

    async getCountryRanges(code) {
      const [row] = await query('SELECT intervalli_v4, intervalli_v6 FROM shield_paese WHERE codice = ?', [code])
      return row ? { v4: lines(row.intervalli_v4), v6: lines(row.intervalli_v6) } : null
    },

    async saveCountry(entry, ranges) {
      await query(
        `INSERT INTO shield_paese (codice, intervalli_v4, intervalli_v6, creato_da, creato_il, aggiornato_il) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE intervalli_v4 = VALUES(intervalli_v4), intervalli_v6 = VALUES(intervalli_v6), aggiornato_il = VALUES(aggiornato_il)`,
        [entry.code, ranges.v4.join('\n'), ranges.v6.join('\n'), entry.createdBy, toSql(Date.parse(entry.createdAt)), toSql(Date.parse(entry.updatedAt))],
      )
    },

    async deleteCountry(code) {
      await query('DELETE FROM shield_paese WHERE codice = ?', [code])
    },
  }
}
