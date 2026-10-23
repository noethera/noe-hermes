/**
 * Input frame like Claude Code: a rule above and below the composer, with a blank row between the frame and the
 * status bar (status bar sits at the bottom: display.tui_statusbar = bottom). Two ambient dock widgets, auto-open on
 * TUI start; `/frame-top` and `/frame-bottom` toggle them. Source: noe-hermes/ui/tui-widgets/input-frame.mjs.
 * The TUI adds one blank row above the input when the status bar is at the bottom; the bottom frame mirrors it so
 * the input sits centered between the two rules.
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
    render: ({ cols, t }) => rule(cols, t)
  })

  const bottom = defineWidgetApp({
    id: 'frame-bottom',
    help: 'garis di bawah input + jarak ke status bar',
    mode: 'ambient',
    zone: 'dock-bottom',
    init: () => ({}),
    reduce: state => state,
    render: ({ cols, t }) =>
      h(Box, { flexDirection: 'column' }, blank('above'), h(Box, { key: 'rule' }, rule(cols, t)), blank('below'))
  })

  sdk.openWidget(top, top.init(''))
  sdk.openWidget(bottom, bottom.init(''))
}
