// Esempio di configurazione dal progetto: qui solo una trappola in più e un percorso escluso dal blocco per paese.
export default defineNitroPlugin(() => {
  configureShield({
    honeypots: ['/scarica-tutto'],
    countryExempt: ['/api/webhook-pagamenti'],
  })
})
