<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { BLOCKABLE_COUNTRIES, countryFlag, countryName, TOR_NETWORK } from '../../shared/countries'
import type { ShieldBanView, ShieldCountryView, ShieldState, ShieldTrustedView } from '../../shared/types'

/**
 * Pannello dello scudo: stato, IP fidati, blocco per paese, blocco e sblocco degli IP.
 * Funziona da solo (pagina /admin/shield del layer) o dentro l'area admin del progetto:
 *
 *   <ShieldPanel @unauthorized="vaiAlLogin()" />
 *
 * La grafica usa le classi .ns-* e le variabili CSS --ns-*; con Nuxt UI prende i colori del tema.
 */
const props = withDefaults(defineProps<{
  /** Indirizzo delle API dello scudo. */
  api?: string
}>(), { api: '/api/shield' })

const emit = defineEmits<{
  /** Le API hanno risposto 401 e il login non è quello con password del pannello (lo gestisce il sito). */
  unauthorized: []
}>()

const state = ref<ShieldState | null>(null)
const loadError = ref('')
const loading = ref(false)
const needsLogin = ref(false)
const busy = ref(false)

// --- Avvisi ------------------------------------------------------------------------------------------

interface Toast { id: number, title: string, description?: string, kind: 'success' | 'error' }
const toasts = ref<Toast[]>([])
let toastId = 0
const toastTimers = new Set<ReturnType<typeof setTimeout>>()

function notify(title: string, kind: Toast['kind'] = 'success', description?: string) {
  const id = ++toastId
  toasts.value.push({ id, title, kind, description })
  const timer = setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
    toastTimers.delete(timer)
  }, kind === 'error' ? 7000 : 4000)
  toastTimers.add(timer)
}

function errorInfo(error: unknown) {
  const e = error as { statusCode?: number, status?: number, message?: string, data?: { message?: string, statusMessage?: string, data?: { login?: boolean } } }
  return {
    status: e.statusCode ?? e.status,
    message: e.data?.message || e.data?.statusMessage || e.message || 'Si è verificato un errore, riprova',
    login: !!e.data?.data?.login,
  }
}

/** 401: login con password del pannello oppure, se l'accesso lo gestisce il sito, avviso al sito. */
function handleUnauthorized(info: ReturnType<typeof errorInfo>) {
  if (info.status !== 401) return false
  if (info.login) {
    needsLogin.value = true
    state.value = null
  }
  else emit('unauthorized')
  return true
}

// --- Caricamento, ricerca e pagine -------------------------------------------------------------------

const search = ref('')
const page = ref(1)
let requestId = 0

async function load() {
  const id = ++requestId
  loading.value = true
  try {
    const data = await $fetch<ShieldState>(props.api, { query: { q: search.value.trim() || undefined, page: page.value } })
    if (id !== requestId) return
    state.value = data
    loadError.value = ''
    needsLogin.value = false
  }
  catch (error) {
    if (id !== requestId) return
    const info = errorInfo(error)
    if (handleUnauthorized(info) && info.login) return
    loadError.value = info.message
  }
  finally {
    if (id === requestId) loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (page.value !== 1) page.value = 1
    else void load()
  }, 300)
})
watch(page, () => void load())
onMounted(load)
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  for (const timer of toastTimers) clearTimeout(timer)
})

const pages = computed(() => (state.value ? Math.max(1, Math.ceil(state.value.total / state.value.perPage)) : 1))

async function call(path: string, body: Record<string, unknown>, ok: string, method: 'POST' | 'DELETE' = 'POST') {
  busy.value = true
  try {
    await $fetch(`${props.api}${path}`, { method, body })
    notify(ok)
    await load()
    return true
  }
  catch (error) {
    const info = errorInfo(error)
    if (!handleUnauthorized(info)) notify('Non è stato possibile', 'error', info.message)
    return false
  }
  finally {
    busy.value = false
  }
}

// --- Login con la password del pannello ----------------------------------------------------------

const password = ref('')
const loginError = ref('')

async function login() {
  busy.value = true
  loginError.value = ''
  try {
    await $fetch(`${props.api}/login`, { method: 'POST', body: { password: password.value } })
    password.value = ''
    await load()
  }
  catch (error) {
    loginError.value = errorInfo(error).message
  }
  finally {
    busy.value = false
  }
}

async function logout() {
  await $fetch(`${props.api}/logout`, { method: 'POST' }).catch(() => {})
  state.value = null
  needsLogin.value = true
}

// --- IP fidati ---------------------------------------------------------------------------------------

const trustedForm = reactive({ address: '', note: '' })

async function addTrusted(address = trustedForm.address, note = trustedForm.note) {
  if (await call('/trusted', { address, note: note || undefined }, `${address} aggiunto agli IP fidati`)) {
    Object.assign(trustedForm, { address: '', note: '' })
  }
}

const removeTrusted = (t: ShieldTrustedView) => call('/trusted', { address: t.address }, `${t.address} tolto dagli IP fidati`, 'DELETE')

// --- Blocco e sblocco degli IP ----------------------------------------------------------------------

const durations = [
  { label: '1 ora', value: 1 },
  { label: '24 ore', value: 24 },
  { label: '7 giorni', value: 24 * 7 },
  { label: '30 giorni', value: 24 * 30 },
  { label: 'Permanente', value: 0 },
]
const banForm = reactive({ ip: '', hours: 24, reason: '' })

async function ban() {
  if (await call('/ban', { ip: banForm.ip, hours: banForm.hours, reason: banForm.reason || undefined }, `IP ${banForm.ip} bloccato`)) {
    Object.assign(banForm, { ip: '', reason: '' })
  }
}

const unbanInput = ref('')
const unban = (b: ShieldBanView) => call('/unban', { ip: b.ip }, `IP ${b.ip} sbloccato`)

async function unbanTyped() {
  if (await call('/unban', { ip: unbanInput.value }, `IP ${unbanInput.value} sbloccato`)) unbanInput.value = ''
}

// --- Paesi ---------------------------------------------------------------------------------------------

const countryLabel = (code: string) => `${countryFlag(code)} ${countryName(code)}`.trim()
const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const countryOptions = computed(() => {
  const excluded = new Set([...(state.value?.countries.map(c => c.code) ?? []), ...(state.value?.protectedCountries ?? [])])
  return BLOCKABLE_COUNTRIES
    .filter(code => !excluded.has(code))
    .map(code => ({
      code,
      name: code === TOR_NETWORK ? 'Rete Tor (riconosciuta da Cloudflare)' : countryName(code),
      label: code === TOR_NETWORK ? 'Rete Tor (riconosciuta da Cloudflare)' : countryLabel(code),
      search: normalize(`${countryName(code)} ${code}`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'))
})

const countryQuery = ref('')
const countryCode = ref('')
const comboOpen = ref(false)
const comboActive = ref(0)
const comboList = ref<HTMLElement | null>(null)

const selectedLabel = computed(() => countryOptions.value.find(o => o.code === countryCode.value)?.label ?? '')
const filteredCountries = computed(() => {
  const q = normalize(countryQuery.value.trim())
  if (!q || countryQuery.value === selectedLabel.value) return countryOptions.value
  return countryOptions.value.filter(o => o.search.includes(q))
})

watch(filteredCountries, () => {
  comboActive.value = 0
})

function onCountryInput() {
  countryCode.value = ''
  comboOpen.value = true
}

function moveCountry(step: number) {
  if (!comboOpen.value) {
    comboOpen.value = true
    return
  }
  const n = filteredCountries.value.length
  if (!n) return
  comboActive.value = (comboActive.value + step + n) % n
  void nextTick(() => comboList.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
}

function pickCountry(code: string | undefined) {
  if (!code) return
  countryCode.value = code
  countryQuery.value = countryOptions.value.find(o => o.code === code)?.label ?? code
  comboOpen.value = false
}

const countryInProgress = ref('')

async function blockCountry() {
  const code = countryCode.value
  if (!code) return
  countryInProgress.value = code
  const ok = await call('/countries', { code }, `Paese bloccato: ${countryName(code)}`)
  countryInProgress.value = ''
  if (ok) {
    countryCode.value = ''
    countryQuery.value = ''
  }
}

async function refreshCountry(code: string) {
  countryInProgress.value = code
  await call('/countries', { code }, `Intervalli IP aggiornati: ${countryName(code)}`)
  countryInProgress.value = ''
}

const unblockCountry = (c: ShieldCountryView) => call('/countries', { code: c.code }, `Paese sbloccato: ${countryName(c.code)}`, 'DELETE')

// --- Formati ------------------------------------------------------------------------------------------

const num = (n: number) => n.toLocaleString('it-IT')
const day = (iso: string) => new Date(iso).toLocaleDateString('it-IT')
const until = (iso: string) => {
  const d = new Date(iso)
  return d.getFullYear() > new Date().getFullYear() + 5 ? 'permanente' : d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
}
const addresses = (n: number) => (n >= 1_000_000
  ? `${(n / 1_000_000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} milioni di indirizzi`
  : `${num(n)} indirizzi`)

const modeInfo = computed(() => ({
  block: { label: 'Attivo', tone: 'success', text: 'Gli IP sospetti vengono bloccati automaticamente.' },
  monitor: { label: 'Solo monitoraggio', tone: 'warning', text: 'I blocchi vengono solo scritti nel log del server: nessuna richiesta viene respinta.' },
  off: { label: 'Disattivato', tone: 'error', text: 'Lo scudo è spento (NUXT_SHIELD_MODE=off).' },
}[state.value?.mode ?? 'block']))

const yourIpHint = computed(() => {
  const s = state.value
  if (!s?.yourIp) return 'IP non disponibile (succede con nuxi dev): in queste condizioni lo scudo non blocca nessuno.'
  return s.protected ? 'Tra gli IP fidati: non può essere bloccato.' : 'Aggiungilo agli IP fidati per non rischiare di bloccarti.'
})
</script>

<template>
  <section class="ns">
    <header class="ns-head">
      <div>
        <p class="ns-eyebrow">Sicurezza</p>
        <h2 class="ns-title">Protezione anti-scanning</h2>
      </div>
      <button v-if="state?.auth === 'password'" type="button" class="ns-btn" data-variant="ghost" data-size="sm" @click="logout">
        Esci
      </button>
    </header>

    <form v-if="needsLogin" class="ns-card ns-login" @submit.prevent="login">
      <p class="ns-card-title">Accesso al pannello</p>
      <label class="ns-field">
        <span>Password</span>
        <input v-model="password" class="ns-input" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="loginError" class="ns-error-text">{{ loginError }}</p>
      <button type="submit" class="ns-btn" :disabled="busy || !password" :aria-busy="busy">Entra</button>
    </form>

    <div v-else-if="loadError && !state" class="ns-alert" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" class="ns-btn" data-variant="soft" data-size="sm" @click="load">Riprova</button>
    </div>

    <p v-else-if="!state" class="ns-hint">Caricamento…</p>

    <template v-else>
      <div class="ns-stats">
        <div class="ns-card">
          <p class="ns-label">Stato</p>
          <span class="ns-badge" :data-tone="modeInfo.tone">{{ modeInfo.label }}</span>
          <p class="ns-hint ns-mt">{{ modeInfo.text }}</p>
        </div>
        <div class="ns-card">
          <p class="ns-label">IP bloccati ora</p>
          <p class="ns-number">{{ num(state.banned) }}</p>
          <p class="ns-hint">{{ num(state.tracked) }} IP osservati in memoria · archivio: {{ state.store }}</p>
        </div>
        <div class="ns-card">
          <p class="ns-label">Il tuo IP</p>
          <code class="ns-code">{{ state.yourIp ?? 'non rilevato' }}</code>
          <p class="ns-hint ns-mt">{{ yourIpHint }}</p>
          <button
            v-if="!state.protected && state.yourIp" type="button" class="ns-btn ns-mt" data-variant="soft" data-size="sm"
            :disabled="busy" @click="addTrusted(state.yourIp, 'Il mio IP')"
          >
            Aggiungi il mio IP ai fidati
          </button>
        </div>
      </div>

      <div class="ns-card">
        <div class="ns-card-head">
          <p class="ns-card-title">IP fidati</p>
          <p class="ns-hint">Non vengono mai bloccati: ufficio, casa, clienti e partner. Va bene anche una rete, es. 93.49.90.0/24.</p>
        </div>
        <form class="ns-form" @submit.prevent="addTrusted()">
          <label class="ns-field">
            <span>IP o rete</span>
            <input v-model="trustedForm.address" class="ns-input" placeholder="es. 93.49.90.147" required>
          </label>
          <label class="ns-field">
            <span>Nota (facoltativa)</span>
            <input v-model="trustedForm.note" class="ns-input" maxlength="120" placeholder="es. Ufficio">
          </label>
          <button type="submit" class="ns-btn" :disabled="busy">Aggiungi</button>
        </form>
        <ul v-if="state.trusted.length" class="ns-list">
          <li v-for="t in state.trusted" :key="t.address">
            <div>
              <code class="ns-code">{{ t.address }}</code>
              <span v-if="t.note" class="ns-note">{{ t.note }}</span>
              <p class="ns-hint">Aggiunto il {{ day(t.createdAt) }}<template v-if="t.createdBy"> da {{ t.createdBy }}</template></p>
            </div>
            <button type="button" class="ns-btn" data-variant="ghost" data-size="sm" :disabled="busy" @click="removeTrusted(t)">Togli</button>
          </li>
        </ul>
        <p v-else class="ns-hint ns-mt-lg">Nessun IP fidato.</p>
      </div>

      <div class="ns-card">
        <div class="ns-card-head">
          <p class="ns-card-title">Blocco per paese</p>
          <p class="ns-hint">
            Chi si collega da un paese bloccato riceve un errore 403. Passano comunque gli IP fidati, i motori di ricerca
            verificati (Google, Bing…) e i percorsi esclusi dal sito (es. le notifiche dei pagamenti). Il paese lo indica
            Cloudflare; per le richieste che arrivano senza Cloudflare si usano gli intervalli IP del paese (ipdeny.com),
            aggiornati ogni settimana.
          </p>
        </div>
        <p>
          Ti colleghi da:
          <strong v-if="state.yourCountry.code" class="ns-strong">{{ countryLabel(state.yourCountry.code) }}</strong>
          <span v-else class="ns-muted">paese non rilevato (la richiesta non è passata da Cloudflare)</span>
        </p>
        <form class="ns-form ns-mt-lg" @submit.prevent="blockCountry">
          <label class="ns-field ns-field-wide">
            <span>Paese</span>
            <div class="ns-combo">
              <input
                v-model="countryQuery" class="ns-input" placeholder="Cerca un paese…" autocomplete="off"
                role="combobox" aria-autocomplete="list" aria-controls="ns-country-list" :aria-expanded="comboOpen"
                @input="onCountryInput" @focus="comboOpen = true" @blur="comboOpen = false"
                @keydown.down.prevent="moveCountry(1)" @keydown.up.prevent="moveCountry(-1)"
                @keydown.enter.prevent="comboOpen ? pickCountry(filteredCountries[comboActive]?.code) : blockCountry()"
                @keydown.esc="comboOpen = false"
              >
              <!-- mousedown.prevent: cliccando l'elenco (anche la barra di scorrimento) il campo non perde il focus -->
              <ul v-if="comboOpen" id="ns-country-list" ref="comboList" class="ns-combo-list" role="listbox" @mousedown.prevent>
                <li
                  v-for="(o, i) in filteredCountries" :key="o.code" role="option" :aria-selected="o.code === countryCode"
                  :data-active="i === comboActive" @click="pickCountry(o.code)" @mousemove="comboActive = i"
                >
                  {{ o.label }}
                </li>
                <li v-if="!filteredCountries.length" class="ns-combo-empty">Nessun paese trovato</li>
              </ul>
            </div>
          </label>
          <button type="submit" class="ns-btn" data-variant="danger" :disabled="!countryCode || busy" :aria-busy="!!countryInProgress && countryInProgress === countryCode">
            Blocca paese
          </button>
        </form>
        <p class="ns-hint ns-mt">
          Attenzione ai paesi con molti data center (Stati Uniti, Irlanda, Paesi Bassi, Germania): da lì passano anche servizi usati dal sito.
        </p>
        <ul v-if="state.countries.length" class="ns-list">
          <li v-for="c in state.countries" :key="c.code">
            <div>
              <span class="ns-strong">{{ countryLabel(c.code) }}</span>
              <code class="ns-code ns-muted ns-ml">{{ c.code }}</code>
              <p class="ns-hint">
                <template v-if="c.code === TOR_NETWORK">Riconosciuta solo per le richieste che passano da Cloudflare</template>
                <template v-else>{{ num(c.v4Networks) }} reti IPv4 ({{ addresses(c.v4Addresses) }}), {{ num(c.v6Networks) }} IPv6 · intervalli del {{ day(c.updatedAt) }}</template>
              </p>
              <p class="ns-hint">
                Bloccato il {{ day(c.createdAt) }}<template v-if="c.createdBy"> da {{ c.createdBy }}</template>
                · {{ num(c.rejected) }} richieste respinte dall'ultimo riavvio
              </p>
            </div>
            <div class="ns-actions">
              <button
                v-if="c.code !== TOR_NETWORK" type="button" class="ns-btn" data-variant="ghost" data-size="sm"
                :disabled="busy" :aria-busy="countryInProgress === c.code" @click="refreshCountry(c.code)"
              >
                Aggiorna
              </button>
              <button type="button" class="ns-btn" data-variant="soft" data-size="sm" :disabled="busy" @click="unblockCountry(c)">Sblocca</button>
            </div>
          </li>
        </ul>
        <p v-else class="ns-hint ns-mt-lg">Nessun paese bloccato.</p>
      </div>

      <div class="ns-card">
        <form class="ns-form" @submit.prevent="unbanTyped">
          <label class="ns-field ns-field-wide">
            <span>Sblocca un IP</span>
            <input v-model="unbanInput" class="ns-input" placeholder="es. 93.49.90.147" required>
          </label>
          <button type="submit" class="ns-btn" data-variant="soft" :disabled="busy">Sblocca</button>
        </form>
        <p class="ns-hint ns-mt">Anche se non lo trovi nell'elenco: toglie il blocco e azzera la sua storia.</p>
      </div>

      <div class="ns-card">
        <form class="ns-form" @submit.prevent="ban">
          <label class="ns-field">
            <span>Blocca un IP</span>
            <input v-model="banForm.ip" class="ns-input" placeholder="es. 203.0.113.7 o 2001:db8:1:2::/64" required>
          </label>
          <label class="ns-field ns-field-narrow">
            <span>Durata</span>
            <select v-model.number="banForm.hours" class="ns-input">
              <option v-for="d in durations" :key="d.value" :value="d.value">{{ d.label }}</option>
            </select>
          </label>
          <label class="ns-field">
            <span>Motivo (facoltativo)</span>
            <input v-model="banForm.reason" class="ns-input" maxlength="200">
          </label>
          <button type="submit" class="ns-btn" data-variant="danger" :disabled="busy">Blocca</button>
        </form>
      </div>

      <div class="ns-table-head">
        <p class="ns-card-title">
          IP bloccati <span class="ns-muted ns-normal">({{ num(state.total) }}<template v-if="search.trim()"> trovati su {{ num(state.banned) }}</template>)</span>
        </p>
        <input v-model="search" type="search" class="ns-input ns-search" placeholder="IP, motivo, percorso, user agent" aria-label="Cerca tra gli IP bloccati">
      </div>
      <div class="ns-table-wrap" :data-loading="loading">
        <table class="ns-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Motivo</th>
              <th>Fino a</th>
              <th>N.</th>
              <th><span class="ns-sr">Azioni</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in state.bans" :key="b.ip">
              <td class="ns-nowrap">
                <code class="ns-code">{{ b.ip }}</code>
                <span v-if="b.manual" class="ns-badge ns-ml" data-tone="neutral">manuale</span>
              </td>
              <td>
                <p class="ns-truncate" :title="b.reason">{{ b.reason }}</p>
                <p v-if="b.userAgent" class="ns-truncate ns-hint" :title="b.userAgent">{{ b.userAgent }}</p>
              </td>
              <td class="ns-nowrap">{{ until(b.until) }}</td>
              <td>{{ b.count }}</td>
              <td class="ns-right">
                <button type="button" class="ns-btn" data-variant="soft" data-size="sm" :disabled="busy" @click="unban(b)">Sblocca</button>
              </td>
            </tr>
            <tr v-if="!state.bans.length">
              <td colspan="5" class="ns-empty">{{ search.trim() ? 'Nessun IP bloccato corrisponde alla ricerca.' : 'Nessun IP bloccato.' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="state.total > state.perPage" class="ns-pager">
        <p class="ns-hint">
          {{ num((state.page - 1) * state.perPage + 1) }}–{{ num(Math.min(state.page * state.perPage, state.total)) }} di {{ num(state.total) }}
        </p>
        <div class="ns-actions">
          <button type="button" class="ns-btn" data-variant="soft" data-size="sm" :disabled="page <= 1 || loading" @click="page--">‹ Precedenti</button>
          <span class="ns-hint">Pagina {{ page }} di {{ pages }}</span>
          <button type="button" class="ns-btn" data-variant="soft" data-size="sm" :disabled="page >= pages || loading" @click="page++">Successivi ›</button>
        </div>
      </div>
    </template>

    <div class="ns-toasts" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="ns-toast" :data-kind="t.kind" role="status">
        <p class="ns-strong">{{ t.title }}</p>
        <p v-if="t.description" class="ns-hint">{{ t.description }}</p>
      </div>
    </div>
  </section>
</template>

<style>
/* Colori: quelli di Nuxt UI se il sito lo usa (tema chiaro e scuro), altrimenti i valori qui sotto.
   Per adattarli al sito basta ridefinire le variabili --ns-* nel CSS del progetto. */
.ns {
  --ns-bg: var(--ui-bg, #ffffff);
  --ns-bg-muted: var(--ui-bg-muted, #f8fafc);
  --ns-bg-elevated: var(--ui-bg-elevated, #f1f5f9);
  --ns-text: var(--ui-text, #334155);
  --ns-text-strong: var(--ui-text-highlighted, #0f172a);
  --ns-text-muted: var(--ui-text-muted, #64748b);
  --ns-border: var(--ui-border, #e2e8f0);
  --ns-border-strong: var(--ui-border-accented, #cbd5e1);
  --ns-accent: var(--ui-primary, #2563eb);
  --ns-on-accent: var(--ui-text-inverted, #ffffff);
  --ns-danger: var(--ui-error, #dc2626);
  --ns-success: var(--ui-success, #16a34a);
  --ns-warning: var(--ui-warning, #d97706);
  --ns-radius: calc(var(--ui-radius, 0.25rem) * 2);
  --ns-radius-sm: calc(var(--ui-radius, 0.25rem) * 1.5);
  --ns-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  display: flex;
  flex-direction: column;
  gap: 1rem;
  font-family: var(--ns-font, inherit);
  color: var(--ns-text);
  font-size: 0.875rem;
  line-height: 1.5;
}
.ns *, .ns *::before, .ns *::after { box-sizing: border-box; }
.ns p, .ns h2, .ns ul { margin: 0; }

.ns-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }
.ns-eyebrow { font-size: 0.875rem; color: var(--ns-text-muted); }
.ns-title { font-size: 1.5rem; line-height: 2rem; font-weight: 700; color: var(--ns-text-strong); }

.ns-card {
  background: var(--ns-bg);
  border: 1px solid var(--ns-border);
  border-radius: var(--ns-radius);
  padding: 1rem;
  min-width: 0;
}
@media (min-width: 640px) { .ns-card { padding: 1.25rem 1.5rem; } }
.ns-card-head { margin: -1rem -1rem 1rem; padding: 0.875rem 1rem; border-bottom: 1px solid var(--ns-border); }
@media (min-width: 640px) { .ns-card-head { margin: -1.25rem -1.5rem 1.25rem; padding: 1rem 1.5rem; } }
.ns-card-title { font-weight: 600; color: var(--ns-text-strong); }

.ns-stats { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.ns-label { font-size: 0.75rem; color: var(--ns-text-muted); }
.ns-number { font-size: 1.5rem; line-height: 2rem; font-weight: 700; color: var(--ns-text-strong); }
.ns-hint { font-size: 0.75rem; color: var(--ns-text-muted); }
.ns-muted { color: var(--ns-text-muted); }
.ns-strong { font-weight: 600; color: var(--ns-text-strong); }
.ns-normal { font-weight: 400; }
.ns-note { margin-left: 0.5rem; }
.ns-code { font-family: var(--ns-font-mono); font-size: 0.8125rem; overflow-wrap: anywhere; }
.ns-mt { margin-top: 0.5rem !important; }
.ns-mt-lg { margin-top: 1rem !important; }
.ns-ml { margin-left: 0.5rem; }
.ns-error-text { color: var(--ns-danger); font-size: 0.8125rem; }

.ns-badge {
  display: inline-flex; align-items: center; margin-top: 0.25rem; padding: 0.125rem 0.5rem;
  border-radius: var(--ns-radius-sm); font-size: 0.75rem; font-weight: 500; line-height: 1rem; vertical-align: middle;
}
.ns-badge[data-tone="success"] { color: var(--ns-success); background: color-mix(in oklab, var(--ns-success) 12%, transparent); }
.ns-badge[data-tone="warning"] { color: var(--ns-warning); background: color-mix(in oklab, var(--ns-warning) 14%, transparent); }
.ns-badge[data-tone="error"] { color: var(--ns-danger); background: color-mix(in oklab, var(--ns-danger) 12%, transparent); }
.ns-badge[data-tone="neutral"] { margin-top: 0; color: var(--ns-text); background: var(--ns-bg-elevated); }

.ns-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; }
.ns-field { display: flex; flex: 1 1 12rem; flex-direction: column; gap: 0.25rem; min-width: 0; }
.ns-field > span { font-weight: 500; color: var(--ns-text-strong); }
.ns-field-wide { flex-basis: 16rem; }
.ns-field-narrow { flex: 0 1 9rem; min-width: 8rem; }
.ns-input {
  width: 100%; margin: 0; padding: 0.375rem 0.625rem;
  font: inherit; font-size: 0.875rem; line-height: 1.25rem; color: var(--ns-text-strong);
  background: var(--ns-bg); border: 1px solid var(--ns-border-strong); border-radius: var(--ns-radius-sm);
}
.ns-input::placeholder { color: var(--ns-text-muted); opacity: 1; }
.ns-input:focus { outline: none; border-color: var(--ns-accent); box-shadow: 0 0 0 1px var(--ns-accent); }
select.ns-input { padding-right: 1.75rem; }
.ns-search { width: 18rem; max-width: 100%; }

.ns-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem;
  margin: 0; padding: 0.375rem 0.75rem; font: inherit; font-size: 0.875rem; font-weight: 500; line-height: 1.25rem;
  white-space: nowrap; cursor: pointer; color: var(--ns-on-accent); background: var(--ns-accent);
  border: 1px solid transparent; border-radius: var(--ns-radius-sm); transition: background-color 0.15s, opacity 0.15s;
}
.ns-btn:hover:not(:disabled) { background: color-mix(in oklab, var(--ns-accent) 86%, #000); }
.ns-btn:focus-visible { outline: 2px solid var(--ns-accent); outline-offset: 2px; }
.ns-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.ns-btn[data-variant="danger"] { background: var(--ns-danger); }
.ns-btn[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in oklab, var(--ns-danger) 86%, #000); }
.ns-btn[data-variant="soft"] { color: var(--ns-text-strong); background: var(--ns-bg-elevated); border-color: var(--ns-border); }
.ns-btn[data-variant="soft"]:hover:not(:disabled) { background: color-mix(in oklab, var(--ns-bg-elevated) 85%, var(--ns-text-strong)); }
.ns-btn[data-variant="ghost"] { color: var(--ns-text); background: transparent; }
.ns-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--ns-bg-elevated); }
.ns-btn[data-size="sm"] { padding: 0.25rem 0.5rem; font-size: 0.75rem; line-height: 1rem; }
.ns-btn[aria-busy="true"]::before {
  content: ''; width: 0.8em; height: 0.8em; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; animation: ns-spin 0.7s linear infinite;
}
@keyframes ns-spin { to { transform: rotate(360deg); } }

.ns-list { list-style: none; margin-top: 1rem; padding: 0; }
.ns-list > li {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem;
  padding: 0.5rem 0; border-top: 1px solid var(--ns-border);
}
.ns-list > li:first-child { border-top: 0; }
.ns-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; }

.ns-combo { position: relative; }
.ns-combo-list {
  position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; max-height: 16rem; overflow-y: auto;
  margin: 0; padding: 0.25rem; list-style: none; background: var(--ns-bg); border: 1px solid var(--ns-border);
  border-radius: var(--ns-radius-sm); box-shadow: 0 10px 30px rgb(0 0 0 / 0.14);
}
.ns-combo-list > li { padding: 0.375rem 0.5rem; border-radius: calc(var(--ns-radius-sm) - 2px); color: var(--ns-text-strong); cursor: pointer; }
.ns-combo-list > li[data-active="true"] { background: var(--ns-bg-elevated); }
.ns-combo-list > li.ns-combo-empty { color: var(--ns-text-muted); cursor: default; }

.ns-table-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
.ns-table-wrap { position: relative; overflow-x: auto; border: 1px solid var(--ns-border); border-radius: var(--ns-radius); background: var(--ns-bg); transition: opacity 0.15s; }
.ns-table-wrap[data-loading="true"] { opacity: 0.6; }
.ns-table { width: 100%; border-collapse: collapse; }
.ns-table th {
  padding: 0.625rem 0.875rem; text-align: left; font-weight: 600; white-space: nowrap; color: var(--ns-text-strong);
  border-bottom: 1px solid var(--ns-border);
}
.ns-table td { padding: 0.625rem 0.875rem; vertical-align: top; border-top: 1px solid var(--ns-border); }
.ns-table tbody tr:first-child td { border-top: 0; }
.ns-nowrap { white-space: nowrap; }
.ns-right { text-align: right; }
.ns-truncate { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) { .ns-truncate { max-width: 14rem; } }
.ns-empty { padding: 1.5rem 0.875rem !important; text-align: center; color: var(--ns-text-muted); }
.ns-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ns-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }

.ns-alert {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.75rem 1rem; color: var(--ns-danger); border-radius: var(--ns-radius);
  background: color-mix(in oklab, var(--ns-danger) 9%, var(--ns-bg));
  border: 1px solid color-mix(in oklab, var(--ns-danger) 25%, transparent);
}
.ns-login { display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem; }
.ns-login .ns-field { flex: none; }
.ns-login .ns-btn { align-self: flex-start; }

.ns-toasts {
  position: fixed; z-index: 1000; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem;
  width: min(22rem, calc(100vw - 2rem)); pointer-events: none;
}
.ns-toast {
  padding: 0.625rem 0.875rem; pointer-events: auto; background: var(--ns-bg); border: 1px solid var(--ns-border);
  border-left: 3px solid var(--ns-success); border-radius: var(--ns-radius); box-shadow: 0 10px 30px rgb(0 0 0 / 0.14);
}
.ns-toast[data-kind="error"] { border-left-color: var(--ns-danger); }
</style>
