import { fileURLToPath } from 'node:url'

// Sito di prova: usa il layer esattamente come farebbe un progetto reale.
export default defineNuxtConfig({
  extends: ['..'],
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  nitro: { preset: 'node-server' },
  runtimeConfig: {
    // Sempre .playground/.data/shield, sia con `npm run dev` sia con la build
    shield: { dataDir: fileURLToPath(new URL('./.data/shield', import.meta.url)) },
  },
})
