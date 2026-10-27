/**
 * tab-guard — fixes two Hermes desktop tab bugs WITHOUT a core patch:
 *
 *  1. Clicking a bot in the Bots roster no longer OVERWRITES the chat in the
 *     main tab. Core opens a bot's canonical "Bot Chat" with intent `in-place`
 *     (hermes-bots/canonical-chat.ts): when that chat has no tab yet it is
 *     loaded INTO the main (workspace) pane and whatever chat was there drops
 *     out of the tab strip. Before core sees the click, this plugin opens the
 *     Bot Chat as its own tab (intent `tab`) and then replays the same click —
 *     core now finds that tab and only fronts it (roster highlight, transcript
 *     refresh and source activation stay core's).
 *
 *  2. A session tab the USER closed must not come back on its own. Every
 *     close made by a user gesture (✕, middle-click, ⌘-click, ⌘W, a "Close…"
 *     menu item) is recorded as a tombstone (localStorage, 7 days). If that
 *     tab reappears as a BACKGROUND tab (restore after restart, profile-bucket
 *     rehydrate) it is closed again through core's own ✕. A deliberate reopen
 *     (⌘K, sidebar, ⌘⇧T, a notification) always fronts the tab — an active
 *     tab is never touched and clears its tombstone.
 *
 *  Diagnostics: window.__tabGuard.log() / .tombstones() / .clear()
 *  Disable in Settings → Plugins to get the stock behavior back.
 *  Plain ESM, loaded uncompiled. Keep every `import` on ONE line (tests strip them).
 */
import { host } from '@hermes/plugin-sdk'

const ID = 'tab-guard'
const TILE_PREFIX = 'session-tile:'
const TAB_SEL = '[data-tree-tab]'
const TILES_KEY = 'hermes.desktop.sessionTiles.v2'
const BOTS_BUCKET = '__bots_workspace__'
const TOMB_KEY = 'noe.tabGuard.tombstones.v1'
const LOG_KEY = 'noe.tabGuard.log.v1'
const BOT_CHAT_TITLE = 'Bot Chat'
const LOG_MAX = 200
const RECLOSE_DELAY_MS = 400
const RECLOSE_BUDGET = 5 // per 10 s — loop guard
const PLUGIN_OPEN_GRACE_MS = 5000
const PROFILES_POLL_MS = 15000
const TAB_WAIT_MS = 8000

export const TOMB_TTL_MS = 7 * 24 * 3600 * 1000
export const CLOSE_GESTURE_WINDOW_MS = 1000
export const SESSION_ID_RE = /^\d{8}_\d{6}_[0-9a-z]{4,}$/i

// ---------- pure logic (plugin.test.mjs) ----------

/** Stored session id the MAIN pane is routed to, or null (blank draft, page). */
export function mainSessionFromHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').split(/[/?]/)[0] || ''
  let sid = raw

  try {
    sid = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }

  sid = sid.trim()

  return SESSION_ID_RE.test(sid) ? sid : null
}

/** A profiles.list row's canonical Bot Chat ids, lineage tip first. */
export function canonicalIdsOf(profileRow) {
  const c = profileRow?.canonical_session

  return [c?.resolved_id, c?.id].filter(Boolean).map(String)
}

/** Owner keys core may use for this bot (hermes-bots/routing.ts botWorkspaceOwnerKey). */
export function ownerKeyCandidates(rosterKey, name) {
  const out = []

  if (rosterKey && !rosterKey.startsWith('legacy::')) out.push(`bot:${rosterKey}`)
  if (name) out.push(`bot:${name}`)

  return [...new Set(out)]
}

export function pickOwnerKey(candidates, knownOwnerKeys) {
  return candidates.find(k => knownOwnerKeys.includes(k)) ?? candidates[0] ?? null
}

export function decideBotClick({ mainSid, canonicalIds, openTileSids }) {
  if (!mainSid) return 'pass:main-empty' // nothing in main to lose
  if (canonicalIds.length === 0) return 'pass:no-canonical' // never chatted: core creates it
  if (canonicalIds.includes(mainSid)) return 'pass:already-main'
  if (canonicalIds.some(id => openTileSids.includes(id))) return 'pass:already-tab' // core fronts it

  return 'open-tab'
}

export function pruneTombstones(tombs, now) {
  const out = {}

  for (const [sid, ts] of Object.entries(tombs || {})) {
    if (Number.isFinite(ts) && now - ts <= TOMB_TTL_MS) out[sid] = ts
  }

  return out
}

export function isUserClose(removedAt, lastCloseGestureAt) {
  const dt = removedAt - lastCloseGestureAt

  return lastCloseGestureAt > 0 && dt >= 0 && dt <= CLOSE_GESTURE_WINDOW_MS
}

export function shouldReclose({ sid, tombs, now, isActive }) {
  const ts = tombs[sid]

  return Boolean(ts) && now - ts <= TOMB_TTL_MS && !isActive
}

export function diffTabs(prev, next) {
  return { added: next.filter(x => !prev.includes(x)), removed: prev.filter(x => !next.includes(x)) }
}

export function isCloseLabel(label) {
  return /^(close|tutup)\b/i.test(String(label ?? '').trim())
}

// ---------- DOM helpers (browser only; never run at import time) ----------

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode — diagnostics are best-effort */
  }
}

const tabSid = tab => (tab.getAttribute('data-tree-tab') || '').slice(TILE_PREFIX.length)
const tabFor = sid => document.querySelector(`[data-tree-tab="${CSS.escape(TILE_PREFIX + sid)}"]`)
const isActiveTab = tab => tab?.getAttribute('data-active') === 'true'

/** Close through core's own ✕ (same path as a user click → closeSessionTile,
 *  so the ⌘⇧T stack and the persisted bucket stay coherent). */
function closeTab(tab) {
  const btn = [...tab.querySelectorAll('button')].find(b => isCloseLabel(b.getAttribute('aria-label')))

  if (btn) {
    btn.click()

    return 'button'
  }

  // Fallback: ⌘-press on the tab is core's close gesture (pane-tab.tsx).
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, metaKey: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  tab.dispatchEvent(new PointerEvent('pointerdown', init))
  tab.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))

  return 'meta-pointer'
}

function knownBotOwnerKeys() {
  const all = readJson(TILES_KEY, {})

  return (all?.[BOTS_BUCKET] || []).map(t => t?.workspaceOwnerKey).filter(Boolean)
}

export default {
  id: ID,
  name: 'Tab Guard',
  register(ctx) {
    const now = () => Date.now()
    let tombs = pruneTombstones(readJson(TOMB_KEY, {}), now())
    let log = readJson(LOG_KEY, [])
    if (!Array.isArray(log)) log = []
    let logDirty = false
    let lastCloseGestureAt = 0
    let known = []
    let recloseTimes = []
    const pluginOpened = new Map() // sid -> ts of an open THIS plugin made
    let profilesByName = new Map()

    const saveTombs = () => writeJson(TOMB_KEY, tombs)
    const note = (kind, data = {}) => {
      log.push({ t: new Date().toISOString(), kind, ...data })
      if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
      logDirty = true
    }
    const flushLog = () => {
      if (logDirty) {
        writeJson(LOG_KEY, log)
        logDirty = false
      }
    }

    ctx.setInterval(flushLog, 2000)
    ctx.addEventListener(window, 'pagehide', flushLog)
    ctx.onDispose(flushLog)

    // ---- 2a. remember the last USER close gesture ----
    const onGesture = event => {
      if (!event.isTrusted) return

      if (event.type === 'keydown') {
        if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'w') lastCloseGestureAt = now()

        return
      }

      const t = event.target instanceof Element ? event.target : null
      if (!t) return

      const item = t.closest('[role="menuitem"]')

      if (item) {
        if (isCloseLabel(item.textContent)) lastCloseGestureAt = now()

        return
      }

      if (!t.closest(TAB_SEL)) return

      const btn = t.closest('button')

      if (event.button === 1 || (event.button === 0 && event.metaKey) || (btn && isCloseLabel(btn.getAttribute('aria-label')))) {
        lastCloseGestureAt = now()
      }
    }

    ctx.addEventListener(document, 'pointerdown', onGesture, { capture: true })
    ctx.addEventListener(document, 'click', onGesture, { capture: true })
    ctx.addEventListener(document, 'keydown', onGesture, { capture: true })

    // ---- 2b. re-close a resurrected background tab ----
    const maybeReclose = sid => {
      const tab = tabFor(sid)
      if (!tab) return

      const t = now()
      if (t - (pluginOpened.get(sid) || 0) < PLUGIN_OPEN_GRACE_MS) return
      if (!shouldReclose({ sid, tombs, now: t, isActive: isActiveTab(tab) })) return

      recloseTimes = recloseTimes.filter(x => t - x < 10_000)

      if (recloseTimes.length >= RECLOSE_BUDGET) {
        note('reclose-skipped', { sid, reason: 'budget' })

        return
      }

      recloseTimes.push(t)
      note('reclose', { sid, how: closeTab(tab) })
    }

    const scan = () => {
      const t = now()
      const tabs = [...document.querySelectorAll(`[data-tree-tab^="${TILE_PREFIX}"]`)]
      const sids = tabs.map(tabSid)
      const { added, removed } = diffTabs(known, sids)
      let changed = false

      known = sids

      for (const sid of removed) {
        if (isUserClose(t, lastCloseGestureAt)) {
          tombs[sid] = t
          changed = true
          note('tomb', { sid })
        } else {
          note('tab-', { sid, hash: location.hash.slice(0, 40) })
        }
      }

      for (const sid of added) {
        note('tab+', { sid, active: isActiveTab(tabFor(sid)), tomb: Boolean(tombs[sid]), hash: location.hash.slice(0, 40) })
        if (tombs[sid]) ctx.setTimeout(() => maybeReclose(sid), RECLOSE_DELAY_MS)
      }

      // The user is looking at it → it was reopened on purpose.
      for (const tab of tabs) {
        const sid = tabSid(tab)

        if (tombs[sid] && isActiveTab(tab)) {
          delete tombs[sid]
          changed = true
          note('untomb', { sid })
        }
      }

      if (changed) saveTombs()
    }

    let scanPending = false
    const scheduleScan = () => {
      if (scanPending) return
      scanPending = true
      requestAnimationFrame(() => {
        scanPending = false
        scan()
      })
    }
    const touchesTabs = nodes => {
      for (const n of nodes) {
        if (n.nodeType === 1 && (n.matches(TAB_SEL) || n.querySelector(TAB_SEL))) return true
      }

      return false
    }

    // Filtered: only tab-strip changes schedule a scan (never streamed tokens).
    const observer = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' ? r.target.matches?.(TAB_SEL) : touchesTabs(r.addedNodes) || touchesTabs(r.removedNodes)) {
          scheduleScan()

          return
        }
      }
    })

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active'] })
    ctx.onDispose(() => observer.disconnect())
    scan()

    // ---- 1. bot click: open the Bot Chat as a tab instead of overwriting main ----
    // The click handler must decide synchronously, so profiles are pre-fetched.
    const refreshProfiles = async () => {
      try {
        const r = await host.request('profiles.list', {})
        const rows = Array.isArray(r) ? r : r?.profiles || []
        profilesByName = new Map(rows.map(p => [String(p?.name || ''), p]))
      } catch (error) {
        note('profiles-error', { error: String(error?.message || error) })
      }
    }

    void refreshProfiles()
    ctx.setInterval(() => void refreshProfiles(), PROFILES_POLL_MS)

    const waitForTab = (sid, ms) =>
      new Promise(resolve => {
        const start = now()
        const tick = () => (tabFor(sid) || now() - start >= ms ? resolve(Boolean(tabFor(sid))) : ctx.setTimeout(tick, 50))
        tick()
      })

    const onRosterClick = event => {
      // Our own replay (row.click()) is untrusted → falls through to core.
      if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const t = event.target instanceof Element ? event.target : null
      const row = t?.closest('[data-roster-key]')
      if (!row) return

      // Controls inside the row (⋯ menu, inputs) keep their own click.
      const control = t.closest('button, input, textarea, select, a[href], [role="menuitem"]')
      if (control && control !== row && row.contains(control)) return

      const rosterKey = row.getAttribute('data-roster-key') || ''
      const sep = rosterKey.lastIndexOf('::')
      const connectionId = sep >= 0 ? rosterKey.slice(0, sep) : ''
      const name = sep >= 0 ? rosterKey.slice(sep + 2) : rosterKey
      const bot = profilesByName.get(name)

      // Only this device's bots; remote-connection bots keep core's path.
      if (!bot || (connectionId && connectionId !== 'local' && connectionId !== 'legacy')) {
        note('bot-click', { name, decision: 'pass:not-local-or-unknown' })

        return
      }

      const canonicalIds = canonicalIdsOf(bot)
      const decision = decideBotClick({
        mainSid: mainSessionFromHash(location.hash),
        canonicalIds,
        openTileSids: [...document.querySelectorAll(`[data-tree-tab^="${TILE_PREFIX}"]`)].map(tabSid)
      })

      note('bot-click', { name, decision })
      if (decision !== 'open-tab') return

      event.preventDefault()
      event.stopImmediatePropagation()

      const sid = canonicalIds[0]
      const ownerKey = pickOwnerKey(ownerKeyCandidates(rosterKey, name), knownBotOwnerKeys())

      pluginOpened.set(sid, now())

      const opening = host
        .openSession(sid, {
          profile: name,
          intent: 'tab',
          workspaceMode: 'bots',
          workspaceOwnerKey: ownerKey,
          tabTitle: BOT_CHAT_TITLE,
          awaitHydration: false
        })
        .catch(error => note('bot-open-error', { name, sid, error: String(error?.message || error) }))

      // Replay as soon as the tab exists (or the open settles): core's own
      // openRosterBot then finds this tab and fronts it. If the open failed,
      // the replay simply runs core's stock path — no worse than before.
      void Promise.race([waitForTab(sid, TAB_WAIT_MS), opening])
        .then(() => waitForTab(sid, 0))
        .then(hasTab => {
          note('bot-replay', { name, sid, ownerKey, hasTab })
          if (row.isConnected) row.click()
        })
    }

    // window capture runs before document capture (sidebar-click-new-tab) and React.
    ctx.addEventListener(window, 'click', onRosterClick, { capture: true })

    window.__tabGuard = {
      log: () => log.slice(),
      tombstones: () => ({ ...tombs }),
      clear: () => {
        tombs = {}
        saveTombs()
        log = []
        logDirty = true
        flushLog()
      }
    }
    ctx.onDispose(() => {
      delete window.__tabGuard
    })
  }
}
