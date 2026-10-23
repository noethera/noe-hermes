/**
 * /roster: Noethera's agent roster in the TUI, read live from ~/.hermes/profiles (title from profile.yaml) and the
 * Kanban board (~/.hermes/kanban.db, read-only). Groups are fixed below; an unknown new profile lands in "Spesialis".
 * Source: noe-hermes/ui/tui-widgets/roster.mjs. Docked as a right sidebar on TUI start (auto-open); `/roster` toggles it. Refreshes every 5 s (local read-only SQLite, cheap).
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

const WIDTH = 34
const REFRESH_MS = 5_000

function safeRoster() {
  try {
    return { ...loadRoster(), error: null }
  } catch (e) {
    return { groups: [], total: 0, error: String(e?.message || e) }
  }
}

export default function register(sdk) {
  const { Box, Dialog, React, Text, defineWidgetApp, h } = sdk

  // Status markers: ▶ running, ◇ review, ! blocked (colored, fixed order).
  function Status({ k, t }) {
    const { running = 0, blocked = 0, review = 0 } = k
    const parts = []

    if (running) parts.push(h(Text, { key: 'r', color: t.color.ok }, `▶${running}`))
    if (review) parts.push(h(Text, { key: 'v', color: t.color.label }, `◇${review}`))
    if (blocked) parts.push(h(Text, { key: 'b', color: t.color.warn }, `!${blocked}`))

    return h(Box, { columnGap: 1, flexDirection: 'row' }, ...parts)
  }

  function Sidebar({ initial, t }) {
    const [roster, setRoster] = React.useState(initial)

    React.useEffect(() => {
      const id = setInterval(() => setRoster(safeRoster()), REFRESH_MS)

      return () => clearInterval(id)
    }, [])

    if (roster.error) {
      return h(Dialog, { title: 'Agent', width: WIDTH }, h(Text, { color: t.color.error }, roster.error.slice(0, WIDTH * 3)))
    }

    const rows = roster.groups.flatMap((g, i) => [
      ...(i ? [h(Text, { key: `sp-${g.label}` }, ' ')] : []),
      h(Text, { key: `g-${g.label}`, bold: true, color: t.color.primary }, `${g.label} (${g.agents.length})`),
      ...g.agents.map(a =>
        h(
          Box,
          { key: a.name, columnGap: 1, flexDirection: 'row' },
          h(Text, { color: t.color.text }, a.name.padEnd(18)),
          h(Status, { k: a.k, t })
        )
      )
    ])

    return h(
      Dialog,
      { hint: '▶ jalan  ◇ review  ! blocked', title: `Agent Noethera: ${roster.total}`, width: WIDTH },
      ...rows
    )
  }

  const app = defineWidgetApp({
    id: 'roster',
    help: 'sidebar kanan: daftar agent Noethera + task Kanban jalan/review/blocked',
    mode: 'ambient',
    zone: 'top-right',
    width: WIDTH,

    init() {
      return safeRoster()
    },

    reduce(state, { ch, key }) {
      return key.escape || ch === 'q' ? null : state
    },

    render({ state, t }) {
      return h(Sidebar, { initial: state, t })
    }
  })

  // Wira wants the sidebar always visible: dock it as soon as the file loads.
  sdk.openWidget(app, app.init(''))
}
