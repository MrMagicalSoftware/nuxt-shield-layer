import { createFileShieldStore } from '../../lib/file-store.mjs'
import type { ShieldStore } from '../../lib/types.mjs'
import { shieldOptions, shieldRuntime } from './config'

/** Archivio in uso: quello passato a configureShield() oppure i file in NUXT_SHIELD_DATA_DIR. */
let fileStore: ShieldStore | undefined

export function shieldStore(): ShieldStore {
  const custom = shieldOptions().store
  if (custom) return custom
  fileStore ??= createFileShieldStore(shieldRuntime().dataDir)
  return fileStore
}

let initialized: ShieldStore | undefined
let initializing: Promise<void> | undefined

/** Archivio pronto all'uso: init() viene chiamata una sola volta (e ritentata se fallisce). */
export async function readyShieldStore(): Promise<ShieldStore> {
  const store = shieldStore()
  if (initialized !== store) {
    initialized = store
    initializing = Promise.resolve(store.init?.()).catch((error) => {
      initialized = undefined
      throw error
    })
  }
  await initializing
  return store
}
