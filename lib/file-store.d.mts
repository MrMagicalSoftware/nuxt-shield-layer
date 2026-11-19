import type { ShieldStore } from './types.mjs'

/** Archivio su file nella cartella indicata (creata se manca). */
export declare function createFileShieldStore(dir: string): ShieldStore & { readonly dir: string }
