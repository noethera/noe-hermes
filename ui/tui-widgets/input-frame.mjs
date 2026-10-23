/**
 * Input frame like Claude Code: a rule above and below the composer, with a blank row between the frame and the
 * status bar (status bar sits at the bottom: display.tui_statusbar = bottom). Two ambient dock widgets, auto-open on
 * TUI start; `/frame-top` and `/frame-bottom` toggle them. Source: noe-hermes/ui/tui-widgets/input-frame.mjs.
 * The TUI adds one blank row above the input when the status bar is at the bottom: the top rule is drawn on that row
 * (zero-height box with an absolute child) and the input sits right under it (layout: rule / input / rule / blank / status).
 */
export default function register(sdk) {
  const { Box, Text, defineWidgetApp, h } = sdk

  // The dock keeps 2 columns free on the right (paddingRight 2).
  const rule = (cols, t) => h(Text, { color: t.color.border }, '─'.repeat(Math.max(1, cols - 2)))
  const blank = key => h(Text, { key }, ' ')

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
    help: 'garis di bawah input + jarak ke status bar',
    mode: 'ambient',
    zone: 'dock-bottom',
    init: () => ({}),
    reduce: state => state,
    render: ({ cols, t }) =>
      h(Box, { flexDirection: 'column' }, h(Box, { key: 'rule' }, rule(cols, t)), blank('below'))
  })

  sdk.openWidget(top, top.init(''))
  sdk.openWidget(bottom, bottom.init(''))
}
