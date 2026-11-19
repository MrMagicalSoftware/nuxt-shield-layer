import { shieldMode } from '../shield/config'
import { pruneOffenders, syncShield } from '../shield/core'
import { shieldLists } from '../shield/ip'

/**
 * Avvio dello scudo: carica blocchi, IP fidati e paesi dall'archivio e li riallinea ogni minuto
 * (modifiche fatte da altre istanze o dalla riga di comando).
 */
export default defineNitroPlugin((nitroApp) => {
  const mode = shieldMode()
  if (mode === 'off') {
    console.warn('[shield] scudo DISATTIVATO (NUXT_SHIELD_MODE=off)')
    return
  }
  if (mode === 'monitor') {
    console.warn('[shield] modalità monitor: i blocchi vengono solo scritti nel log, nessuna richiesta viene respinta')
  }
  // Configurazione non valida: meglio accorgersene all'avvio che alla prima richiesta
  shieldLists()

  const sync = async (first = false) => {
    try {
      const { active, store } = await syncShield()
      if (first) console.info(`[shield] attivo (${mode}, archivio: ${store}), ${active} IP bloccati`)
    }
    catch (error) {
      console.error('[shield] archivio non raggiungibile, blocchi solo in memoria:', (error as Error).message)
    }
  }

  // Al giro successivo: così i plugin del progetto hanno già chiamato configureShield() (archivio compreso)
  const firstSync = setTimeout(() => void sync(true), 0)
  const syncTimer = setInterval(() => void sync(), 60_000)
  const pruneTimer = setInterval(() => pruneOffenders(), 60_000)
  syncTimer.unref?.()
  pruneTimer.unref?.()

  nitroApp.hooks.hook('close', () => {
    clearTimeout(firstSync)
    clearInterval(syncTimer)
    clearInterval(pruneTimer)
  })
})
