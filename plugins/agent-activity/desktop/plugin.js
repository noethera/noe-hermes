/**
 * agent-activity — desktop half: an "Aktivitas agent" pane and a status-bar chip.
 * Polls the plugin's own backend (dashboard/plugin_api.py → GET /state), which reads the journal the hooks write.
 * Polling is adaptive: fast while something is running, backing off when everything is idle, paused while the
 * window is hidden. State only changes when the data does; the "… lalu" labels run on their own slower clock.
 */
import { atom, cn, useValue } from '@hermes/plugin-sdk'
import { memo } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const POLL_ACTIVE_MS = 1500
const POLL_IDLE_MS = [5000, 15000]  // backoff steps while nothing is running
const CLOCK_MS = 10000
const state = atom({ agents: [], tasks: [], error: null })
const clock = atom(Date.now() / 1000)

const STATUS = {
  working: { label: 'bekerja', dot: '#34c759' },
  thinking: { label: 'berpikir', dot: '#0a84ff' },
  waiting: { label: 'menunggu', dot: '#ff9f0a' },
  error: { label: 'error', dot: '#ff453a' },
  idle: { label: 'diam', dot: '#8e8e93' }
}

const TOOL_LABEL = {
  terminal: 'terminal', shell: 'terminal', execute_code: 'jalankan kode', read_file: 'baca file',
  write_file: 'tulis file', patch: 'edit file', search_files: 'cari file', web_search: 'cari web',
  web_extract: 'baca web', browser_navigate: 'browser', kanban_comment: 'komentar Kanban',
  kanban_complete: 'selesaikan tugas', kanban_block: 'minta input', kanban_create: 'buat tugas',
  kanban_request_review: 'minta review', delegate_task: 'delegasi', thinking: 'berpikir', writing: 'menulis balasan',
  waiting: 'menunggu', error: 'error'
}

function ago(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} dtk`
  if (s < 3600) return `${Math.floor(s / 60)} mnt`
  return `${Math.floor(s / 3600)} jam`
}

const label = what => TOOL_LABEL[what] ?? what

function Dot({ status }) {
  const color = (STATUS[status] ?? STATUS.idle).dot
  return jsx('span', {
    'aria-hidden': true,
    className: cn('mt-1 inline-block size-2 shrink-0 rounded-full', status === 'working' && 'animate-pulse'),
    style: { background: color }
  })
}

const AgentRow = memo(function AgentRow({ agent, now }) {
  const st = STATUS[agent.status] ?? STATUS.idle
  const cur = agent.current
  const multi = (agent.active_count || 0) > 1
  const where = agent.context?.type === 'kanban' ? `tugas ${agent.context.task_id}` : agent.context?.type === 'room' ? 'grup' : ''
  return jsxs('div', {
    className: 'flex gap-2 rounded-md px-2 py-1.5 hover:bg-(--ui-bg-secondary)',
    children: [
      jsx(Dot, { status: agent.status }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsxs('div', {
            className: 'flex items-baseline justify-between gap-2',
            children: [
              jsx('span', { className: 'truncate font-medium', children: agent.name }),
              jsx('span', {
                className: 'shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: agent.status === 'idle' ? `${st.label} · ${ago(now - agent.last_ts)} lalu` : st.label
              })
            ]
          }),
          multi
            ? // More than one concurrent session (e.g. two kanban tasks on the same profile) — a
              // single `current` detail would clobber the other, so show the count instead.
              jsx('div', {
                className: 'text-[0.75rem] font-medium text-(--ui-text-secondary)',
                children: `${agent.active_count} tugas sedang dikerjakan`
              })
            : cur
              ? jsxs('div', {
                  className: 'text-[0.75rem] text-(--ui-text-secondary)',
                  children: [
                    jsx('span', { className: 'font-medium', children: label(cur.what) }),
                    cur.since ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: ` · ${ago(now - cur.since)}` }) : null,
                    where ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: ` · ${where}` }) : null,
                    cur.detail
                      ? jsx('div', {
                          className: 'mt-0.5 line-clamp-2 break-all font-mono text-[0.6875rem] text-(--ui-text-tertiary)',
                          children: cur.detail
                        })
                      : null
                  ]
                })
              : null
        ]
      })
    ]
  })
})

const TaskRow = memo(function TaskRow({ task, now }) {
  const c = task.last_comment
  return jsxs('div', {
    className: 'rounded-md px-2 py-1.5 text-[0.75rem]',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsx('span', { className: 'truncate font-medium', children: task.title }),
          jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: task.status })
        ]
      }),
      jsx('div', {
        className: 'text-(--ui-text-tertiary)',
        children: `${task.id} · ${task.assignee ?? '—'}${task.started_at ? ` · ${ago(now - task.started_at)}` : ''}`
      }),
      c ? jsx('div', { className: 'mt-0.5 line-clamp-2 text-(--ui-text-secondary)', children: `${c.author}: ${c.text}` }) : null
    ]
  })
})

function Section({ title, children }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('div', {
        className: 'px-2 pt-2 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: title
      }),
      ...children
    ]
  })
}

function ActivityPane() {
  const { agents, tasks, error } = useValue(state)
  const now = useValue(clock)
  const active = agents.filter(a => a.status !== 'idle')
  const idle = agents.filter(a => a.status === 'idle')
  return jsxs('div', {
    className: 'flex h-full flex-col gap-1 overflow-y-auto p-2 text-sm',
    children: [
      error ? jsx('div', { className: 'px-2 text-[0.75rem] text-(--ui-text-tertiary)', children: `Backend belum siap: ${error}` }) : null,
      jsx(Section, {
        title: 'Sedang jalan',
        children: active.length
          ? active.map(a => jsx(AgentRow, { agent: a, now }, a.agent))
          : [jsx('div', { className: 'px-2 text-[0.75rem] text-(--ui-text-tertiary)', children: 'Tidak ada agent yang sedang bekerja.' }, 'none')]
      }),
      tasks.length
        ? jsx(Section, { title: 'Tugas Kanban aktif', children: tasks.map(t => jsx(TaskRow, { task: t, now }, t.id)) })
        : null,
      idle.length ? jsx(Section, { title: 'Terakhir aktif', children: idle.map(a => jsx(AgentRow, { agent: a, now }, a.agent)) }) : null
    ]
  })
}

function Chip() {
  const { agents } = useValue(state)
  const busyAgents = agents.filter(a => a.status === 'working' || a.status === 'thinking')
  // Sum concurrent sessions, not agent count: one profile running 2 kanban tasks must read as 2.
  const busy = busyAgents.reduce((n, a) => n + Math.max(1, a.active_count || 1), 0)
  const waiting = agents.filter(a => a.status === 'waiting').length
  if (!busy && !waiting) return null
  return jsxs('span', {
    className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
    title: 'Buka panel "Aktivitas agent" untuk detail',
    children: [
      jsx(Dot, { status: busy ? 'working' : 'waiting' }),
      busy ? `${busy} tugas bekerja` : `${waiting} menunggu kamu`
    ]
  })
}

export default {
  id: 'agent-activity',
  name: 'Aktivitas agent',
  register(ctx) {
    let timer = null
    let inFlight = false
    let idleStep = 0
    let fingerprint = ''
    const schedule = ms => {
      timer?.()
      timer = ctx.setTimeout(poll, ms)
    }
    const poll = async () => {
      timer = null
      if (inFlight || document.visibilityState === 'hidden') return  // hidden: resumed by the visibilitychange listener
      inFlight = true
      let busy = false  // a failed poll backs off like an idle one
      try {
        const data = await ctx.rest('/state', { timeoutMs: 4000 })
        const agents = data.agents ?? []
        const tasks = data.tasks ?? []
        // Fast only while something moves; waiting/blocked states change on human time, so they back off too.
        busy = tasks.some(t => t.status === 'running') || agents.some(a => a.status === 'working' || a.status === 'thinking')
        const next = JSON.stringify([agents, tasks])
        if (next !== fingerprint || state.get().error) {
          fingerprint = next
          state.set({ agents, tasks, error: null })
          clock.set(data.now ?? Date.now() / 1000)
        }
      } catch (err) {
        state.set({ ...state.get(), error: String(err?.message ?? err) })
      } finally {
        inFlight = false
      }
      idleStep = busy ? 0 : Math.min(idleStep + 1, POLL_IDLE_MS.length)
      schedule(idleStep ? POLL_IDLE_MS[idleStep - 1] : POLL_ACTIVE_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !timer && !inFlight) {
        idleStep = 0
        poll()
      }
    }
    ctx.addEventListener(document, 'visibilitychange', onVisibility)
    poll()
    ctx.setInterval(() => clock.set(Date.now() / 1000), CLOCK_MS)

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Aktivitas agent',
      data: { placement: 'right', width: '300px' },
      render: () => jsx(ActivityPane, {})
    })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => jsx(Chip, {}) })
  }
}
