/**
 * Tipi dell'archivio dello scudo: dove si salvano blocchi, IP fidati e paesi bloccati.
 * Il server tiene tutto in memoria e allinea l'archivio ogni minuto; un archivio diverso
 * (Redis, PostgreSQL...) si scrive implementando ShieldStore.
 */

export interface StoredBan {
  /** IPv4, oppure la rete IPv6 /64 (es. 2001:0db8:0001:0002::/64). */
  key: string
  reason: string
  /** Fine del blocco, in millisecondi. */
  until: number
  /** Numero di blocchi dell'IP negli ultimi 30 giorni (la durata cresce a ogni recidiva). */
  count: number
  manual: boolean
  lastPath: string | null
  userAgent: string | null
}

export interface TrustedAddress {
  /** IP o rete CIDR. */
  address: string
  note: string | null
  createdBy: string | null
  /** Data ISO 8601. */
  createdAt: string
}

export interface BlockedCountry {
  /** Codice ISO 3166-1 alpha-2 (T1 = rete Tor). */
  code: string
  createdBy: string | null
  /** Data ISO 8601. */
  createdAt: string
  /** Data ISO 8601 dell'ultimo scaricamento degli intervalli: cambia a ogni aggiornamento. */
  updatedAt: string
}

export interface CountryRanges {
  /** Reti CIDR, una per voce. */
  v4: string[]
  v6: string[]
}

export interface ShieldStore {
  /** Nome mostrato nel pannello e nei log (es. "file", "mysql"). */
  readonly name: string
  /** Prepara l'archivio (cartelle, tabelle). Chiamata una volta, all'avvio. */
  init?(): Promise<void>
  listBans(): Promise<StoredBan[]>
  /** Crea o sostituisce il blocco della stessa chiave. */
  saveBan(ban: StoredBan): Promise<void>
  deleteBan(key: string): Promise<void>
  /** Cancella i blocchi finiti prima di questo istante (millisecondi). */
  purgeBans(before: number): Promise<void>
  listTrusted(): Promise<TrustedAddress[]>
  /** Aggiunge un IP fidato; se c'è già, ne aggiorna solo la nota. */
  saveTrusted(entry: TrustedAddress): Promise<void>
  deleteTrusted(address: string): Promise<void>
  listCountries(): Promise<BlockedCountry[]>
  getCountryRanges(code: string): Promise<CountryRanges | null>
  /** Blocca il paese; se è già bloccato aggiorna intervalli e updatedAt, tenendo createdBy e createdAt. */
  saveCountry(entry: BlockedCountry, ranges: CountryRanges): Promise<void>
  deleteCountry(code: string): Promise<void>
}
