import { bodyText, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { removeTrusted } from '../../shield/core'

/** Toglie un IP dai fidati: da quel momento lo scudo lo tratta come gli altri. Corpo: { address } */
export default defineEventHandler(async (event) => {
  await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const address = bodyText(body, 'address', { max: 64, required: 'Indirizzo mancante' }).toLowerCase()
  await removeTrusted(address)
  return { address }
})
