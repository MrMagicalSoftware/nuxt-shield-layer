import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createFileShieldStore } from '../lib/file-store.mjs'

let dir
let store
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nuxt-shield-'))
  store = createFileShieldStore(dir)
  await store.init()
})
after(() => rm(dir, { recursive: true, force: true }))

const ban = (key, until, extra = {}) => ({ key, reason: 'prova', until, count: 1, manual: false, lastPath: '/wp-admin', userAgent: 'test', ...extra })

test('blocchi: salva, rilegge, sostituisce, cancella', async () => {
  const until = Date.now() + 3_600_000
  await store.saveBan(ban('203.0.113.7', until))
  await store.saveBan(ban('2001:0db8:0001:0002::/64', until))
  await store.saveBan(ban('203.0.113.7', until + 1000, { count: 2, manual: true }))
  const bans = await store.listBans()
  assert.equal(bans.length, 2)
  const v4 = bans.find(b => b.key === '203.0.113.7')
  assert.deepEqual(v4, ban('203.0.113.7', until + 1000, { count: 2, manual: true }))
  assert.ok((await readdir(join(dir, 'bans'))).includes('2001-0db8-0001-0002--_64.json'))
  await store.deleteBan('2001:0db8:0001:0002::/64')
  await store.deleteBan('198.51.100.1') // non esiste: nessun errore
  assert.deepEqual((await store.listBans()).map(b => b.key), ['203.0.113.7'])
})

test('blocchi: purgeBans cancella solo quelli finiti prima della data', async () => {
  await store.saveBan(ban('198.51.100.9', Date.now() - 40 * 86_400_000))
  await store.purgeBans(Date.now() - 30 * 86_400_000)
  assert.deepEqual((await store.listBans()).map(b => b.key).sort(), ['203.0.113.7'])
})

test('blocchi: un file rovinato a mano viene ignorato', async () => {
  await writeFile(join(dir, 'bans', 'rotto.json'), '{ non json')
  assert.equal((await store.listBans()).length, 1)
})

test('IP fidati: aggiunta, nota aggiornata, rimozione', async () => {
  await store.saveTrusted({ address: '93.49.90.147', note: 'Ufficio', createdBy: 'admin', createdAt: '2026-11-19T10:00:00.000Z' })
  await store.saveTrusted({ address: '93.49.90.0/24', note: null, createdBy: 'admin', createdAt: '2026-11-19T11:00:00.000Z' })
  await store.saveTrusted({ address: '93.49.90.147', note: 'Ufficio Milano', createdBy: 'altro', createdAt: '2026-11-20T10:00:00.000Z' })
  const list = await store.listTrusted()
  assert.equal(list.length, 2)
  assert.deepEqual(list.find(t => t.address === '93.49.90.147'), { address: '93.49.90.147', note: 'Ufficio Milano', createdBy: 'admin', createdAt: '2026-11-19T10:00:00.000Z' })
  await store.deleteTrusted('93.49.90.0/24')
  assert.deepEqual((await store.listTrusted()).map(t => t.address), ['93.49.90.147'])
})

test('IP fidati: scritture contemporanee non si perdono', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.saveTrusted({ address: `10.0.0.${i}`, note: null, createdBy: null, createdAt: new Date().toISOString() })))
  assert.equal((await store.listTrusted()).length, 21)
})

test('paesi: blocco, aggiornamento che tiene la data di creazione, sblocco', async () => {
  await store.saveCountry({ code: 'CN', createdBy: 'admin', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }, { v4: ['1.0.1.0/24', '1.0.2.0/23'], v6: ['2001:250::/35'] })
  await store.saveCountry({ code: 'CN', createdBy: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' }, { v4: ['1.0.1.0/24'], v6: [] })
  await store.saveCountry({ code: 'T1', createdBy: 'admin', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, { v4: [], v6: [] })
  const list = await store.listCountries()
  assert.deepEqual(list.find(c => c.code === 'CN'), { code: 'CN', createdBy: 'admin', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' })
  assert.deepEqual(await store.getCountryRanges('CN'), { v4: ['1.0.1.0/24'], v6: [] })
  assert.deepEqual(await store.getCountryRanges('T1'), { v4: [], v6: [] })
  assert.equal(await store.getCountryRanges('RU'), null)
  await store.deleteCountry('CN')
  assert.deepEqual((await store.listCountries()).map(c => c.code), ['T1'])
  assert.equal(await store.getCountryRanges('CN'), null)
})

test('nessun file temporaneo rimasto', async () => {
  const all = [...await readdir(dir), ...await readdir(join(dir, 'bans')), ...await readdir(join(dir, 'countries'))]
  assert.deepEqual(all.filter(f => f.endsWith('.tmp')), [])
})
