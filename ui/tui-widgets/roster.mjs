/**
 * /roster: Noethera's agent roster in the TUI, read live from ~/.hermes/profiles (title from profile.yaml) and the
 * Kanban board (~/.hermes/kanban.db, read-only). Groups are fixed below; an unknown new profile lands in "Spesialis".
 * Source: noe-hermes/ui/tui-widgets/roster.mjs. Esc/q/Enter closes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), '.hermes')

const GROUPS = [
  ['Koordinator', name => name === 'noe'],
  ['Engineering', name => ['web-dev', 'backend-dev', 'ios-dev', 'qa-dev', 'designer'].includes(name)],
  ['Product lead', name => name.endsWith('-lead')],
  ['C-level', name => ['cfo', 'cmo', 'coo'].includes(name)],
  ['Spesialis', () => true]
]

function readTitle(dir) {
  try {
    const yaml = readFileSync(join(dir, 'profile.yaml'), 'utf8')
    const m = yaml.match(/hermes-bots:\s*\n(?:\s+.*\n)*?\s+title:\s*['"]?([^'"\n]+)/)

    if (m) return m[1].trim()
    // No bot title: first clause of the description ("Market and trend researcher: ...").
    const d = yaml.match(/^description:\s*['"]?([^:'"\n]+)/m)

    return d ? d[1].replace(/ for every .*/, '').trim() : ''
  } catch {
    return ''
  }
}

function readKanban() {
  const counts = {}
  const db = join(ROOT, 'kanban.db')

  if (!existsSync(db)) {
    return counts
  }

  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const conn = new DatabaseSync(db, { readOnly: true })
    const rows = conn
      .prepare("SELECT assignee, status, COUNT(*) AS n FROM tasks WHERE status IN ('running','blocked','review') GROUP BY 1, 2")
      .all()
    conn.close()

    for (const { assignee, status, n } of rows) {
      counts[assignee] = { ...(counts[assignee] || {}), [status]: n }
    }
  } catch {
    // Kanban unreadable: show the roster without counts.
  }

  return counts
}

function loadRoster() {
  const base = join(ROOT, 'profiles')
  const names = readdirSync(base)
    .filter(n => !n.startsWith('.') && statSync(join(base, n)).isDirectory())
    .sort()
  const kanban = readKanban()
  const groups = GROUPS.map(([label]) => ({ label, agents: [] }))

  for (const name of names) {
    const i = GROUPS.findIndex(([, match]) => match(name))
    groups[i].agents.push({ name, title: readTitle(join(base, name)), k: kanban[name] || {} })
  }

  return { groups: groups.filter(g => g.agents.length), total: names.length }
}

export default function register(sdk) {
  const { Box, Dialog, Overlay, Text, defineWidgetApp, h, isCtrl } = sdk

  function Row({ agent, t }) {
    const { running = 0, blocked = 0, review = 0 } = agent.k
    const parts = []

    if (running) parts.push(h(Text, { key: 'r', color: t.color.ok }, `jalan ${running}`))
    if (review) parts.push(h(Text, { key: 'v', color: t.color.label }, `review ${review}`))
    if (blocked) parts.push(h(Text, { key: 'b', color: t.color.warn }, `blocked ${blocked}`))

    return h(
      Box,
      { columnGap: 1, flexDirection: 'row' },
      h(Text, { color: t.color.text }, agent.name.padEnd(18)),
      h(Text, { color: t.color.muted }, (agent.title || '').slice(0, 28).padEnd(28)),
      ...parts
    )
  }

  defineWidgetApp({
    id: 'roster',
    help: 'daftar agent Noethera + task Kanban yang jalan/blocked',

    init() {
      try {
        return { ...loadRoster(), error: null }
      } catch (e) {
        return { groups: [], total: 0, error: String(e?.message || e) }
      }
    },

    reduce(state, { ch, key }) {
      if (key.escape || key.return || ch === 'q' || isCtrl(key, ch, 'c')) return null
      if (ch === 'r') return { ...loadRoster(), error: null }

      return state
    },

    render({ cols, state, t }) {
      const body = state.error
        ? [h(Text, { key: 'e', color: t.color.error }, state.error)]
        : state.groups.flatMap(g => [
            h(Text, { key: `g-${g.label}`, bold: true, color: t.color.primary }, `${g.label} (${g.agents.length})`),
            ...g.agents.map(a => h(Row, { key: a.name, agent: a, t }))
          ])

      return h(
        Overlay,
        { backdrop: true, zone: 'center' },
        h(
          Dialog,
          { hint: 'r refresh · Esc/q tutup', title: `Agent Noethera: ${state.total}`, width: Math.min(76, cols - 4) },
          ...body
        )
      )
    }
  })
}
