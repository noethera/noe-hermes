/**
 * kanban-report-corner — makes kanban run-report toasts (task
 * completed/blocked/crashed/gave-up/timed-out) land in a quiet top-right
 * corner card instead of the loud top-center stack, and auto-dismisses them
 * after 60s so a notice that normally never times out (blocked/crashed/
 * gave_up/timed_out all ship with durationMs: 0) doesn't sit on screen
 * forever waiting for a manual dismiss.
 *
 * Pure CSS + DOM observation on a stable first-party selector
 * (`data-slot="card-stack-front"` from components/ui/card-stack.tsx) — no
 * core patch, no rebuild, hot-reloads like any other desktop plugin. Portable:
 * drop this folder into any `<hermes home>/desktop-plugins/` and it works
 * the same way bot-heartbeat does (CSS/DOM only, no new backend).
 *
 * How it recognises a kanban report: the kanban plugin's own terminal-event
 * notifier (apps/desktop/src/plugins/kanban/completion-notify.ts) fires one
 * of 6 fixed i18n titles (apps/desktop/src/plugins/kanban/i18n.ts, key
 * `notify.*Title`). This plugin keeps a static copy of those strings across
 * the 4 bundled locales (en/ja/zh/zh-hant) and matches a toast's text against
 * them. If upstream ever renames a title this simply stops matching — the
 * toast still shows normally in its usual spot, just not repositioned
 * (fails open, never breaks the notification itself).
 */

const ID = 'kanban-report-corner'
const AUTO_DISMISS_MS = 60_000
const STYLE_ID = 'khr-style'
const CARD_SELECTOR = '[data-slot="card-stack-front"][data-stack-key]'

// Copied from apps/desktop/src/plugins/kanban/i18n.ts `notify.*Title` keys —
// see the module doc above for why a rename there just means a missed match,
// never a break.
const KANBAN_TITLES = [
  // en
  'Task completed',
  'Task blocked — needs your input',
  'Task routed to triage — needs a decision',
  'Task stopped',
  'Task hit a problem — Hermes will retry it automatically',
  'Task took too long — Hermes will retry it automatically',
  // ja
  'タスク完了',
  'タスクがブロック中 — 入力が必要です',
  'タスクをトリアージへ移動 — 判断が必要です',
  'タスクが停止しました',
  'タスクで問題が発生 — Hermesが自動で再試行します',
  'タスクに時間がかかりすぎました — Hermesが自動で再試行します',
  // zh (simplified)
  '任务已完成',
  '任务受阻 — 需要你的输入',
  '任务已转入分类 — 需要人工决定',
  '任务已停止',
  '任务遇到问题 — Hermes 将自动重试',
  '任务耗时过长 — Hermes 将自动重试',
  // zh-hant
  '任務已完成',
  '任務受阻 — 需要你的輸入',
  '任務已轉入分類 — 需要人工決定',
  '任務已停止',
  '任務遇到問題 — Hermes 將自動重試',
  '任務耗時過長 — Hermes 將自動重試'
]

const CSS = `
[data-khr-corner="1"] {
  position: fixed !important;
  left: auto !important;
  bottom: auto !important;
  right: 1rem !important;
  width: min(24rem, calc(100% - 2rem)) !important;
  top: calc(var(--titlebar-height, 34px) + 0.75rem + (var(--khr-index, 0) * 4.5rem)) !important;
  z-index: var(--z-over-modal, 2147483000) !important;
  transition: top 160ms ease !important;
}
`

function isKanbanReportCard(card) {
  const text = card.textContent || ''

  return KANBAN_TITLES.some(title => text.includes(title))
}

export default {
  id: ID,
  name: 'Kanban Report Corner',
  description: 'Kanban run-report toasts move to the top-right corner and auto-dismiss after 60s.',
  register(ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')

      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.onDispose(() => style.remove())
    }

    const seen = new WeakSet()
    const floating = new Set()

    function reindex() {
      let i = 0

      for (const card of floating) {
        card.style.setProperty('--khr-index', String(i))
        i += 1
      }
    }

    function release(card) {
      floating.delete(card)
      reindex()
    }

    function handleCard(card) {
      if (seen.has(card) || !isKanbanReportCard(card)) {
        return
      }

      seen.add(card)
      floating.add(card)
      card.setAttribute('data-khr-corner', '1')
      reindex()

      // Auto-dismiss is DISABLED for now (debugging the corner placement
      // first) — see AUTO_DISMISS_MS / the commented block below to bring it
      // back once positioning is confirmed working everywhere.
      //
      // const dismissBtn = card.querySelector('button[aria-label]')
      // const cancelTimer = ctx.setTimeout(() => dismissBtn?.click(), AUTO_DISMISS_MS)
    }

    // A tracked card is released the moment it (or an ancestor) is removed
    // from the DOM — detected from the SAME top-level observer's own
    // mutation records below, instead of spinning up a dedicated
    // MutationObserver per card (that was N+1 concurrent full-body subtree
    // observers running at once for N live toasts).
    function releaseIfRemoved(node) {
      if (!(node instanceof HTMLElement) || floating.size === 0) {
        return
      }

      for (const card of floating) {
        if (node === card || node.contains(card)) {
          release(card)
        }
      }
    }

    function scan(root) {
      if (root.matches?.(CARD_SELECTOR)) {
        handleCard(root)
      }

      root.querySelectorAll?.(CARD_SELECTOR).forEach(handleCard)
    }

    scan(document.body)

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (node instanceof HTMLElement) {
            scan(node)
          }
        })
        mutation.removedNodes.forEach(releaseIfRemoved)
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    ctx.onDispose(() => observer.disconnect())
  }
}
