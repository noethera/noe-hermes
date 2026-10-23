/**
 * Input frame like Claude Code: a rule above and below the composer, with a blank row between the frame and the
 * status bar (status bar sits at the bottom: display.tui_statusbar = bottom). Two ambient dock widgets, auto-open on
 * TUI start; `/frame-top` and `/frame-bottom` toggle them. Source: noe-hermes/ui/tui-widgets/input-frame.mjs.
 * The TUI adds one blank row above the input when the status bar is at the bottom: the top rule is drawn on that row
 * (zero-height box with an absolute child) and the input sits right under it (layout: rule / input / rule / blank / status).
 *
 * Under the bottom rule: what every RUNNING agent is doing right now, read live from the Kanban board
 * (~/.hermes/kanban.db, read-only, every 5 s). Per agent:
 *   ■ web-dev · Monne: <full task title, wraps to a 2nd line>                 25m · t_c9f8034b
 *     ↳ <latest progress: newest heartbeat note, or the last sentence of the agent's latest comment in this run>
 * All text gray (muted), only the ■ marker stays green. Nothing running = only the rule, as before. It lives in this widget (not its own) because docked widgets sit side
 * by side in one row: a second dock-bottom widget would land next to the rule instead of under it.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB = join(homedir(), '.hermes', 'kanban.db')
const REFRESH_MS = 5_000
const MAX_AGENTS = 4

function age(startedAt) {
  if (!startedAt) return ''
  const min = Math.max(0, Math.floor((Date.now() / 1000 - startedAt) / 60))

  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}j ${min % 60}m`
}

// Newest progress line for a task in its current run: a heartbeat note, or the last sentence of the assignee's
// latest comment, whichever is newer.
function progress(conn, task) {
  const since = task.started_at || 0
  const beat = conn
    .prepare(
      "SELECT payload, created_at FROM task_events WHERE task_id = ? AND kind = 'heartbeat' AND payload LIKE '%note%' " +
        'AND created_at >= ? ORDER BY id DESC LIMIT 1'
    )
    .get(task.id, since)
  const comment = conn
    .prepare('SELECT body, created_at FROM task_comments WHERE task_id = ? AND author = ? AND created_at >= ? ORDER BY id DESC LIMIT 1')
    .get(task.id, task.assignee, since)

  let note = ''

  try {
    note = beat ? JSON.parse(beat.payload)?.note || '' : ''
  } catch {}

  if (comment && (!note || comment.created_at > beat.created_at)) {
    const text = comment.body.replace(/\s+/g, ' ').trim()
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9`"(])/)

    note = sentences[sentences.length - 1] || text
  }

  return note.replace(/\s+/g, ' ').trim()
}

function readRunning() {
  if (!existsSync(DB)) return { tasks: [], error: null }

  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const conn = new DatabaseSync(DB, { readOnly: true })
    const rows = conn.prepare("SELECT id, assignee, title, started_at FROM tasks WHERE status = 'running' ORDER BY started_at").all()
    const tasks = rows.map(r => ({ ...r, note: progress(conn, r) }))

    conn.close()

    return { tasks, error: null }
  } catch (e) {
    return { tasks: [], error: String(e?.message || e) }
  }
}

// Word-wrap where line i may have its own width (widths[i]); at most widths.length lines, "…" when cut.
function wrapWidths(text, widths) {
  const clean = text.replace(/\s+/g, ' ').trim()
  const lines = []
  let line = ''

  for (const word of clean.split(' ')) {
    const width = widths[lines.length]
    const next = line ? `${line} ${word}` : word

    if (next.length <= width) {
      line = next
      continue
    }

    if (line) lines.push(line)
    if (lines.length === widths.length) break
    line = word.slice(0, widths[lines.length])
  }

  if (lines.length < widths.length && line) lines.push(line)

  if (lines.join(' ').length < clean.length && lines.length) {
    const i = lines.length - 1
    lines[i] = (lines[i].length >= widths[i] ? lines[i].slice(0, widths[i] - 1) : lines[i]) + '…'
  }

  return lines
}

const clip = (text, width) => (text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…')

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  // The dock keeps 2 columns free on the right (paddingRight 2).
  const rule = (cols, t) => h(Text, { color: t.color.border }, '─'.repeat(Math.max(1, cols - 2)))
  const blank = key => h(Text, { key }, ' ')

  function Running({ cols, t }) {
    const [data, setData] = React.useState(readRunning)

    React.useEffect(() => {
      const id = setInterval(() => setData(readRunning()), REFRESH_MS)

      return () => clearInterval(id)
    }, [])

    const width = Math.max(30, cols - 2)

    if (data.error) {
      return h(Text, { color: t.color.error }, clip(`Kanban: ${data.error}`, width))
    }

    const shown = data.tasks.slice(0, MAX_AGENTS)
    const rows = shown.flatMap(task => {
      const head = `■ ${task.assignee} · `
      const meta = `${age(task.started_at)} · ${task.id}`
      // Line 1: title next to the agent name, leaving room for the right-hand meta; line 2: rest, indented 2.
      const [first = '', second] = wrapWidths(task.title, [Math.max(10, width - head.length - meta.length - 2), width - 2])

      return [
        h(
          Box,
          { key: `${task.id}-h`, flexDirection: 'row', justifyContent: 'space-between', width },
          h(Text, { color: t.color.muted }, h(Text, { color: t.color.ok }, '■ '), h(Text, { bold: true }, task.assignee), ` · ${first}`),
          h(Text, { color: t.color.muted }, meta)
        ),
        ...(second ? [h(Text, { key: `${task.id}-t`, color: t.color.muted }, `  ${second}`)] : []),
        ...(task.note ? [h(Text, { key: `${task.id}-n`, color: t.color.muted }, clip(`  ↳ ${task.note}`, width))] : [])
      ]
    })

    if (data.tasks.length > shown.length) {
      rows.push(h(Text, { key: 'more', color: t.color.muted }, `+${data.tasks.length - shown.length} agent lain lagi running`))
    }

    return rows.length ? h(Box, { flexDirection: 'column' }, ...rows) : null
  }

  const top = defineWidgetApp({
    id: 'frame-top',
    help: 'garis di atas input (gaya Claude Code)',
    mode: 'ambient',
    zone: 'dock-top',
    init: () => ({}),
    reduce: state => state,
        // Zero-height host + absolute child: Ink skips a zero-height box that shares a row with a sibling unless it has an
    // absolute descendant, so the rule is drawn on the composer's blank margin row instead of vanishing.
    render: ({ cols, t }) =>
      h(Box, { height: 0, width: Math.max(1, cols - 2) }, h(Box, { position: 'absolute', top: 0, left: 0 }, rule(cols, t)))
  })

  const bottom = defineWidgetApp({
    id: 'frame-bottom',
    help: 'garis di bawah input + agent yang lagi running + jarak ke status bar',
    mode: 'ambient',
    zone: 'dock-bottom',
    init: () => ({}),
    reduce: state => state,
    render: ({ cols, t }) =>
      h(
        Box,
        { flexDirection: 'column' },
        h(Box, { key: 'rule' }, rule(cols, t)),
        h(Running, { key: 'running', cols, t }),
        blank('below')
      )
  })

  sdk.openWidget(top, top.init(''))
  sdk.openWidget(bottom, bottom.init(''))
}
