/**
 * Funzioni di nuxt-shield-layer per il server del progetto, disponibili ovunque senza import
 * (auto-import di Nitro). Esempio, in server/plugins/shield.ts:
 *
 *   export default defineNitroPlugin(() => {
 *     configureShield({
 *       store: createMysqlShieldStore(pool),
 *       authorize: async event => (await requireUserSession(event)).user.email,
 *       loginPaths: ['/api/auth/login'],
 *     })
 *   })
 */
export { configureShield, shieldMode } from '../shield/config'
export { getClientIp, isShieldTrusted, isTrustedProxy, viaCloudflare } from '../shield/ip'
export { isSearchBot, SHIELD_SCORES } from '../shield/rules'
export { shieldActiveBan, shieldBan, shieldPenalize, shieldScore, shieldUnban } from '../shield/core'
export { requireShieldAdmin } from '../shield/auth'
export { normalizeIp, shieldKey } from '../../lib/ip.mjs'
export { createFileShieldStore } from '../../lib/file-store.mjs'
export { createMysqlShieldStore } from '../../lib/mysql-store.mjs'
