<script setup lang="ts">
// Pannello dello scudo pronto all'uso. Si entra con NUXT_SHIELD_ADMIN_PASSWORD, oppure con il login del
// sito se il progetto usa authorize in configureShield(). Per metterlo nell'area admin del sito: <ShieldPanel />
definePageMeta({ layout: false })
useHead({ title: 'Sicurezza', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
</script>

<template>
  <main class="ns-page">
    <ShieldPanel />
  </main>
</template>

<style>
/* Pagina a sé: carattere di sistema, a meno che il sito non imposti --ns-font */
.ns-page {
  box-sizing: border-box; width: 100%; max-width: 72rem; margin: 0 auto; padding: 2rem 1rem 4rem;
  font-family: var(--ns-font, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
}
</style>
