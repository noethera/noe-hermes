import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
const m = await import('data:text/javascript;base64,' + Buffer.from(`const host = {};\n${src}`).toString('base64'))

test('mainSessionFromHash reads only real session ids', () => {
  assert.equal(m.mainSessionFromHash('#/20261023_010110_90303e'), '20261023_010110_90303e')
  assert.equal(m.mainSessionFromHash('#/20261023_010110_90303e?x=1'), '20261023_010110_90303e')
  assert.equal(m.mainSessionFromHash('#/settings'), null)
  assert.equal(m.mainSessionFromHash('#/'), null)
  assert.equal(m.mainSessionFromHash(''), null)
})

test('canonicalIdsOf puts the lineage tip first', () => {
  assert.deepEqual(m.canonicalIdsOf({ canonical_session: { id: 'a', resolved_id: 'b' } }), ['b', 'a'])
  assert.deepEqual(m.canonicalIdsOf({ canonical_session: { id: 'a' } }), ['a'])
  assert.deepEqual(m.canonicalIdsOf({}), [])
})

test('owner key: prefer a key core already uses, else the roster-key form', () => {
  const c = m.ownerKeyCandidates('local::ads', 'ads')
  assert.deepEqual(c, ['bot:local::ads', 'bot:ads'])
  assert.equal(m.pickOwnerKey(c, ['bot:ads']), 'bot:ads')
  assert.equal(m.pickOwnerKey(c, []), 'bot:local::ads')
  assert.deepEqual(m.ownerKeyCandidates('legacy::ads', 'ads'), ['bot:ads'])
})

test('decideBotClick redirects only when main holds another chat and no tab exists', () => {
  const base = { mainSid: 'S', canonicalIds: ['C'], openTileSids: [] }
  assert.equal(m.decideBotClick(base), 'open-tab')
  assert.equal(m.decideBotClick({ ...base, mainSid: null }), 'pass:main-empty')
  assert.equal(m.decideBotClick({ ...base, canonicalIds: [] }), 'pass:no-canonical')
  assert.equal(m.decideBotClick({ ...base, mainSid: 'C' }), 'pass:already-main')
  assert.equal(m.decideBotClick({ ...base, openTileSids: ['C'] }), 'pass:already-tab')
})

test('pruneTombstones drops expired and junk entries', () => {
  const now = 10 * m.TOMB_TTL_MS
  assert.deepEqual(m.pruneTombstones({ a: now - 1000, b: now - m.TOMB_TTL_MS - 1, c: 'x' }, now), { a: now - 1000 })
})

test('isUserClose: a removal counts only inside the gesture window', () => {
  assert.equal(m.isUserClose(1500, 1000), true)
  assert.equal(m.isUserClose(1000 + m.CLOSE_GESTURE_WINDOW_MS + 1, 1000), false)
  assert.equal(m.isUserClose(500, 1000), false)
  assert.equal(m.isUserClose(1500, 0), false)
})

test('shouldReclose: only tombstoned, unexpired, background tabs', () => {
  const now = 1_000_000
  const tombs = { T: now - 1000 }
  assert.equal(m.shouldReclose({ sid: 'T', tombs, now, isActive: false }), true)
  assert.equal(m.shouldReclose({ sid: 'T', tombs, now, isActive: true }), false)
  assert.equal(m.shouldReclose({ sid: 'X', tombs, now, isActive: false }), false)
  assert.equal(m.shouldReclose({ sid: 'T', tombs: { T: now - m.TOMB_TTL_MS - 1 }, now, isActive: false }), false)
})

test('diffTabs and isCloseLabel', () => {
  assert.deepEqual(m.diffTabs(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] })
  assert.equal(m.isCloseLabel('Close'), true)
  assert.equal(m.isCloseLabel('Close Others'), true)
  assert.equal(m.isCloseLabel('Tutup'), true)
  assert.equal(m.isCloseLabel('Closed captions'), false)
  assert.equal(m.isCloseLabel(null), false)
})
