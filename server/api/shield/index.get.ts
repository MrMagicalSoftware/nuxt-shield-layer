import { shieldState } from '../../shield/admin'
import { requireShieldAdmin } from '../../shield/auth'

/** Stato dello scudo per il pannello: IP bloccati (20 per pagina, ricerca con ?q=), IP fidati, paesi bloccati. */
export default defineEventHandler(async (event) => {
  const admin = await requireShieldAdmin(event)
  const query = getQuery(event)
  return shieldState(event, admin, {
    q: typeof query.q === 'string' ? query.q.slice(0, 100) : undefined,
    page: Number(query.page) || 1,
  })
})
