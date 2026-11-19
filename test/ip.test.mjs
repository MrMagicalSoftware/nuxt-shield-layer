import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandIpv6, normalizeIp, parseShieldKey, parseTrustedAddress, shieldKey } from '../lib/ip.mjs'

test('normalizeIp toglie porta, parentesi, zone id e prefisso IPv4-mapped', () => {
  assert.equal(normalizeIp('203.0.113.7:51234'), '203.0.113.7')
  assert.equal(normalizeIp('[2001:DB8::1]:443'), '2001:db8::1')
  assert.equal(normalizeIp('fe80::1%en0'), 'fe80::1')
  assert.equal(normalizeIp('::ffff:198.51.100.4'), '198.51.100.4')
  assert.equal(normalizeIp('"192.0.2.1"'), '192.0.2.1')
  assert.equal(normalizeIp('non-un-ip'), null)
  assert.equal(normalizeIp(''), null)
  assert.equal(normalizeIp(undefined), null)
})

test('expandIpv6 espande :: e IPv4 incorporato', () => {
  assert.deepEqual(expandIpv6('2001:db8::1'), ['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0001'])
  assert.deepEqual(expandIpv6('::ffff:1.2.3.4').slice(5), ['ffff', '0102', '0304'])
})

test('shieldKey: IPv4 così com\'è, IPv6 per rete /64', () => {
  assert.equal(shieldKey('203.0.113.7'), '203.0.113.7')
  assert.equal(shieldKey('2001:db8:1:2:aaaa::1'), '2001:0db8:0001:0002::/64')
  assert.equal(shieldKey('2001:db8:1:2::ffff'), shieldKey('2001:db8:1:2:aaaa::1'))
})

test('parseShieldKey accetta IP e reti /64, rifiuta il resto', () => {
  assert.equal(parseShieldKey(' 203.0.113.7 '), '203.0.113.7')
  assert.equal(parseShieldKey('2001:db8:1:2::/64'), '2001:0db8:0001:0002::/64')
  assert.equal(parseShieldKey('203.0.113.7/64'), null)
  assert.equal(parseShieldKey('example.com'), null)
})

test('parseTrustedAddress: IP o reti non troppo ampie', () => {
  assert.equal(parseTrustedAddress('93.49.90.147'), '93.49.90.147')
  assert.equal(parseTrustedAddress('93.49.90.0/24'), '93.49.90.0/24')
  assert.equal(parseTrustedAddress('93.49.0.0/16'), '93.49.0.0/16')
  assert.equal(parseTrustedAddress('93.0.0.0/8'), null)
  assert.equal(parseTrustedAddress('2001:db8::/48'), '2001:db8::/48')
  assert.equal(parseTrustedAddress('2001:db8::/32'), null)
  assert.equal(parseTrustedAddress('1.2.3.4/abc'), null)
})
