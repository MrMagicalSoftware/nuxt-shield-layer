import { parseShieldKey, shieldKey } from '../../../lib/ip.mjs'
import { bodyText, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { banKey, PERMANENT_BAN_MINUTES } from '../../shield/core'
import { getClientIp, isShieldTrusted, isTrustedProxy } from '../../shield/ip'

/** Blocco manuale di un IP (o di una rete IPv6 /64). Corpo: { ip, hours (0 = permanente), reason? } */
export default defineEventHandler(async (event) => {
  const admin = await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const input = bodyText(body, 'ip', { max: 64, required: 'Inserisci l\'indirizzo IP' })
  const hours = Number(body.hours ?? 24)
  if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 365) throw createError({ statusCode: 400, message: 'Durata non valida' })
  const reason = bodyText(body, 'reason', { max: 200 })

  const key = parseShieldKey(input)
  if (!key) throw createError({ statusCode: 400, message: 'Indirizzo IP non valido' })
  const ip = key.replace('/64', '')
  if (isShieldTrusted(ip) || isTrustedProxy(ip)) {
    throw createError({ statusCode: 400, message: 'È un IP fidato o un proxy (es. Cloudflare): toglilo prima dagli IP fidati' })
  }
  const mine = getClientIp(event)
  if (mine && shieldKey(mine) === key) {
    throw createError({ statusCode: 400, message: 'Questo è il tuo indirizzo IP: non puoi bloccarti da solo' })
  }

  const minutes = hours === 0 ? PERMANENT_BAN_MINUTES : hours * 60
  const ban = banKey(key, { minutes, reason: `manuale (${admin})${reason ? `: ${reason}` : ''}`, manual: true })
  return { ip: ban.key, until: new Date(ban.until).toISOString() }
})
