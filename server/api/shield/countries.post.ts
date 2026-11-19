import { BLOCKABLE_COUNTRIES, countryName } from '../../../shared/countries'
import { adminIsProtected, bodyText, protectedCountries, readShieldBody } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'
import { blockCountry, requestCountry } from '../../shield/countries'
import { getClientIp } from '../../shield/ip'

/**
 * Blocca un paese: scarica i suoi intervalli IP (pochi secondi) e da quel momento le sue richieste
 * ricevono un 403. Se il paese è già bloccato, aggiorna gli intervalli. Non si può bloccare il paese da
 * cui ci si collega, a meno che il proprio IP non sia tra i fidati. Corpo: { code }
 */
export default defineEventHandler(async (event) => {
  const admin = await requireShieldAdmin(event)
  const body = await readShieldBody(event)
  const code = bodyText(body, 'code', { max: 2, required: 'Scegli un paese' }).toUpperCase()
  if (!BLOCKABLE_COUNTRIES.includes(code)) throw createError({ statusCode: 400, message: `Paese non disponibile: ${code}` })
  if (protectedCountries().includes(code)) {
    throw createError({ statusCode: 400, message: `Non puoi bloccare questo paese (${countryName(code)}): è tra i paesi protetti del sito` })
  }
  if (!adminIsProtected(event) && requestCountry(event, getClientIp(event)).code === code) {
    throw createError({ statusCode: 400, message: `Ti stai collegando proprio da questo paese (${countryName(code)}): aggiungi prima il tuo IP ai fidati, o resteresti fuori` })
  }
  try {
    await blockCountry(code, admin)
  }
  catch (error) {
    throw createError({ statusCode: 502, message: `Intervalli IP non scaricati: ${(error as Error).message}. Riprova tra poco.` })
  }
  return { code }
})
