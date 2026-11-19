import { endShieldSession } from '../../shield/auth'

export default defineEventHandler((event) => {
  endShieldSession(event)
  return { ok: true }
})
