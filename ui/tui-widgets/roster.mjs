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
const BLINK_MS = 600

function safeRoster() {
  try {
    return { ...loadRoster(), error: null }
  } catch (e) {
    return { groups: [], total: 0, error: String(e?.message || e) }
  }
}

export default function register(sdk) {
  const { Box, Dialog, React, Text, defineWidgetApp, h } = sdk

  // Status: the bullet LEFT of the name (priority: running > blocked > review), count on the right as "(n)".
  // Running = blinking green ●/○; blocked = static red ●; review = static orange ●. Idle agents get an accent ●.
  function status(k, on, t) {
    const { running = 0, blocked = 0, review = 0 } = k

    if (running) return { mark: on ? '●' : '○', color: on ? t.color.ok : t.color.muted, n: running }
    if (blocked) return { mark: '●', color: t.color.error, n: blocked }
    if (review) return { mark: '●', color: t.color.warn, n: review }

    return null
  }

  function Sidebar({ initial, t }) {
    const [roster, setRoster] = React.useState(initial)

    React.useEffect(() => {
      const id = setInterval(() => setRoster(safeRoster()), REFRESH_MS)

      return () => clearInterval(id)
    }, [])

    // Blink for running agents ("lampu nyala"): toggles every 600 ms, only while something is running.
    const [on, setOn] = React.useState(true)
    const anyRunning = roster.groups.some(g => g.agents.some(a => a.k.running))

    React.useEffect(() => {
      if (!anyRunning) return undefined
      const id = setInterval(() => setOn(v => !v), BLINK_MS)

      return () => clearInterval(id)
    }, [anyRunning])

    if (roster.error) {
      return h(Dialog, { title: 'Agent', width: WIDTH }, h(Text, { color: t.color.error }, roster.error.slice(0, WIDTH * 3)))
    }

    // Tree style (like the desktop sidebar): "▾ Group", then each agent on a branch ├─ / └─ with a ● bullet.
    const rows = roster.groups.flatMap((g, i) => [
      ...(i ? [h(Text, { key: `sp-${g.label}` }, ' ')] : []),
      h(
        Text,
        { key: `g-${g.label}` },
        h(Text, { color: t.color.muted }, '▾ '),
        h(Text, { bold: true, color: t.color.primary }, g.label)
      ),
      ...g.agents.map((a, j) =>
        (st => h(
          Box,
          { key: a.name, columnGap: 1, flexDirection: 'row' },
          h(Text, { color: t.color.border }, j === g.agents.length - 1 ? '└─' : '├─'),
          h(Text, { color: st ? st.color : t.color.accent }, st ? st.mark : '●'),
          h(Text, { color: t.color.text }, a.name.padEnd(19)),
          st ? h(Text, { color: st.color }, `(${st.n})`) : null
        ))(status(a.k, on || !anyRunning, t))
      )
    ])

    return h(
      Dialog,
      { hint: h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.ok }, '●'), ' running'),
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.warn }, '●'), ' review'),
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.error }, '●'), ' blocked')
        ), title: `Agent Noethera: ${roster.total}`, width: WIDTH },
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
