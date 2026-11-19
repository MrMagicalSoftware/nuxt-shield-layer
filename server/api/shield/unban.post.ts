import { parseShieldKey } from '../../../lib/ip.mjs'
import { bodyText, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { unbanKey } from '../../shield/core'

/** Sblocca un IP e ne azzera la storia (es. falso positivo). Corpo: { ip } */
export default defineEventHandler(async (event) => {
  await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const key = parseShieldKey(bodyText(body, 'ip', { max: 64, required: 'Inserisci l\'indirizzo IP' }))
  if (!key) throw createError({ statusCode: 400, message: 'Indirizzo IP non valido' })
  await unbanKey(key)
  return { ip: key }
})
