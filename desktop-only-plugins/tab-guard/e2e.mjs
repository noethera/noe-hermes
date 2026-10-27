// tab-guard end-to-end check against the ISOLATED dev instance (CDP :9333, zoom 100%).
// usage: node e2e.mjs [probe]  → "probe" prints DOM facts; default prints "A PASS|FAIL …" and "B PASS|FAIL …"
import { CDP } from '/Users/noetherastudio/.hermes/hermes-agent/apps/desktop/scripts/perf/lib/cdp.mjs'

const J = JSON.stringify
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cdp = await CDP.connect({ port: 9333, match: '5174' })
const ev = async expr => JSON.parse(await cdp.eval(expr))
const sdk = body => ev(`(async () => { const { host } = await import('/src/sdk/index.ts'); ${body} })()`)

async function mouse(sel, { click = true } = {}) {
  const box = await ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return 'null'
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    return JSON.stringify({ x, y, hit: !!document.elementFromPoint(x, y)?.closest(${J(sel)}) }) })()`)
  if (!box) throw new Error('not found: ' + sel)
  if (!box.hit) throw new Error('hit-test miss (press ⌘0 in the isolated window): ' + sel)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  if (click) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await sleep(200)
}
const tabSel = sid => `[data-tree-tab="session-tile:${sid}"]`

if (process.argv[2] === 'probe') {
  await mouse('[data-tree-tab="hermes-bots:pane"]')
  await sleep(1500)
  console.log(
    'roster',
    J(await ev(`JSON.stringify([...document.querySelectorAll('[data-roster-key]')].slice(0, 4).map(r => [r.getAttribute('data-roster-key'), r.tagName, r.getAttribute('data-slot')]))`))
  )
  console.log(
    'profiles',
    J(await sdk(`const r = await host.request('profiles.list', {}); const rows = Array.isArray(r) ? r : r.profiles
      return JSON.stringify({ isArray: Array.isArray(r), n: rows.length, sample: rows.slice(0, 4).map(p => [p.name, p.canonical_session]) })`))
  )
  await mouse('[data-tree-tab="sessions"]')
  await sleep(1500)
  console.log(
    'rowDepth',
    J(await ev(`JSON.stringify([...document.querySelectorAll('[data-sctab-sid]')].slice(0, 4).map(mk => { let el = mk, d = 0
      while (el && !el.querySelector?.('[data-slot="row-button"]')) { el = el.parentElement; d++ } return d }))`))
  )
  cdp.close()
  process.exit(0)
}

// ---------- setup ----------
await mouse('[data-tree-tab="hermes-bots:pane"]')
await sleep(1500)
const setup = await sdk(`
  const s = await host.request('session.list', { limit: 10 })
  const p = await host.request('profiles.list', {})
  const rows = Array.isArray(p) ? p : p.profiles || []
  const onRoster = n => !!document.querySelector('[data-roster-key$="::' + n + '"]')
  const bot = rows.find(r => r.name !== 'default' && r.canonical_session && onRoster(r.name))
  return JSON.stringify({ sessions: (s.sessions || []).map(x => x.id),
    bot: bot && { name: bot.name, sid: String(bot.canonical_session.resolved_id || bot.canonical_session.id) } })`)
const [S, T, T2] = setup.sessions
if (!setup.bot || !T2) throw new Error('need a roster bot with a Bot Chat and ≥3 sessions: ' + J(setup))
const C = setup.bot.sid

// ---------- A: bot click must not overwrite main ----------
await sdk(`await host.openSession(${J(S)}, { intent: 'main' }); return '1'`)
await sleep(3000)
await ev(`(() => { document.querySelector(${J(tabSel(C) + ' button[aria-label="Close"]')})?.click(); return '1' })()`)
await sleep(800)
await mouse('[data-tree-tab="hermes-bots:pane"]')
const mainBefore = await ev(`JSON.stringify(document.querySelector('[data-tree-tab="workspace"]')?.textContent || '')`)
await mouse(`[data-roster-key$="::${setup.bot.name}"]`)
await sleep(5000)
const a = await ev(`JSON.stringify({ tile: !!document.querySelector(${J(tabSel(C))}),
  active: document.querySelector(${J(tabSel(C))})?.getAttribute('data-active') === 'true',
  mainAfter: document.querySelector('[data-tree-tab="workspace"]')?.textContent || '' })`)
const aPass = a.tile && a.active && a.mainAfter === mainBefore
console.log(aPass ? 'A PASS' : 'A FAIL', J({ bot: setup.bot.name, mainBefore, ...a }))

// ---------- B: a user-closed tab must not come back ----------
for (const sid of [T, T2]) {
  await sdk(`await host.openSession(${J(sid)}, { intent: 'tab' }); return '1'`)
  await sleep(1500)
}
const snapshot = await ev(`JSON.stringify(localStorage.getItem('hermes.desktop.sessionTiles.v2'))`)
await mouse(tabSel(T), { click: false }) // hover so the ✕ is hit-testable
await mouse(`${tabSel(T)} button[aria-label="Close"]`)
await sleep(800)
const tombs = await ev(`JSON.stringify(Object.keys(window.__tabGuard?.tombstones() || {}))`)
// Simulate the stale-bucket rehydrate: put the pre-close tile set back, reload.
await ev(`(() => { localStorage.setItem('hermes.desktop.sessionTiles.v2', ${J(snapshot)}); return '1' })()`)
await cdp.send('Page.reload', {})
await sleep(10000)
const b = await ev(`JSON.stringify({ present: !!document.querySelector(${J(tabSel(T))}),
  kinds: (window.__tabGuard?.log() || []).filter(e => e.sid === ${J(T)}).map(e => e.kind) })`)
const bPass = tombs.includes(T) && !b.present && b.kinds.includes('reclose')
console.log(bPass ? 'B PASS' : 'B FAIL', J({ T, tombstoned: tombs.includes(T), ...b }))
cdp.close()
