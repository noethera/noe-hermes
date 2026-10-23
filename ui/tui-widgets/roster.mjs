/**
 * /roster: Noethera's agent roster in the TUI, read live from ~/.hermes/profiles (title from profile.yaml) and the
 * Kanban board (~/.hermes/kanban.db, read-only). Groups are fixed below; an unknown new profile lands in "Spesialis".
 * Under each agent with running/blocked/review work: the task id, its age (running) or status, and the title (max 3 lines).
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

// Per assignee: counts per status plus the active tasks themselves (id, status, title, started_at), so the sidebar
// shows WHICH task each agent is on, not only how many.
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
      .prepare(
        "SELECT id, assignee, status, title, started_at FROM tasks WHERE status IN ('running','blocked','review') " +
          "ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, started_at"
      )
      .all()
    conn.close()

    for (const { id, assignee, status, title, started_at } of rows) {
      const k = (counts[assignee] ||= { tasks: [] })

      k[status] = (k[status] || 0) + 1
      k.tasks.push({ id, status, title: title || '', startedAt: started_at })
    }
  } catch {
    // Kanban unreadable: show the roster without counts.
  }

  return counts
}

// Word-wrap a title into at most `max` lines of `width` chars; the last line ends in "…" when cut.
function wrap(text, width, max) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let line = ''

  for (const w of words) {
    const next = line ? `${line} ${w}` : w

    if (next.length <= width) {
      line = next
      continue
    }

    if (line) lines.push(line)
    line = w.length > width ? w.slice(0, width) : w

    if (lines.length === max) break
  }

  if (lines.length < max && line) lines.push(line)

  const cut = lines.length > max || lines.join(' ').length < text.replace(/\s+/g, ' ').trim().length
  const out = lines.slice(0, max)

  if (cut && out.length) {
    const last = out[out.length - 1]
    out[out.length - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + '…'
  }

  return out
}

function age(startedAt) {
  if (!startedAt) return ''
  const min = Math.max(0, Math.floor((Date.now() / 1000 - startedAt) / 60))

  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}j ${min % 60}m`
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

const WIDTH = 40
// Usable text columns inside the Dialog (border + padding), and the indent for a task under its agent.
const TEXT_W = WIDTH - 4
const INDENT = '  '
const TITLE_LINES = 3
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

  // Status: one marker LEFT of the name (priority: running > blocked > review), count on the right as "(n)".
  // Running = blinking green box ■/□; blocked = static red box ■; review = static orange box ■. Idle agents get a blank marker so names stay aligned.
  function status(k, on, t) {
    const { running = 0, blocked = 0, review = 0 } = k

    if (running) return { mark: on ? '■' : '□', color: on ? t.color.ok : t.color.muted, n: running }
    if (blocked) return { mark: '■', color: t.color.error, n: blocked }
    if (review) return { mark: '■', color: t.color.warn, n: review }

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

    const STATUS_COLOR = { running: t.color.ok, blocked: t.color.error, review: t.color.warn }

    // Under each active agent: one block per task = "t_xxxxxxxx · 18m" (or the status word) + title, wrapped.
    const taskRows = a =>
      (a.k.tasks || []).flatMap(task => [
        h(
          Text,
          { key: `${task.id}-id`, color: t.color.muted },
          INDENT,
          h(Text, { color: STATUS_COLOR[task.status] }, task.id),
          task.status === 'running' ? ` · ${age(task.startedAt)}` : ` · ${task.status}`
        ),
        ...wrap(task.title, TEXT_W - INDENT.length, TITLE_LINES).map((line, j) =>
          h(Text, { key: `${task.id}-t${j}`, color: t.color.text }, INDENT + line)
        )
      ])

    const rows = roster.groups.flatMap((g, i) => [
      ...(i ? [h(Text, { key: `sp-${g.label}` }, ' ')] : []),
      h(Text, { key: `g-${g.label}`, bold: true, color: t.color.primary }, `${g.label} (${g.agents.length})`),
      ...g.agents.flatMap(a =>
        (st => [
          h(
            Box,
            { key: a.name, columnGap: 1, flexDirection: 'row' },
            h(Text, { color: st ? st.color : t.color.text }, st ? st.mark : ' '),
            h(Text, { color: t.color.text }, a.name.padEnd(20)),
            st ? h(Text, { color: st.color }, `(${st.n})`) : null
          ),
          ...taskRows(a)
        ])(status(a.k, on || !anyRunning, t))
      )
    ])

    return h(
      Dialog,
      { hint: h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.ok }, '■'), ' running'),
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.warn }, '■'), ' review'),
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.error }, '■'), ' blocked')
        ), title: `Agent Noethera: ${roster.total}`, width: WIDTH },
      ...rows
    )
  }

  const app = defineWidgetApp({
    id: 'roster',
    help: 'sidebar kanan: agent Noethera + task Kanban yang lagi jalan/review/blocked (id + judul)',
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
