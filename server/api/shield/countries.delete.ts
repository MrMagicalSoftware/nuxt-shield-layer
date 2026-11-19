import { bodyText, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { unblockCountry } from '../../shield/countries'

/** Sblocca un paese: le sue richieste tornano ammesse subito su questa istanza, sulle altre entro un minuto. Corpo: { code } */
export default defineEventHandler(async (event) => {
  await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const code = bodyText(body, 'code', { max: 2, required: 'Paese mancante' }).toUpperCase()
  await unblockCountry(code)
  return { code }
})
