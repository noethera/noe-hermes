/**
 * composer-tidy — keeps the stock fused look of the composer status stack
 * ("1 Background", todos, subagents, queue) but stops its last row from
 * running into the composer seam and the collapse grip parked on it.
 *
 * Core draws the stack as the top half of one capsule with no bottom padding,
 * so the final row sits right on the seam where the grip (top: -0.5rem)
 * overlaps it. This only adds clearance under the content.
 *
 * Pure CSS on stable data-slot hooks. Disable in Settings → Plugins (or
 * delete the folder) to get the stock spacing back.
 */

const ID = 'composer-tidy'
const STYLE_ID = 'hermes-plugin-composer-tidy'

const CSS = `
/* Top: breathing room under the card's rounded top edge.
   Bottom: clear the seam + the 6px grip that sits 8px above it. */
[data-slot='composer-status-stack'] [data-slot='status-stack-content'] {
  padding-top: 6px;
  padding-bottom: 12px;
}
`

function mountStyle() {
  document.getElementById(STYLE_ID)?.remove()
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)

  return () => el.remove()
}

export default {
  id: ID,
  name: 'Composer Tidy',
  register(ctx) {
    const dispose = mountStyle()

    ctx.onDispose?.(dispose)
  }
}
