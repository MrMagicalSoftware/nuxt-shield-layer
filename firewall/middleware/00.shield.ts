// Il firewall dello scudo. Sta in una cartella a parte (firewall/) perché il layer la mette per prima tra
// quelle da cui Nitro prende i middleware: così gira prima dei middleware del progetto (nuxt.config.ts).
export { default } from '../../server/shield/firewall'
