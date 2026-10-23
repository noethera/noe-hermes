/**
 * sidebar-click-new-tab — a plain click on a sidebar session no longer
 * REPLACES the chat that is open in the main tab; it opens the session in a
 * new tab instead (or jumps to its tab when it is already open).
 *
 * Why: core's sidebar click uses the `in-place` intent, which routes the
 * clicked session into the main workspace pane. Whatever chat was there
 * disappears from the tab strip — even when the user was looking at a
 * different tab at the time.
 *
 * How (no core patch, no React internals):
 *  1. A `sessionRow.trailing` decoration renders an invisible marker carrying
 *     the row's stored session id. That tells us a click landed on a session
 *     row, and which one.
 *  2. A capture-phase click listener on `document` runs BEFORE React's root
 *     listener. For a plain left click on a row body while main already holds
 *     a chat, it swallows the click and re-dispatches it as a ⌘/⌃-click on the
 *     same element. Core's own ⌘-click path (`openSession(…, 'tab')`) then does
 *     the work: front the tab if the session is on screen, else stack a new
 *     tab in the focused zone. Owner/profile routing is core's, unchanged.
 *  3. When main is blank (fresh draft), the click is left alone, so it loads
 *     into main as before; no pointless extra tab.
 *
 * Modifier gestures (⌘ new tab, ⇧⌘ window, ⇧ pin, ⌥⇧ archive), the row's ⋯
 * menu, rename input and drag handle are untouched.
 *
 * Disable in Settings → Plugins (or delete the folder) to get the stock
 * behavior back.
 */

import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'sidebar-click-new-tab'
const MARKER_ATTR = 'data-sctab-sid'
const ROW_BUTTON_SLOT = 'row-button'
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// Inside a row these keep their own click meaning: the ⋯ actions button,
// the inline rename input, links, menus. Never rewrite those.
const INTERACTIVE = 'button, input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"], [role="menuitem"], [role="checkbox"], [role="switch"]'

function Marker({ sessionId }) {
  return jsx('span', { [MARKER_ATTR]: sessionId, hidden: true, 'aria-hidden': 'true' })
}

/** The smallest ancestor of `target` that holds a row marker = the row body. */
function rowFor(target) {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    const marker = el.querySelector(`[${MARKER_ATTR}]`)

    if (marker) {
      return { row: el, sessionId: marker.getAttribute(MARKER_ATTR) || '' }
    }
  }

  return null
}

/** Main holds a chat worth keeping: a bound runtime, or a routed stored
 *  session (hash `#/<id>` naming a session the sidebar lists). */
function mainOccupied() {
  if (host.state.activeSessionId.get()) {
    return true
  }

  const routed = decodeURIComponent((location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || '').trim())

  return Boolean(routed) && Boolean(document.querySelector(`[${MARKER_ATTR}="${CSS.escape(routed)}"]`))
}

function onClickCapture(event) {
  if (
    !event.isTrusted ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.defaultPrevented
  ) {
    return
  }

  const hit = rowFor(event.target)

  if (!hit || !hit.sessionId) {
    return
  }

  // The row's title is itself a `<button data-slot="row-button">` (the row's
  // primary click surface) — that one IS the row body. Any other control
  // inside the row keeps its own click.
  const interactive = event.target instanceof Element ? event.target.closest(INTERACTIVE) : null

  if (interactive && hit.row.contains(interactive) && interactive.getAttribute('data-slot') !== ROW_BUTTON_SLOT) {
    return
  }

  if (!mainOccupied()) {
    return
  }

  // Swallow the plain click before React sees it, then replay it as the
  // platform's "open in new tab" click on the same element.
  event.preventDefault()
  event.stopImmediatePropagation()

  event.target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      composed: true,
      ctrlKey: !IS_MAC,
      detail: event.detail,
      metaKey: IS_MAC,
      screenX: event.screenX,
      screenY: event.screenY,
      view: window
    })
  )
}

export default {
  id: ID,
  name: 'Sidebar Click → New Tab',
  register(ctx) {
    ctx.register({
      id: 'row-marker',
      area: 'sessionRow.trailing',
      data: { render: ({ sessionId }) => jsx(Marker, { sessionId }) }
    })

    ctx.addEventListener(document, 'click', onClickCapture, { capture: true })
  }
}
