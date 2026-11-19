import { readShieldBody } from '../../shield/admin'
import { assertShieldLoginAllowed, checkShieldPassword, shieldAuthMode, startShieldSession } from '../../shield/auth'

/** Accesso al pannello con NUXT_SHIELD_ADMIN_PASSWORD. Corpo: { password } */
export default defineEventHandler(async (event) => {
  if (shieldAuthMode() !== 'password') throw createError({ statusCode: 404, message: 'Accesso con password non attivo' })
  assertShieldLoginAllowed(event)
  const body = await readShieldBody(event)
  if (!checkShieldPassword(event, body.password)) throw createError({ statusCode: 401, message: 'Password non corretta' })
  startShieldSession(event)
  return { ok: true }
})
