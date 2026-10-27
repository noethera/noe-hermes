/**
 * bot-heartbeat — shows in the Bots roster WHICH bot is working and ON WHAT.
 *
 * The stock roster only shows the canonical Bot Chat's preview + dot; work in
 * a kanban worker or in another chat tab of the same bot is invisible (and the
 * built-in "work" mood is only drawn on Geometric faces). This plugin:
 *   1. polls session.active_list every 3s — the gateway's LIVE sessions with
 *      status working / waiting / idle (authoritative for long turns, where
 *      last_activity_at can sit still for minutes),
 *   2. polls profiles.list every 5s to map those sessions to bots and to read
 *      kanban/tool worker heartbeats (workers stamp last_activity_at <= 60s),
 *   3. polls its own backend (dashboard/plugin_api.py → GET /counts) for how
 *      many Kanban tasks are `running` per profile right now — profiles.list's
 *      `worker_session` is a single field, so two concurrent kanban workers on
 *      the same profile would otherwise clobber into one stale task; when the
 *      count is >1 the activity line shows "N tugas berjalan" instead,
 *   4. injects CSS: thin green ring on the avatar (1.5px, static, no animation) + an activity line
 *      ("⚙ Kanban · SDK-2.1.19-APIFIX …") under the row's preview,
 *   5. shows a status-bar chip "Working: …" with details on hover.
 *
 * Pure CSS on the roster's data-roster-key hook — no DOM mutation.
 * Plain ESM, loaded uncompiled. Only @hermes/plugin-sdk / react resolve.
 */

import { atom, cn, host, Tip, useQuery, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'bot-heartbeat'
const WORKER_WINDOW_S = 150 // workers stamp last_activity_at every <=60s
const CHAT_WINDOW_S = 90 // same "active now" window the roster uses
const PROFILES_POLL_MS = 10000
const LIVE_POLL_MS = 8000
const COUNTS_POLL_MS = 10000

// { [profile]: n } — how many Kanban tasks are `running` right now for that profile, from our own
// backend (profiles.list's worker_session is a single field; it can't tell two concurrent kanban
// workers on the same profile apart — see dashboard/plugin_api.py). Updated by a poll loop started
// in register(ctx), since ctx.rest is only reachable there, not from this module-level component.
const kanbanCounts = atom({})

const SOURCE_LABEL = {
  kanban: '⚙ Kanban',
  tool: '⚙ Subagent',
  cron: '⏱ Routine',
  oneshot: '✉ Pesan',
  delegate: '⚙ Subagent'
}

/** stored session id → live state, for every live session on the gateway.
 *  `bg` = running background processes (terminal background=true) that
 *  outlived the turn — the session reads "idle" but the bot is still busy. */
function liveMap(result) {
  const map = new Map()

  for (const s of Array.isArray(result?.sessions) ? result.sessions : []) {
    const status = String(s?.status || '')
    const bg = Array.isArray(s?.bg) ? s.bg : []
    const busy = status === 'working' || status === 'starting' || status === 'waiting'
    const key = String(s?.session_key || s?.id || '')

    if (key && (busy || bg.length)) {
      map.set(key, { status, bg, title: String(s.title || ''), preview: String(s.preview || '') })
    }
  }

  return map
}

/** Live sessions with running bg processes that no profile row claims by id:
 *  attribute them by the profile path in their commands
 *  (e.g. "S=~/.hermes/profiles/jarvis/cache/scratch"). */
function orphanBgByProfile(map, claimed) {
  const out = new Map()

  for (const [key, hit] of map) {
    if (claimed.has(key) || !hit.bg.length) {
      continue
    }

    for (const p of hit.bg) {
      const m = /\/profiles\/([A-Za-z0-9_-]+)\//.exec(String(p.command || ''))

      if (m && !out.has(m[1])) {
        out.set(m[1], hit)
      }
    }
  }

  return out
}

/** Live list + each live session's background processes (process.list). */
async function fetchLive() {
  const res = await host.request('session.active_list', {})
  const sessions = Array.isArray(res?.sessions) ? res.sessions : []

  await Promise.all(
    sessions.map(async s => {
      try {
        const r = await host.request('process.list', { session_id: s.id })
        s.bg = (Array.isArray(r?.processes) ? r.processes : []).filter(p => p?.status === 'running')
      } catch {
        s.bg = []
      }
    })
  )

  return { sessions }
}

const bgLine = bg => {
  const cmd = String(bg[0]?.command || '').replace(/\s+/g, ' ').trim()

  return `${bg.length} proses${cmd ? ` · ${cmd.slice(0, 80)}` : ''}`
}

function sessionIdsOf(row) {
  const ids = []
  const push = (v, title) => v && ids.push([String(v), title])

  push(row?.last_session?.id, row?.last_session?.title)
  push(row?.canonical_session?.id, 'Bot Chat')
  push(row?.canonical_session?.resolved_id, 'Bot Chat')
  push(row?.worker_session?.id, row?.worker_session?.title)

  return ids
}

function activityOf(row, now, live, orphans) {
  const canon = row?.canonical_session
  const isCanonical = id => Boolean(canon && (id === canon.id || id === canon.resolved_id))

  // 1. Live turn on the gateway — authoritative, no time window needed.
  for (const [id, fallbackTitle] of sessionIdsOf(row)) {
    const hit = live.get(id)

    if (hit && hit.status !== 'idle') {
      const waiting = hit.status === 'waiting'
      const title = hit.title || fallbackTitle || 'Chat'

      return {
        kind: waiting ? '⏸ Butuh input' : isCanonical(id) ? '💬 Bot Chat' : '💬 Chat',
        title,
        detail: hit.preview,
        waiting,
        // Bot Chat already shows its own preview in the row; only flag waiting.
        noLine: isCanonical(id) && !waiting
      }
    }
  }

  // 2. Turn ended but background processes still running.
  const bgHit =
    sessionIdsOf(row)
      .map(([id]) => live.get(id))
      .find(h => h?.bg?.length) || orphans.get(String(row?.name || ''))

  if (bgHit) {
    return { kind: '⚙ Background', title: bgLine(bgHit.bg), detail: bgHit.title }
  }

  // 2. Kanban / tool worker heartbeat.
  const w = row?.worker_session
  const wTs = Number(w?.last_active || 0)

  if (wTs && now - wTs < WORKER_WINDOW_S) {
    return {
      kind: SOURCE_LABEL[String(w.source || '').toLowerCase()] || '⚙ Worker',
      title: String(w.title || ''),
      detail: `heartbeat ${Math.round(now - wTs)}s ago`
    }
  }

  // 3. Fallback: something written very recently (e.g. another machine).
  const s = row?.last_session
  const sTs = Number(s?.last_active || 0)

  if (s && sTs && now - sTs < CHAT_WINDOW_S) {
    return {
      kind: isCanonical(s.id) ? '💬 Bot Chat' : '💬 Chat',
      title: String(s.title || 'Chat'),
      detail: `${Math.round(now - sTs)}s ago`,
      noLine: isCanonical(s.id)
    }
  }

  return null
}

function workingBots(profiles, live, counts) {
  const rows = Array.isArray(profiles?.profiles) ? profiles.profiles : []
  const now = Date.now() / 1000
  const map = liveMap(live)
  const claimed = new Set(rows.flatMap(row => sessionIdsOf(row).map(([id]) => id)))
  const orphans = orphanBgByProfile(map, claimed)

  return rows
    .map(row => {
      const name = String(row.name || 'default')
      const act = activityOf(row, now, map, orphans)

      if (!act) {
        return null
      }

      // More than one Kanban task running on this profile at once: the single `title`/`detail`
      // above can only ever reflect ONE of them (same source limitation that blocks a "open its
      // live session" button — see bot-heartbeat's plugin_api.py), so show a count instead of
      // whichever task happened to win.
      const n = act.kind === SOURCE_LABEL.kanban ? Number(counts?.[name] || 0) : 0
      const merged = n > 1 ? { ...act, title: `${n} tugas berjalan`, detail: '' } : act

      return { name, label: String(row.display_name || row.name || 'default'), ...merged }
    })
    .filter(Boolean)
}

// CSS string literal: escape backslashes, quotes and newlines.
const cssString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
const cssAttr = s => (globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'))
const rowSel = name => `[data-roster-key$="::${cssAttr(name)}"]`
const list = (bots, suffix) => bots.map(b => `${rowSel(b.name)}${suffix}`).join(',\n') || '.hb-none'

function cssFor(bots) {
  if (!bots.length) {
    return ''
  }

  const working = bots.filter(b => !b.waiting)
  const waiting = bots.filter(b => b.waiting)
  const withLine = bots.filter(b => !b.noLine)

  return `
:root { --hb-green: var(--ui-success, #10b981); --hb-amber: #f59e0b; --hb-ring-width: 1.5px; }
/* STATIC on purpose: no animation of any kind. Even a compositor-only
   transform/opacity pulse makes Chromium render a new frame every vsync for as
   long as a bot is busy (Kanban workers keep bots busy for hours), and under a
   glass window WindowServer re-blurs every one of those frames. Ring + dot +
   activity line already say "working". tools/perf-lint.sh enforces this. */
${list(working, ' > div:first-child')} { --hb-ring: var(--hb-green); }
${list(waiting, ' > div:first-child')} { --hb-ring: var(--hb-amber); }
${list(bots, ' > div:first-child')} {
  position: relative;
  outline: var(--hb-ring-width) solid var(--hb-ring);
  outline-offset: calc(-1 * var(--hb-ring-width));
}
${list(bots, ' > div:first-child::after')} {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--hb-ring);
  border: 2px solid var(--ui-sidebar-background, var(--background, transparent));
}
${list(withLine, ' > div.min-w-0::after')} {
  display: block;
  margin-top: 2px;
  font-size: 0.6875rem;
  line-height: 1rem;
  color: var(--hb-green);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
${list(waiting.filter(b => !b.noLine), ' > div.min-w-0::after')} { color: var(--hb-amber); }
/* Active row: the activity line replaces the preview — keep the row 2 lines. */
${list(withLine, ' > div.min-w-0 > div:nth-child(2)')} { display: none !important; }
${withLine.map(b => `${rowSel(b.name)} > div.min-w-0::after { content: ${cssString(`${b.kind} · ${b.title}`)}; }`).join('\n')}
`
}

function HeartbeatChip() {
  const profiles = useQuery({
    queryKey: ['plugin', ID, 'profiles'],
    queryFn: () => host.request('profiles.list', {}),
    refetchInterval: PROFILES_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0
  })

  const live = useQuery({
    queryKey: ['plugin', ID, 'live'],
    queryFn: fetchLive,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false
  })

  const counts = useValue(kanbanCounts)
  const bots = workingBots(profiles.data, live.data, counts)
  const tip = bots
    .map(b => `${b.label} — ${b.kind}: ${b.title}${b.detail ? `\n   ${b.detail.slice(0, 120)}` : ''}`)
    .join('\n')

  return jsxs('span', {
    className: 'inline-flex h-full items-center',
    children: [
      jsx('style', { children: cssFor(bots) }),
      bots.length
        ? jsx(Tip, {
            label: jsx('span', { style: { whiteSpace: 'pre-line' }, children: tip }),
            children: jsxs('span', {
              className: cn(
                'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem]',
                'text-(--ui-text-secondary)'
              ),
              children: [
                jsx('span', {
                  style: {
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--hb-green)'
                  }
                }),
                `Working: ${bots.map(b => b.label).join(', ')}`
              ]
            })
          })
        : null
    ]
  })
}

// Always-on: shrink every roster avatar inside its 34px slot so the pulse
// ring (drawn on the slot) has clear space around it, and equalise sizes:
// photos/geometric faces fill ~90–100% of the slot, blob faces only ~64%.
// Targets ≈ 25–26px for all of them.
const SIZE_CSS = `
[data-roster-key] > div:first-child {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 26%;
}
[data-roster-key] > div:first-child img {
  transform: scale(0.76);
}
[data-roster-key] > div:first-child svg[data-bot-face]:not([viewBox="0 0 100 100"]) {
  transform: scale(0.8);
}
[data-roster-key] > div:first-child svg[data-bot-face][viewBox="0 0 100 100"] {
  transform: scale(1.15);
  overflow: visible;
}
`

function mountSizeStyle() {
  const id = 'hermes-plugin-bot-heartbeat-size'
  document.getElementById(id)?.remove()
  const el = document.createElement('style')
  el.id = id
  el.textContent = SIZE_CSS
  document.head.appendChild(el)

  return () => el.remove()
}

export default {
  id: ID,
  name: 'Bot Heartbeat',
  register(ctx) {
    ctx.onDispose?.(mountSizeStyle())

    // Counts poll: separate from the profiles/live useQuery polls above because ctx.rest is only
    // reachable here, inside register(ctx) — not from the module-level HeartbeatChip component.
    const pollCounts = async () => {
      if (document.visibilityState === 'hidden') return // hidden window: nobody sees the counts
      try {
        kanbanCounts.set(await ctx.rest('/counts', { timeoutMs: 4000 }))
      } catch {
        // backend not enabled yet / transient failure — keep the last known counts, degrade silently
      }
    }
    pollCounts()
    const countsTimer = ctx.setInterval(pollCounts, COUNTS_POLL_MS)
    ctx.onDispose?.(() => countsTimer?.())

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(HeartbeatChip, {})
    })
  }
}
