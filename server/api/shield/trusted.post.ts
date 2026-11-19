import { parseTrustedAddress } from '../../../lib/ip.mjs'
import { bodyText, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { addTrusted } from '../../shield/core'
import { isTrustedProxy } from '../../shield/ip'

/**
 * Aggiunge un IP (o una rete, es. 93.49.90.0/24) ai fidati: non viene mai bloccato. I blocchi in corso
 * che ricadono lì dentro vengono tolti. Corpo: { address, note? }
 */
export default defineEventHandler(async (event) => {
  const admin = await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const address = parseTrustedAddress(bodyText(body, 'address', { max: 64, required: 'Inserisci l\'indirizzo IP' }))
  if (!address) {
    throw createError({ statusCode: 400, message: 'Indirizzo non valido: scrivi un IP (es. 93.49.90.147) o una rete non troppo ampia (es. 93.49.90.0/24)' })
  }
  if (isTrustedProxy(address.split('/')[0]!)) {
    throw createError({ statusCode: 400, message: 'È un indirizzo di Cloudflare o della rete interna: è già fidato' })
  }
  await addTrusted(address, bodyText(body, 'note', { max: 120 }) || null, admin)
  return { address }
})
