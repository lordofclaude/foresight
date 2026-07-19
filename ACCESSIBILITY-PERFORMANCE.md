# Accessibility and performance QA

The primary judge path is `?demo=1`: enter as a guest, choose a native prediction button, commit, run or instant-replay, verify/forge, then inspect the real anchor. Replay is always user-triggered. The initial dashboard is a useful static snapshot and never starts a background replay loop.

## Budgets

- Replay rendering: at most 10 updates/second; 2 updates/second when reduced motion is requested.
- Market ticker, text summary, and mini charts: at most 1 update/second.
- Live tape rebuilds: at most 2.5/second, coalesced.
- Gate animation: one `requestAnimationFrame` loop only while the gate is visible; none under reduced motion; cancelled on close.
- Hydrated dashboard DOM: at most 1,000 elements in the guest demo.
- Toast stack: at most four items. Fast-changing clock, prices, and relay age are not live regions.
- Optional third parties: fonts do not block first render; flags are lazy with a local fallback; Solana web3 is deferred and wallet-only. Polymarket comparison and RSS failures render explicit unavailable/empty states without blocking TxLINE replay. The X widget loads only after the user opens its tab.
- Original football imagery: ten local WebP files total about 1.62 MB. Only the 288 KB gate/hero pair is referenced by the dashboard; the former carousel was removed to reduce visual and network weight. Reduced-data mode removes both atmospheric backgrounds.

## Keyboard and screen-reader contract

Radar tiles, market selection, event/news tabs, leaderboard profiles, filters, disclosures, picks, replay controls, and agent-builder tabs/visibility are keyboard controls with visible focus. The modal traps focus, closes with Escape, and restores focus. Canvas charts are decorative enhancements; the selected fixture, score, minute, 1X2 probabilities, divergence, and risk are repeated in text. Terminal mode is a captioned semantic table.

## Reflow and verification

At 390 CSS pixels and at 200% zoom, picks and control rows stack while only the market-table wrapper scrolls horizontally. Run:

```powershell
node test-accessibility-performance.js
node test-ui-logic.js
node test-inline.js
node test.js
```

Browser QA should also confirm no page-level horizontal overflow, explicit replay start, modal focus return, and a hydrated element count within budget.
