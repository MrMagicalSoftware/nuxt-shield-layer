<template>
  <main style="max-width: 40rem; margin: 3rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.6">
    <h1>nuxt-shield-layer</h1>
    <p>Sito di prova del layer. Il pannello è su <NuxtLink to="/admin/shield">/admin/shield</NuxtLink>.</p>
    <p>
      Lo scudo non vede l'IP dei visitatori con <code>nuxi dev</code>: per provarlo serve la build
      (<code>npm run build &amp;&amp; npm run preview</code>).
    </p>
  </main>
</template>
