import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
const m = await import(
  'data:text/javascript;base64,' + Buffer.from(`const host = {}; const jsx = () => null;\n${src}`).toString('base64')
)

// Minimal fake DOM: enough for rowFor (closest / querySelectorAll / getAttribute / parentElement).
function matchOne(n, s) {
  const hit = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s)
  if (!hit) return false
  const v = n.getAttribute(hit[1])
  return hit[2] === undefined ? v !== null : v === hit[2]
}
function node(attrs = {}, children = []) {
  const n = {
    nodeType: 1,
    children,
    parentElement: null,
    getAttribute: k => (k in attrs ? attrs[k] : null),
    matches: sel => sel.split(',').some(s => matchOne(n, s.trim())),
    closest(sel) {
      for (let e = n; e; e = e.parentElement) if (e.matches(sel)) return e
      return null
    },
    querySelectorAll(sel) {
      const out = []
      const walk = e => {
        for (const c of e.children) {
          if (c.matches(sel)) out.push(c)
          walk(c)
        }
      }
      walk(n)
      return out
    }
  }
  for (const c of children) c.parentElement = n
  return n
}
const marker = sid => node({ 'data-sctab-sid': sid })
const rowButton = (extra = {}, kids = []) => node({ 'data-slot': 'row-button', ...extra }, kids)

test('click on a session row resolves that row and its id', () => {
  const title = node()
  const row = node({}, [rowButton({}, [title]), marker('S1')])
  node({}, [row, node({}, [rowButton(), marker('S2')])])
  assert.equal(m.rowFor(title)?.sessionId, 'S1')
})

test('click outside any row-button is never a session click', () => {
  const stray = node()
  node({}, [node({}, [rowButton(), marker('S1')]), stray])
  assert.equal(m.rowFor(stray), null)
})

test('a Bots roster row is never a session click', () => {
  const bot = rowButton({ 'data-roster-key': 'local::ads' })
  node({}, [bot, marker('S1')])
  assert.equal(m.rowFor(bot), null)
})

test('an ancestor holding several markers is a list, not a row', () => {
  const b = rowButton()
  node({}, [b, marker('S1'), marker('S2')])
  assert.equal(m.rowFor(b), null)
})
