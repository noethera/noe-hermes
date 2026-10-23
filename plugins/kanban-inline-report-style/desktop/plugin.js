/**
 * kanban-inline-report-style — kanban run-report text that lands INSIDE a
 * chat transcript (not the toast stack) arrives on the 'user' role turn (the
 * recipient session's own turn runs on it), so it renders as a normal
 * right-aligned human bubble even though it's really an agent reporting in,
 * e.g. "✔ [default] @qa-dev Kanban t_64ee22ae done — …". Core already has a
 * near-identical case (AGENT_MESSAGE_RE in user-message.tsx, "Message from
 * X: …") that renders a compact LEFT-aligned attributed notice instead of a
 * user bubble — this format just isn't recognized by that regex.
 *
 * SAFETY: only ever (a) reads `.textContent` / `getBoundingClientRect()` on
 * existing message-root nodes, (b) toggles ONE attribute
 * (`data-kirs-report`) on that SAME root — never inserted as a new attribute
 * React itself writes, so it's never fought/reset on re-render — and
 * (c) draws its avatar chip in a SEPARATE overlay layer appended to
 * `document.body`, exactly like session-tab-bot-icon. It never inserts,
 * removes, or reorders a single DOM node inside the live transcript, so it
 * cannot desync React's reconciliation of that list (see
 * session-tab-bot-icon's header comment for the class of bug this avoids).
 */

import { host } from '@hermes/plugin-sdk'

const ID = 'kanban-inline-report-style'
const STYLE_ID = 'kirs-style'
const OVERLAY_ID = 'kirs-overlay'
const ICON_CLASS = 'kirs-icon'
const ICON_SIZE = 18
const ROOT_SELECTOR = '[data-slot="aui_user-message-root"][data-role="user"]'
const POLL_MS = 10_000

// Glyphs from tui_gateway/session_notifications.py's _KANBAN_EVENT_FORMATTERS
// (✔ completed, ⏸ blocked, ✖ gave_up/crashed, ⏱ timed_out, 🔄 status). The
// "Kanban <task_id>" spine and the glyph are constant across every locale
// (locales/*.yaml only translate the text AFTER task_id); the optional
// "[board] " and "@assignee " prefixes are English-structured in every
// locale too, so one regex covers them all.
const REPORT_RE = /^[✔⏸✖⏱🔄]\s*(?:\[[^\]]{1,64}\]\s*)?(?:@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\s*)?Kanban\s+\S/u

const STYLE_CSS = `
#${OVERLAY_ID} {
  position: fixed;
  inset: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  z-index: 30;
}
.${ICON_CLASS} {
  position: fixed;
  width: ${ICON_SIZE}px;
  height: ${ICON_SIZE}px;
  border-radius: 9999px;
  object-fit: cover;
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--dt-user-bubble, #fff);
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
/* Pure attribute-selector CSS — no className mutation, so nothing here ever
   fights React's own render of this node. align-self flips the bubble from
   the right side (its stock self-end) to the left, matching where an actual
   agent-to-agent note (AgentMessageNote) already renders. */
${ROOT_SELECTOR}[data-kirs-report="1"] {
  align-self: flex-start !important;
}
${ROOT_SELECTOR}[data-kirs-report="1"] .composer-human-message {
  margin-left: ${ICON_SIZE + 8}px;
}
`

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
  name: 'Kanban Inline Report Style',
  description:
    'Kanban run-reports that land inside a chat transcript (not the toast stack) render left-aligned with the reporting bot\u2019s icon instead of as a right-aligned human bubble.',
  register(ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')

      style.id = STYLE_ID
      style.textContent = STYLE_CSS
      document.head.appendChild(style)
      ctx.onDispose(() => style.remove())
    }

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

    // handle (lowercased) -> { name, label, hasAvatar }. Refreshed on an
    // interval, same pair of RPCs session-tab-bot-icon uses.
    let profileInfo = new Map()
    const avatarCache = new Map()
    const avatarInflight = new Map()

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

    async function refreshProfiles() {
      try {
        const result = await host.request('profiles.list', {})
        const rows = Array.isArray(result?.profiles) ? result.profiles : []
        const info = new Map()

        for (const row of rows) {
          const name = String(row?.name || '')
          const label = String(row?.display_name || name || '?')
          const hasAvatar = Boolean(row?.has_avatar)

          info.set(name.toLowerCase(), { name, label, hasAvatar })
        }

        profileInfo = info
        scheduleApplyAll()
      } catch {
        // Transient gateway hiccup — the next poll tick retries.
      }
    }

    // 'hermes' is the conventional alias for the primary profile (mirrors
    // resolveAgentAvatar in user-message.tsx).
    function entryForHandle(handle) {
      const key = handle.toLowerCase()

      return profileInfo.get(key) || (key === 'hermes' ? profileInfo.get('default') : undefined)
    }

    // node -> { key, match } — user-message text is static once rendered, so
    // classify each message root ONCE instead of re-reading its full
    // textContent + running the regex on every frame. Keyed on the node with
    // the message id as a guard (an edited/re-keyed message reclassifies).
    const classified = new WeakMap()
    // message id -> overlay chip (O(1) instead of scanning overlay.children).
    const iconByMsg = new Map()
    // How many report bubbles were on screen last pass. When 0 (the normal
    // case) scrolls and unrelated mutations can't move anything we draw, so
    // they're ignored entirely.
    let liveReports = 0

    function classify(node) {
      const key = node.getAttribute('data-message-id') || ''
      const hit = classified.get(node)

      if (hit && hit.key === key) {
        return hit
      }

      const text = (node.textContent || '').trim()
      const match = REPORT_RE.exec(text)
      const next = { key, match: match ? { handle: match[1] || null } : null }

      // Don't pin a verdict on a root that hasn't rendered its text yet.
      if (text) classified.set(node, next)

      return next
    }

    function setAttr(el, name, value) {
      if (value === null) {
        if (el.hasAttribute(name)) el.removeAttribute(name)
      } else if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value)
      }
    }

    function dropIcon(key) {
      iconByMsg.get(key)?.remove()
      iconByMsg.delete(key)
    }

    // WRITE phase for one report bubble; geometry was read beforehand.
    function writeIcon(key, entry, rect, overlay) {
      const image = entry.hasAvatar ? avatarCache.get(entry.name) : null
      const wantTag = image ? 'IMG' : 'DIV'
      let el = iconByMsg.get(key) || null

      if (el && (el.tagName !== wantTag || !el.isConnected)) {
        el.remove()
        el = null
      }

      if (!el) {
        el = document.createElement(image ? 'img' : 'div')
        el.className = ICON_CLASS
        el.setAttribute('data-kirs-msg', key)
        overlay.appendChild(el)
        iconByMsg.set(key, el)
      }

      const left = `${Math.round(rect.left - ICON_SIZE - 6)}px`
      const top = `${Math.round(rect.top)}px`

      if (el.style.left !== left) el.style.left = left
      if (el.style.top !== top) el.style.top = top

      if (image) {
        if (el.alt !== '') el.alt = ''
        setAttr(el, 'data-generated', null)

        if (el.src !== image) {
          el.src = image
        }
      } else {
        setAttr(el, 'data-generated', '1')
        if (el.title !== entry.label) el.title = entry.label

        const bg = colorFor(entry.name)

        if (el.style.background !== bg) el.style.background = bg

        const letter = initialOf(entry.label)

        if (el.textContent !== letter) {
          el.textContent = letter
        }

        if (entry.hasAvatar && !avatarCache.has(entry.name)) {
          fetchAvatar(entry.name).then(() => scheduleApplyAll())
        }
      }
    }

    function applyAll() {
      const overlay = ensureOverlay()
      const roots = document.querySelectorAll(ROOT_SELECTOR)
      const marks = []
      const draws = []

      // READ phase — classification is cached, and only actual report
      // bubbles (usually zero) get a getBoundingClientRect.
      for (const node of roots) {
        const { key, match } = classify(node)

        marks.push([node, match ? '1' : null])

        if (!match || !key || !match.handle) continue

        const entry = entryForHandle(match.handle)

        if (!entry) continue

        const bubble = node.querySelector('.composer-human-message') || node
        const rect = bubble.getBoundingClientRect()

        if (rect.width === 0 && rect.height === 0) continue

        draws.push([key, entry, rect])
      }

      // WRITE phase.
      for (const [node, value] of marks) setAttr(node, 'data-kirs-report', value)

      const seenKeys = new Set()

      for (const [key, entry, rect] of draws) {
        seenKeys.add(key)
        writeIcon(key, entry, rect, overlay)
      }

      for (const key of [...iconByMsg.keys()]) {
        if (!seenKeys.has(key)) dropIcon(key)
      }

      liveReports = draws.length
    }

    // Same rAF coalescing rationale as session-tab-bot-icon: batch bursts
    // (streaming text, several mutations in one tick, scroll) into one
    // recompute per frame instead of thrashing on every mutation record.
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

    function nodesTouchRoots(nodes) {
      for (const n of nodes) {
        if (n.nodeType === 1 && (n.matches(ROOT_SELECTOR) || n.querySelector(ROOT_SELECTOR))) return true
      }

      return false
    }

    // Was: every mutation anywhere in <body> — including characterData, i.e.
    // every streamed character of every assistant reply — scheduled a full
    // pass that re-read the textContent of every user message on screen.
    // Now a pass is scheduled only when user-message roots come or go, or
    // (when report bubbles are actually on screen) when layout may have
    // moved them. Our own overlay's mutations are ignored.
    const observer = new MutationObserver(records => {
      const overlay = document.getElementById(OVERLAY_ID)

      for (const r of records) {
        if (overlay && overlay.contains(r.target)) continue

        if (
          nodesTouchRoots(r.addedNodes) ||
          nodesTouchRoots(r.removedNodes) ||
          (r.target.nodeType === 1 && r.target.closest(ROOT_SELECTOR))
        ) {
          scheduleApplyAll()

          return
        }
      }

      if (liveReports > 0) scheduleApplyAll()
    })

    observer.observe(document.body, { childList: true, subtree: true })
    ctx.onDispose(() => observer.disconnect())

    // The transcript scrolls independently of the window — reposition the
    // overlay chips when it does, but only if any are actually showing.
    ctx.addEventListener(window, 'resize', () => scheduleApplyAll())
    ctx.addEventListener(
      document,
      'scroll',
      () => {
        if (liveReports > 0) scheduleApplyAll()
      },
      { capture: true, passive: true }
    )

    void refreshProfiles()

    // Skip the tick entirely while the window is hidden — mirrors
    // agent-activity's existing visibility-pause pattern.
    let refreshTimer = null

    function scheduleRefresh(ms) {
      refreshTimer = ctx.setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          void refreshProfiles()
        }

        scheduleRefresh(POLL_MS)
      }, ms)
    }

    scheduleRefresh(POLL_MS)
    ctx.onDispose(() => refreshTimer?.())
    scheduleApplyAll()
  }
}
