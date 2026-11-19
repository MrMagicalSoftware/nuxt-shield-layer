/** Risposta di GET /api/shield, usata dal pannello. */

export interface ShieldBanView {
  ip: string
  reason: string
  /** Fine del blocco, ISO 8601 (oltre 5 anni = permanente). */
  until: string
  count: number
  manual: boolean
  path: string | null
  userAgent: string | null
}

export interface ShieldTrustedView {
  address: string
  note: string | null
  createdBy: string | null
  createdAt: string
}

export interface ShieldCountryView {
  code: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  v4Networks: number
  v6Networks: number
  v4Addresses: number
  /** Richieste respinte dall'ultimo riavvio (solo questa istanza). */
  rejected: number
}

export interface ShieldState {
  mode: 'block' | 'monitor' | 'off'
  auth: 'custom' | 'password' | 'none'
  admin: string
  /** Archivio in uso (file, mysql...). */
  store: string
  yourIp: string | null
  yourKey: string | null
  /** L'IP di chi usa il pannello è fidato (o è un proxy): non può essere bloccato. */
  protected: boolean
  tracked: number
  banned: number
  trusted: ShieldTrustedView[]
  countries: ShieldCountryView[]
  yourCountry: { code: string | null, source: 'cloudflare' | 'ranges' | null }
  protectedCountries: string[]
  total: number
  page: number
  perPage: number
  bans: ShieldBanView[]
}
