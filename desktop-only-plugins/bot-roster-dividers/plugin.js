/**
 * bot-roster-dividers — a thin hairline between rows in the Bots roster, so
 * a dense list of bots reads as distinct rows instead of one solid block.
 *
 * Drawn as an inset box-shadow on the row itself (not a separate element):
 * a genuinely separate `::after` would need `overflow: visible` on the row
 * to escape its own clip, but that row also clips its avatar images — turning
 * overflow off let an oversized avatar image render full-size and bleed over
 * the rows below it (regression, fixed by reverting this). box-shadow avoids
 * that because it's a paint effect that doesn't need overflow changed at all.
 *
 * The row has `rounded-md` on all four corners (for its hover/active
 * background), and box-shadow always follows an element's OWN border-radius
 * — so a plain inset shadow at the bottom would curve at both bottom
 * corners, reading as a rounded pill rather than a flat line. Squaring off
 * ONLY the bottom two corners keeps the rounded feel on hover/selected (top
 * edge still curves) while giving the divider a straight bottom edge.
 *
 * Pure CSS on the roster's stable `data-roster-key` hook — no DOM mutation,
 * independent of bot-heartbeat / agent-activity. Disable in Settings →
 * Plugins (or delete the folder) to get the stock look back.
 */

const ID = 'bot-roster-dividers'
const STYLE_ID = 'hermes-plugin-bot-roster-dividers'

const CSS = `
[data-roster-key] {
  border-bottom-left-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
  box-shadow: inset 0 -1px 0 var(--ui-stroke-quaternary, var(--border));
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
  name: 'Bot Roster Dividers',
  register(ctx) {
    const dispose = mountStyle()

    ctx.onDispose?.(dispose)
  }
}
