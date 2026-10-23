/**
 * session-tab-bot-icon — shows a small avatar/pet icon on the left edge of
 * each session tab, so a window with several chat tabs open across
 * different bots/profiles reads at a glance which bot owns which tab.
 *
 * IMPORTANT: icons render in a SEPARATE overlay layer appended to
 * `document.body`, positioned with `getBoundingClientRect()` over each tab —
 * never as a child inserted into `.pane-tab-content` itself. That container
 * is React-reconciled (keyed by `paneId`); an extra untracked child there
 * desyncs React's own `insertBefore`/position bookkeeping for that tab strip,
 * and on the next reconcile (a tab opened, closed, or reordered) React can
 * mis-attribute a DOM node to the wrong logical tab — surfacing as "opening
 * a session replaces an existing tab" or "a closed tab reappears". The
 * overlay approach never touches React's tree, so it cannot cause that class
 * of bug no matter how often tabs open/close/reorder.
 *
 * Data source, two RPCs (same pair the Bots roster itself uses, see
 * hermes-bots/profile-ops.ts pullServerAvatars):
 *  1. `profiles.list` — every bot row, which session ids it currently owns
 *     (`last_session` / `canonical_session` / `worker_session`), and
 *     `has_avatar` (a flag only — the image bytes are NOT inlined here).
 *  2. `profiles.get_asset` ({ name, asset: 'avatar' }) — fetched per bot ONLY
 *     when `has_avatar` is true, returns `{ found, data }` where `data` is
 *     the actual data-URI (covers a picked petdex companion, a generated
 *     face PNG, or an uploaded photo uniformly — the roster doesn't
 *     distinguish). Cached per profile name so it's fetched once, not every
 *     poll tick.
 *
 * A bot with no avatar at all (shape-only, `has_avatar: false`) falls back to
 * a small generated initial/color chip instead of leaving the tab bare.
 */

import { host, PALETTE_AREA } from '@hermes/plugin-sdk'

const ID = 'session-tab-bot-icon'
const POLL_MS = 5000
const SWEEP_MS = 45_000
const STYLE_ID = 'stbi-style'
const OVERLAY_ID = 'stbi-overlay'
const ICON_CLASS = 'stbi-icon'
const ICON_SIZE = 16
const ICON_LEFT_INSET = 8
const TILE_PREFIX = 'session-tile:'

const CSS_TEXT = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  z-index: 40;
}
.${ICON_CLASS} {
  position: fixed;
  width: ${ICON_SIZE}px;
  height: ${ICON_SIZE}px;
  border-radius: 4px;
  object-fit: cover;
  pointer-events: none;
}
.${ICON_CLASS}[data-generated="1"] {
  display: grid;
  place-items: center;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  text-transform: uppercase;
  user-select: none;
}
/* The icon lives in a separate overlay layer (see register() below), not as
   a flex child of .pane-tab-content — so unlike a real flex sibling, it does
   NOT push the tab's own title text over on its own. Reserve the room
   ourselves: [data-tree-tab] gets a marker attribute (not a new child node —
   just an attribute on the tab's OWN root, which React never reads/manages)
   whenever that tab has an icon, and this rule pads .pane-tab-content so the
   title starts clear of the icon instead of overlapping it. */
[data-tree-tab][data-stbi-has-icon="1"] .pane-tab-content {
  padding-left: ${ICON_LEFT_INSET + ICON_SIZE - 6}px;
}
/* A little more breathing room around the icon — the stock tab bar (h-9,
   36px) was sized for text-only tabs. Targets the tab STRIP container
   (components/pane-shell/tree/renderer/tree-group.tsx's
   data-zone-tabstrip), not individual PaneTab cells, so every tab in the
   row grows together and stays aligned. Pure CSS property override, no DOM
   node added/removed — safe alongside React's own reconciliation. */
[data-zone-tabstrip] {
  height: 40px !important;
}
`

/** Every live session id this profile row currently owns (mirrors
 *  bot-heartbeat's sessionIdsOf — last/canonical/worker session). */
function sessionIdsOf(row) {
  const ids = []
  const push = v => v && ids.push(String(v))

  push(row?.last_session?.id)
  push(row?.canonical_session?.id)
  push(row?.canonical_session?.resolved_id)
  push(row?.worker_session?.id)

  return ids
}

function sessionIdFromPaneId(paneId) {
  return paneId && paneId.startsWith(TILE_PREFIX) ? paneId.slice(TILE_PREFIX.length) : null
}

const WORKSPACE_PANE_ID = 'workspace'

/** Deterministic HSL color from a profile name — same name always gets the
 *  same color across tabs/restarts, different names spread across the wheel. */
function colorFor(name) {
  let hash = 0

  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }

  return `hsl(${hash % 360}, 55%, 42%)`
}

function initialOf(name) {
  return (name || '?').trim().charAt(0) || '?'
}

export default {
  id: ID,
  name: 'Session Tab Bot Icon',
  description: 'Shows which bot owns a session tab with a small avatar icon on its left edge.',
  register(ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')

      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
      ctx.onDispose(() => style.remove())
    }

    // The overlay root lives OUTSIDE any React-managed subtree — it's a
    // sibling of the app's own #root, appended directly to <body>. Nothing
    // here is ever inserted into a React-reconciled container.
    function ensureOverlay() {
      let root = document.getElementById(OVERLAY_ID)

      if (!root) {
        root = document.createElement('div')
        root.id = OVERLAY_ID
        document.body.appendChild(root)
        ctx.onDispose(() => root.remove())
      }

      return root
    }

    // storedSessionId -> { name, label, hasAvatar }. Two sources merged in:
    // the fast "pointer" map (profiles.list's last/canonical/worker session —
    // refreshed every POLL_MS) and the slow "exhaustive" map (every STORED
    // session per profile via session.list — refreshed every SWEEP_MS). A tab
    // on an OLDER session than a bot's current "last_session" pointer only
    // ever resolves through the exhaustive sweep.
    let pointerMap = new Map()
    let sweepMap = new Map()
    let iconBySession = new Map()
    // profile name -> { name, label, hasAvatar }, kept across both maps so the
    // sweep (which has no has_avatar/display_name of its own) can label its ids.
    let profileInfo = new Map()
    // profile name -> avatar data-URI, fetched once via profiles.get_asset.
    const avatarCache = new Map()
    // profile name -> in-flight fetch promise, so a poll tick never double-fires.
    const avatarInflight = new Map()
    let lastDiagnostics = null
    // Sticky: once resolved while the workspace tab was active, remembered so
    // it keeps showing even after a different tab becomes active (the
    // session sitting in 'workspace' doesn't vanish just because it lost
    // focus — we just lose VISIBILITY into it until it's active again).
    let lastWorkspaceEntry = null

    function mergeMaps() {
      iconBySession = new Map([...sweepMap, ...pointerMap])
    }

    function fetchAvatar(name) {
      if (avatarCache.has(name) || avatarInflight.has(name)) {
        return avatarInflight.get(name) || Promise.resolve(avatarCache.get(name))
      }

      const req = host
        .request('profiles.get_asset', { name, asset: 'avatar' })
        .then(res => {
          const data = res && res.found && typeof res.data === 'string' ? res.data : null

          avatarCache.set(name, data)

          return data
        })
        .catch(() => {
          avatarCache.set(name, null)

          return null
        })
        .finally(() => {
          avatarInflight.delete(name)
        })

      avatarInflight.set(name, req)

      return req
    }

    function entryFor(tab) {
      const paneId = tab.getAttribute('data-tree-tab')
      const sid = sessionIdFromPaneId(paneId)
      let entry = sid ? iconBySession.get(sid) : undefined

      // The primary/home pane ('workspace') carries no per-session paneId of
      // its own — it's whatever chat the user navigated it to, so it never
      // matches a `session-tile:<id>` lookup. While THIS tab is the one
      // currently active/focused, host.state tells us exactly which stored
      // session (and owning profile) that is — remembered (sticky) so the
      // icon keeps showing even after a different tab becomes active,
      // instead of vanishing the moment this one loses focus.
      //
      // Guard: `focusedStoredSessionId` tracks whichever chat has keyboard
      // focus APP-WIDE, not specifically "what's inside workspace" — the
      // instant a session-tile tab is clicked, this id updates to ITS
      // session even though that content lives in a sibling tab, not
      // workspace. If some OTHER currently-visible tab already owns this
      // exact session id, it's that tab's content, never workspace's.
      if (!entry && paneId === WORKSPACE_PANE_ID) {
        if (tab.getAttribute('data-active') === 'true') {
          const focusedSid = host.state.focusedStoredSessionId?.get?.()
          const focusedProfile = host.state.focusedSessionProfile?.get?.()
          const ownedElsewhere =
            focusedSid &&
            [...document.querySelectorAll('[data-tree-tab]')].some(
              other => other !== tab && sessionIdFromPaneId(other.getAttribute('data-tree-tab')) === focusedSid
            )

          if (focusedSid && focusedProfile && !ownedElsewhere) {
            lastWorkspaceEntry = profileInfo.get(focusedProfile) || {
              name: focusedProfile,
              label: focusedProfile,
              hasAvatar: false
            }
          }
        }

        entry = lastWorkspaceEntry || undefined
      }

      return entry
    }

    // paneId -> overlay icon element (O(1) instead of scanning overlay.children per tab).
    const iconByPane = new Map()
    // Tabs seen on the last pass — lets the scroll filter below ask "did this
    // scroll move a tab?" with a cheap contains() instead of a querySelector.
    let lastTabs = []

    function setAttr(el, name, value) {
      if (value === null) {
        if (el.hasAttribute(name)) el.removeAttribute(name)
      } else if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value)
      }
    }

    function setStyle(el, prop, value) {
      if (el.style[prop] !== value) el.style[prop] = value
    }

    function dropIcon(key) {
      iconByPane.get(key)?.remove()
      iconByPane.delete(key)
    }

    // WRITE phase for one tab. All geometry was read beforehand (see applyAll),
    // so nothing in here forces a synchronous layout.
    function writeTab(tab, key, entry, rect, overlay) {
      if (!entry || !rect || (rect.width === 0 && rect.height === 0)) {
        // No owner, or not laid out (collapsed/offscreen zone) — nothing to draw over.
        dropIcon(key)
        setAttr(tab, 'data-stbi-has-icon', null)

        return
      }

      setAttr(tab, 'data-stbi-has-icon', '1')

      const image = entry.hasAvatar ? avatarCache.get(entry.name) : null
      const wantTag = image ? 'IMG' : 'DIV'
      let el = iconByPane.get(key) || null

      if (el && (el.tagName !== wantTag || !el.isConnected)) {
        el.remove()
        el = null
      }

      if (!el) {
        el = document.createElement(image ? 'img' : 'div')
        el.className = ICON_CLASS
        el.setAttribute('data-stbi-pane', key)
        overlay.appendChild(el)
        iconByPane.set(key, el)
      }

      setStyle(el, 'left', `${Math.round(rect.left + ICON_LEFT_INSET)}px`)
      setStyle(el, 'top', `${Math.round(rect.top + (rect.height - ICON_SIZE) / 2)}px`)

      if (image) {
        if (el.alt !== '') el.alt = ''
        setAttr(el, 'data-generated', null)

        if (el.src !== image) {
          el.src = image
        }
      } else {
        setAttr(el, 'data-generated', '1')
        if (el.title !== entry.label) el.title = entry.label
        setStyle(el, 'background', colorFor(entry.name))

        const letter = initialOf(entry.label)

        if (el.textContent !== letter) {
          el.textContent = letter
        }

        // Kick off (or let an in-flight one finish) the real avatar fetch —
        // applyAll reruns via the MutationObserver / next poll and upgrades
        // the chip to the real image once it lands.
        if (entry.hasAvatar && !avatarCache.has(entry.name)) {
          fetchAvatar(entry.name).then(() => scheduleApplyAll())
        }
      }
    }

    function applyAll() {
      const overlay = ensureOverlay()
      const tabs = [...document.querySelectorAll('[data-tree-tab]')]

      // READ phase: resolve owners and read every tab's geometry BEFORE any
      // DOM write. The old loop interleaved getBoundingClientRect with
      // setAttribute/style writes per tab, forcing a full synchronous layout
      // for every tab on every frame (layout thrashing) — worst exactly when a
      // tab opens and the whole strip has just been re-rendered.
      const plan = tabs.map(tab => {
        const key = tab.getAttribute('data-tree-tab') || ''
        const entry = entryFor(tab)

        // getBoundingClientRect on the tab ROOT, not .pane-tab-content: the
        // overlay is a sibling layer, so we only need where the tab sits.
        return { tab, key, entry, rect: entry ? tab.getBoundingClientRect() : null }
      })

      // WRITE phase.
      const seenKeys = new Set()

      for (const { tab, key, entry, rect } of plan) {
        seenKeys.add(key)
        writeTab(tab, key, entry, rect, overlay)
      }

      // A tab that closed/vanished leaves no [data-tree-tab] behind — drop
      // its orphaned overlay icon.
      for (const key of [...iconByPane.keys()]) {
        if (!seenKeys.has(key)) dropIcon(key)
      }

      lastTabs = tabs
      watchStrips(tabs)
      maybeSweepSoon()
    }

    // A freshly opened tab on an older session resolves only via the sweep —
    // run it shortly after the tab appears instead of waiting up to SWEEP_MS.
    let sweepSoonPending = false

    function maybeSweepSoon() {
      if (sweepSoonPending || sweeping) return

      const now = Date.now()
      const needs = lastTabs.some(tab => {
        const sid = sessionIdFromPaneId(tab.getAttribute('data-tree-tab'))

        return sid && !iconBySession.has(sid) && now - (triedUnresolved.get(sid) || 0) > RETRY_UNRESOLVED_MS
      })

      if (!needs) return

      sweepSoonPending = true
      ctx.setTimeout(() => {
        sweepSoonPending = false
        void sweep()
      }, 400)
    }

    // Debounced to the next animation frame: React's DOM commit (data-active
    // flipping, tabs opening/closing) and the store write that drives
    // focusedStoredSessionId can land in different microtask ticks around a
    // tab switch — reading either mid-transition is how the workspace
    // heuristic above could briefly pair a stale "active" tab with the NEW
    // focused session. rAF runs after the browser has painted the frame,
    // well past that window — and coalesces bursts (scroll, resize, several
    // mutations in one tick) into a single recompute.
    let applyScheduled = false

    function scheduleApplyAll() {
      if (applyScheduled) {
        return
      }

      applyScheduled = true
      requestAnimationFrame(() => {
        applyScheduled = false
        applyAll()
      })
    }

    async function refresh() {
      try {
        const result = await host.request('profiles.list', {})
        const rows = Array.isArray(result?.profiles) ? result.profiles : []
        const map = new Map()
        const info = new Map()
        let withAvatarFlag = 0

        for (const row of rows) {
          const name = String(row?.name || '')
          const label = String(row?.display_name || name || '?')
          const hasAvatar = Boolean(row?.has_avatar)
          const entry = { name, label, hasAvatar }

          info.set(name, entry)

          if (hasAvatar) {
            withAvatarFlag += 1
          }

          for (const id of sessionIdsOf(row)) {
            map.set(id, entry)
          }
        }

        pointerMap = map
        profileInfo = info
        mergeMaps()
        lastDiagnostics = {
          ...lastDiagnostics,
          ok: true,
          profiles: rows.length,
          withAvatarFlag,
          sessionIdsMapped: iconBySession.size
        }
        scheduleApplyAll()
      } catch (error) {
        lastDiagnostics = { ...lastDiagnostics, ok: false, error: error instanceof Error ? error.message : String(error) }
        // Transient gateway hiccup — the next poll tick retries.
      }
    }

    // Exhaustive sweep: profiles.list only ever points at ONE session per
    // profile (last/canonical/worker) — a tab on an OLDER session for that
    // same bot never matches it. session.list, called PER PROFILE, returns
    // every stored session that profile has, so a tab from last week still
    // resolves. Heavier (one RPC per profile) — runs far less often than the
    // pointer refresh.
    let sweeping = false
    // sid -> timestamp of the last full sweep that still failed to resolve it,
    // so an unresolvable tab (e.g. a session from a deleted profile) doesn't
    // re-trigger a full all-profiles sweep every SWEEP_MS forever.
    const triedUnresolved = new Map()
    const RETRY_UNRESOLVED_MS = 5 * 60_000

    async function sweep() {
      if (sweeping || profileInfo.size === 0) {
        return
      }

      // Measured: each sweep fans out one session.list (limit 300) per
      // profile — with ~23 profiles that pinned the Python backend at
      // 90-100% CPU for about a second every 45s. Only sweep when an OPEN
      // tab is actually unresolved by the cheap pointer map; otherwise
      // there is nothing for the sweep to find.
      const openSids = lastTabs
        .map(tab => sessionIdFromPaneId(tab.getAttribute('data-tree-tab')))
        .filter(Boolean)
      const now = Date.now()
      const unresolved = openSids.filter(
        sid => !iconBySession.has(sid) && now - (triedUnresolved.get(sid) || 0) > RETRY_UNRESOLVED_MS
      )

      if (unresolved.length === 0) {
        return
      }

      sweeping = true

      try {
        // An unresolved sid's owner is by definition unknown, so ask every
        // profile — but this now only happens when a tab is genuinely
        // unresolved (see the gate above), not on every tick.
        const names = [...profileInfo.keys()]
        const results = await Promise.all(
          names.map(name =>
            host
              .requestProfile(name, 'session.list', { limit: 300, include_hidden: true })
              .then(res => ({ name, sessions: Array.isArray(res?.sessions) ? res.sessions : [] }))
              .catch(() => ({ name, sessions: null }))
          )
        )

        const map = new Map()
        let failed = 0

        for (const { name, sessions } of results) {
          if (sessions === null) {
            failed += 1
            continue
          }

          const entry = profileInfo.get(name)

          if (!entry) {
            continue
          }

          for (const s of sessions) {
            if (s?.id) {
              map.set(String(s.id), entry)
            }

            if (s?.resolved_id) {
              map.set(String(s.resolved_id), entry)
            }
          }
        }

        sweepMap = map
        mergeMaps()

        for (const sid of unresolved) {
          if (!iconBySession.has(sid)) triedUnresolved.set(sid, Date.now())
          else triedUnresolved.delete(sid)
        }

        lastDiagnostics = {
          ...lastDiagnostics,
          sweepProfiles: names.length,
          sweepFailed: failed,
          sweepSessionsMapped: map.size
        }
        scheduleApplyAll()
      } finally {
        sweeping = false
      }
    }

    // Tab-strip geometry changes that involve no DOM mutation (sidebar
    // collapse, zone split drag, window resize) — a ResizeObserver per strip
    // replaces "re-measure on every mutation anywhere in the document".
    const observedStrips = new WeakSet()
    const stripResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleApplyAll()) : null

    ctx.onDispose(() => stripResize?.disconnect())

    function watchStrips(tabs) {
      if (!stripResize) return

      for (const tab of tabs) {
        const strip = tab.closest('[data-zone-tabstrip]') || tab.parentElement

        if (strip && !observedStrips.has(strip)) {
          observedStrips.add(strip)
          stripResize.observe(strip)
        }
      }
    }

    const TAB_SEL = '[data-tree-tab]'

    function nodesTouchTabs(nodes) {
      for (const n of nodes) {
        if (n.nodeType === 1 && (n.matches(TAB_SEL) || n.querySelector(TAB_SEL))) return true
      }

      return false
    }

    // Was: re-run applyAll (N getBoundingClientRect + writes) on EVERY
    // childList mutation anywhere in <body> — i.e. every streamed token's
    // markdown re-render, every transcript virtualization step. Now only
    // mutations that can actually change the tab strip schedule a pass:
    //  - data-active flipping on a tab (which tab is focused),
    //  - nodes added/removed INSIDE a tab strip,
    //  - added/removed subtrees that contain tabs (strip/zone re-mounts).
    const observer = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target.nodeType === 1 && r.target.matches(TAB_SEL)) {
            scheduleApplyAll()

            return
          }

          continue
        }

        const t = r.target

        if (t.nodeType === 1 && (t.closest('[data-zone-tabstrip]') || t.closest(TAB_SEL))) {
          scheduleApplyAll()

          return
        }

        if (nodesTouchTabs(r.addedNodes) || nodesTouchTabs(r.removedNodes)) {
          scheduleApplyAll()

          return
        }
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-active']
    })
    ctx.onDispose(() => observer.disconnect())

    // The workspace tab's content can change (user navigates it to a
    // different chat) without ANY DOM mutation the observer above would
    // catch — only host.state moves. Re-apply whenever the focused session
    // changes, feature-detected since older hosts may lack `.listen`.
    if (typeof host.state.focusedStoredSessionId?.listen === 'function') {
      ctx.onDispose(host.state.focusedStoredSessionId.listen(() => scheduleApplyAll()))
    }

    // Window resize moves everything. Scroll only matters when the scrolled
    // element actually contains a tab (e.g. an overflowing tab strip) — a
    // transcript scroll (the overwhelmingly common case) never moves a tab,
    // so it no longer triggers a re-measure on every scroll event.
    ctx.addEventListener(window, 'resize', () => scheduleApplyAll())
    ctx.addEventListener(
      document,
      'scroll',
      e => {
        const t = e.target

        if (t === document || t === document.documentElement || lastTabs.some(tab => t.contains?.(tab))) {
          scheduleApplyAll()
        }
      },
      { capture: true, passive: true }
    )

    // Both pollers skip their tick entirely while the window is hidden
    // (backgrounded/minimized) — mirrors agent-activity's existing
    // visibility-pause pattern instead of polling a tab nobody is looking
    // at. First sweep still runs shortly after the first pointer refresh
    // lands (profileInfo needs names to query); each then reschedules
    // itself on its own interval.
    let refreshTimer = null
    let sweepTimer = null

    function scheduleRefresh(ms) {
      refreshTimer = ctx.setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          void refresh()
        }

        scheduleRefresh(POLL_MS)
      }, ms)
    }

    function scheduleSweep(ms) {
      sweepTimer = ctx.setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          void sweep()
        }

        scheduleSweep(SWEEP_MS)
      }, ms)
    }

    void refresh()
    scheduleRefresh(POLL_MS)
    scheduleSweep(1500)

    ctx.onDispose(() => {
      refreshTimer?.()
      sweepTimer?.()
    })

    // Debug row (⌘K → "Debug: session tab bot icon") — surfaces exactly what
    // this plugin sees so a "icon still doesn't show" report can be diagnosed
    // from a toast instead of needing DevTools on a packaged build.
    ctx.register({
      id: 'debug',
      area: PALETTE_AREA,
      data: {
        id: 'session-tab-bot-icon-debug',
        label: 'Debug: session tab bot icon',
        keywords: ['bot', 'icon', 'tab', 'pet', 'avatar'],
        run: () => {
          const tabs = [...document.querySelectorAll('[data-tree-tab]')]
          const tileTabs = tabs
            .map(t => t.getAttribute('data-tree-tab'))
            .filter(id => id && id.startsWith(TILE_PREFIX))
          const sids = tileTabs.map(sessionIdFromPaneId)
          const matched = sids.filter(id => iconBySession.has(id))
          const matchedNames = matched.map(id => iconBySession.get(id)?.name)
          const cacheEntries = [...avatarCache.entries()].map(([name, data]) => `${name}=${data ? 'has-image' : 'no-image'}`)

          host.notify({
            kind: lastDiagnostics?.ok === false ? 'error' : 'info',
            title: 'session-tab-bot-icon status',
            message:
              lastDiagnostics?.ok === false
                ? `profiles.list failed: ${lastDiagnostics.error}`
                : `profiles=${lastDiagnostics?.profiles ?? '?'} withAvatarFlag=${lastDiagnostics?.withAvatarFlag ?? '?'} ` +
                  `sweep=${lastDiagnostics?.sweepSessionsMapped ?? 'pending'}/${lastDiagnostics?.sweepFailed ?? 0}fail ` +
                  `sessionTabs=${tileTabs.length} matched=${matched.length}`,
            detail:
              `matched bots: ${matchedNames.join(', ') || '(none)'}\n` +
              `avatar fetch cache: ${cacheEntries.join(', ') || '(empty — none fetched yet)'}\n` +
              `tabs: ${tileTabs.join(', ') || '(none)'}`
          })
        }
      }
    })
  }
}
