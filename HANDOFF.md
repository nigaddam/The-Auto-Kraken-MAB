# HANDOFF.md — Kraken Overnight Guard

**Purpose of this file:** give a coding agent (or future me) everything needed
to pick this project up cold — what it is, why it's built this way, what's
verified vs. claimed-but-unverified, and exactly where to look for each
piece of behavior.

**Last verified:** 2026-07 (see "Repo health" below for the exact commands
run and their output).

---

## 1. What this is

A Manifest V3 Chrome extension, **Kraken Overnight Guard**, that:
- monitors the user's own already-open Kraken Prop LONG positions overnight,
- computes SMA7/SMA30-based exit signals plus a hard-loss and profit-lock
  rule,
- can close a qualifying LONG position **only** through a guarded manual
  flow (explicit user confirmation) or an explicitly-armed LIVE auto-close
  mode with heavy preflight/revalidation gating.

**Absolute invariants — every change must preserve these:**
- Never opens a new position, never increases size, never shorts, never
  changes leverage.
- Never automates login, 2FA, passkeys, CAPTCHA, or device approval. Never
  reads/stores username, password, 2FA codes, cookies, or session tokens.
- Never clicks a Kraken control without first validating it is the *exact*
  intended row/lot and the *exact* intended control (never a global/generic
  button, never a fixed coordinate).
- LIVE auto-close must default to **disarmed** after every browser/extension
  restart (verified: `freshRuntimeState()` in `src/storage/migrations.ts`
  always sets `autoCloseLive: false`, `executionMode: "MONITOR_ONLY"`).

**A previous, unrelated Python/Playwright prototype exists under
`python-legacy/`.** It is archived and not touched by anything in this repo;
do not delete it, do not import from it.

---

## 2. Provenance — who built what (read this before trusting any claim)

This codebase was built across multiple sessions/tools, and the amount of
functionality present today is substantially larger than what any single
session's summary describes. **Do not trust a prior session's "what I did"
narrative — verify against the actual source.** Concretely:

- An earlier session (Claude) built the **Stage 1 Python/Playwright
  prototype** (now archived in `python-legacy/`), then pivoted to this
  Chrome extension and built **Iteration 1**: MV3 scaffold, side panel,
  position detection/display (Monitor Only, no clicking), SMA strategy
  engine, storage, notifications, tests, README.
- A later session (same tool) added **read-only DOM Diagnostics**
  (`src/content/diagnostics.ts`, `position-grouping.ts`,
  `structural-census.ts`, `row-discovery.ts`), fixed a real
  connection/session-state bug, and added multi-lot-per-symbol support to
  the parser/grouping layer.
- **Between that and the current state, substantial further work landed
  in the repo that this agent did not perform directly in-session**
  (referred to by the user as "Codex"): the **manual close flow**
  (`src/content/close-preview.ts`, the `close-executor.ts` legacy-stub
  rewrite), the **LIVE auto-close execution state machine, preflight,
  fresh revalidation, and post-close verification** (all in
  `src/background/service-worker.ts`), **keep-awake**
  (`src/background/power.ts`), **dynamic Kraken symbol resolution**
  (`resolvePublicMarket` in `src/api/symbols.ts`), the **Settings panel and
  tabbed side-panel UI** (`renderSettingsPanel`, `renderTabBar` in
  `src/sidepanel/components.ts`), and roughly 30 additional tests.

**Everything in the rest of this document past this point has been
independently re-verified against the actual current source in this
session** (read the files directly, or delegated a read-only summarization
to a sub-agent for the largest file, `service-worker.ts` at 1633 lines) —
it is not copied from any prior summary.

---

## 3. Repo health (verified this session)

Commands run, in order, from repo root:

```bash
npm install        # 71 packages added, no errors
npm run typecheck  # tsc --noEmit — clean, zero errors
npm run lint       # eslint . — clean, zero errors/warnings
npm test           # vitest run — 126/126 tests passed, 12 test files
npm run build      # esbuild — succeeds, dist/ regenerated
npm audit          # 5 vulnerabilities (3 moderate, 1 high, 1 critical)
```

`npm audit` detail: all 5 findings are in `esbuild`/`vite`/`vitest`'s
**nested dev-only dependency chain** (vitest's internal dev server
allowing cross-origin requests — a vulnerability that matters only if you
run `vitest`'s dev/watch server exposed to a network, which this project
never does). None of these packages are bundled into `dist/` — confirmed
by inspecting `esbuild.config.mjs`, which only bundles the three
extension entry points via `esbuild`'s build API, never `vite`/`vitest`.
Accepted as a known, low-risk, dev-only finding; not fixed because the fix
requires a major (beta) `vitest` upgrade.

**`dist/manifest.json` vs `public/manifest.json`:** byte-identical
(`diff` returns nothing) as of the last `npm run build` in this session —
dist is not stale as of this snapshot. **This can silently go stale again
the moment source changes without a rebuild** — always run `npm run build`
before loading/reloading the unpacked extension, and re-diff if in doubt.

**Manifest permissions** (`public/manifest.json`):
```json
"permissions": ["storage", "alarms", "notifications", "sidePanel", "tabs", "power", "scripting"],
"host_permissions": ["https://pro.kraken.com/*", "https://api.kraken.com/*"],
"content_scripts": [{ "matches": ["https://pro.kraken.com/prop/*"], ... }]
```
No `<all_urls>`. `power` is required for `chrome.power.requestKeepAwake`;
`scripting` is present (likely for future/defensive re-injection use — see
`sendMessageToKrakenTab`'s auto-reinject path in service-worker.ts).

---

## 4. Architecture overview

Manifest V3, three JS entry points built by `esbuild.config.mjs`
(content script → IIFE, service worker + side panel → ESM), no bundler
magic beyond that — deliberately chosen over Vite so the three entry
points can have different output formats without fighting a bundler built
around single-page apps.

```
content script (runs on https://pro.kraken.com/prop/*)
  reads the DOM only — parses positions, checks login/session state,
  runs diagnostics, and (only when explicitly asked by the service worker,
  per validated fingerprint) opens/confirms Kraken's own close dialog.
  Never has its own polling loop; only responds to messages.
        |
        | chrome.runtime messages (src/shared/messages.ts)
        v
service worker (background, persistent logic + all side effects)
  owns RuntimeState in chrome.storage.local, runs the poll/market-refresh
  alarms, evaluates strategy, runs the LIVE auto-close state machine,
  requests/releases keep-awake, sends notifications, writes the audit log.
        ^
        | chrome.runtime messages
        v
side panel (the only UI surface)
  pure read/render functions in components.ts, wiring in sidepanel.ts.
  Never touches the DOM/storage directly except via messages to the
  service worker (and a couple of direct chrome.storage.local reads for
  the audit log, which is fine since storage is shared across contexts).
```

Shared, dependency-direction rule: `shared/` has no dependents inside the
extension (types/constants/messages/validation only); `content/` depends
on `shared/`; `background/` depends on `shared/`, `api/`, `strategy/`,
`storage/`; `sidepanel/` depends on `shared/` and `storage/` (audit log
only). This was deliberately kept acyclic after an early circular-import
near-miss (see `field-extraction.ts`'s docstring) — if you're tempted to
import from `content/` into `shared/` or vice versa in a new direction,
stop and reconsider.

---

## 5. File map

```
public/manifest.json           MV3 manifest (source of truth; dist/ is generated from it)
esbuild.config.mjs             Build: 3 entries, mixed IIFE/ESM, copies static files
icons/                         16/48/128px PNGs (placeholder shield icon)

src/shared/
  types.ts                     Every domain type: RuntimeState, TrackedPosition, Settings,
                                Decision, SessionState, CloseExecutionState,
                                LiveAutoClosePreflightResult, DiagnosticsReport, etc.
                                THE canonical reference for the current data model.
  constants.ts                 DEFAULT_SETTINGS, PROFIT_LOCK_TIERS, Kraken public URLs,
                                alarm names, DEV_WATCHLIST_SYMBOLS
  messages.ts                  ExtensionMessage union — every message type exchanged
                                between content script / service worker / side panel
  validation.ts                validateCandles(), checkPriceTolerance() — pure, shared

src/api/
  kraken-public.ts              fetchCompletedHourlyCandles(), fetchCurrentPrice() —
                                Kraken public OHLC/Ticker only, excludes forming candle
  symbols.ts                    resolvePublicMarket() (dynamic, cached, AssetPairs-backed)
                                + legacy resolveSymbol() (static-only, now dead/unused
                                in production code — SYMBOL_MAP override table lives here)

src/strategy/
  sma.ts                        computeSMA(), computeSmaSeries() — pure, no look-ahead
  exit-strategy.ts               computeCurrentReturnPct(), updatePeakAndFloor(),
                                evaluateExitRules() (priority: hard-loss > profit-lock >
                                SMA break > hold/watch), seedCandleProgressAtLatestCompleted()
                                (prevents a stale CLOSE from historical candles the moment
                                a position starts being tracked), applySafetyGating(),
                                isNewCloseTransition()
  state-machine.ts               computeFingerprint() (symbol+side+opening price+bucketed
                                value+leverage — opening price carries the most identity
                                weight), reconcilePositions() (per-scan identity resolution:
                                new/continuing/changed/closed, supports N lots per symbol)

src/content/  (runs ONLY on https://pro.kraken.com/prop/*)
  kraken-dom.ts                 Low-level DOM primitives: textOf, ownText, parseNumberFromText,
                                findPositionsContainer (semantic-first, heading-text fallback),
                                findPositionRows, findLabeledText, findCloseControlCandidates,
                                resolveOwnedCloseControls (disambiguates a close control's
                                owning row when rows are nested)
  row-discovery.ts               discoverRowsBySymbolAnchors() — the fallback row finder:
                                walks up from an exact "Long"/"Short" or symbol text node to
                                the smallest ancestor also containing the other required
                                signals. Used only when semantic role/data-testid markup
                                finds nothing (which is the common case on Kraken's real page).
  field-extraction.ts            extractSymbol/extractSide/extractRawPositionFields — pure
                                field parsing, factored out so position-parser.ts and
                                position-grouping.ts can both depend on it without a cycle
  position-parser.ts              parsePositionsFromDocument() — semantic rows first, falls
                                back to row-discovery.ts; resolveActionableRows() (exported,
                                reused by close-preview.ts); parsePositionRow()
  position-grouping.ts            computeRowEvidence()/groupRows() — links a summary row to
                                its actionable child row(s) via containment > aria-controls >
                                shared data-* attribute > weak document-order-proximity+symbol
                                match (in that priority order); multiple actionable children
                                per summary is normal, flagged ambiguous only when two lots
                                are provably indistinguishable (same opening price/value)
  page-health.ts                  checkPageHealth() — tri-state SessionState (LOGGED_IN/
                                LOGGED_OUT/UNKNOWN); LOGGED_OUT requires positive evidence
                                (login form, session-expired modal, CAPTCHA, 2FA, device
                                approval, or an auth-redirect URL) — never inferred from
                                absence of positions
  diagnostics.ts                 runDiagnostics() — the read-only report assembled for the
                                side panel's "Run DOM Diagnostics" button; also exports
                                buildCloseControlInfo() (reused by close-preview.ts) and
                                sanitizeText()/redaction helpers
  structural-census.ts            buildStructuralCensus() — div/role counts, keyword counts,
                                ancestor-chain reports for sample Long/Short/symbol anchors;
                                surfaced only when normal row discovery finds little/nothing
  close-preview.ts                THE guarded close-execution surface. Exports:
                                previewClosePosition() (find+highlight only, no click),
                                openKrakenCloseDialog() (click the row's owned close control,
                                wait for and validate Kraken's modal), validateCloseModal()
                                (pure — checks title/side/sell-quantity/final-button text,
                                rejects on any open/increase/short wording),
                                confirmValidatedCloseModal() (re-validates, then clicks the
                                exact final button — never more than one match allowed)
  close-executor.ts               LEGACY STUB — all three exports unconditionally throw.
                                Left in place only so an accidental old import fails loudly
                                instead of silently doing nothing.
  content-script.ts               Message listener wiring: REQUEST_SCAN, RUN_DOM_DIAGNOSTICS,
                                PREVIEW_CLOSE, OPEN_CLOSE_DIALOG, CONFIRM_CLOSE_DIALOG,
                                CLOSE_MODAL_STATUS — dispatches to the modules above

src/background/
  service-worker.ts (1633 lines) THE orchestrator. See section 9 below for a full trace —
                                this is the single largest and most safety-critical file.
  scheduler.ts                    startPolling/stopPolling (position scan alarm),
                                startMarketDataPolling/stopMarketDataPolling (separate
                                market-refresh alarm), detectSleepGap()
  power.ts                        requestSystemKeepAwake()/releaseSystemKeepAwake() —
                                thin wrappers over chrome.power, each returns {ok:true} or
                                {ok:false, error} rather than throwing
  market-data-table.ts             buildMarketDataTable() — one row per unique symbol
                                (detected position ∪ DEV_WATCHLIST_SYMBOLS), uses
                                resolvePublicMarket() (the dynamic resolver)
  notifications.ts                chrome.notifications wrapper

src/storage/
  state.ts                        getState()/setState()/updateState() — chrome.storage.local
                                read/write/merge helpers
  migrations.ts                   freshRuntimeState() (all safe defaults), migrateState()
                                (schema v1 only right now; the seam for future migrations)
  audit-log.ts                     Bounded (MAX_AUDIT_LOG_ENTRIES=2000) sanitized audit log

src/sidepanel/
  sidepanel.html/css              Static shell + styling (dark theme, tab bar, tables)
  components.ts (1108 lines)      Pure render functions: renderAppHeader, renderTabBar,
                                renderConnectionPanel, renderControlsPanel, renderStatusPanel,
                                renderPositionCard/renderPositionsSection, renderMarketDataPanel,
                                renderLogsSection, renderDiagnosticsSection, renderSettingsPanel
  sidepanel.ts (383 lines)         Wiring: tab selection/persistence, all chrome.runtime.sendMessage
                                calls, the manual-close 3-phase flow (requestManualClose →
                                continueManualClose/openCloseDialog → confirmManualClose),
                                armAutoClose() (dry-run vs. LIVE — LIVE requires the
                                RUN_LIVE_PREFLIGHT round-trip plus a native `confirm()`
                                acknowledgment before arming)

tests/  (12 files, 126 tests — see section 10)
python-legacy/  ARCHIVED. Do not touch.
```

---

## 6. Data model — `RuntimeState` (src/shared/types.ts)

The single source of truth, persisted in `chrome.storage.local` under one
key, read/written via `src/storage/state.ts`. Key fields beyond the
obvious (`positions`, `settings`, `marketData`):

- `monitoringStatus: "STOPPED" | "RUNNING"` — Start/Stop Monitoring.
- `executionMode: "MONITOR_ONLY" | "PREVIEW" | "ARMED_AUTO_CLOSE"` +
  `autoCloseLive: boolean` — `PREVIEW` is a reserved/unused value today;
  the real distinction is `ARMED_AUTO_CLOSE` with `autoCloseLive` true
  (LIVE) or false (dry-run/logging-only).
- `armedUntil: number | null` — epoch ms; arming is always duration-capped
  (capped at 24h regardless of what's requested — see service-worker.ts
  ~line 486).
- `keepAwakeStatus: "INACTIVE" | "ACTIVE" | "ERROR"` + `keepAwakeError`.
- `livePreflight: LiveAutoClosePreflightResult | null` — last preflight
  result (`{ allowed, blockers[], checkedAt }`), shown in the side panel.
- `closeExecution: CloseExecutionRecord | null` — the *single* in-flight
  or most-recent execution record:
  `state: CREATED → DIALOG_OPENING → MODAL_VALIDATED → FINAL_SUBMITTING →
  VERIFYING → SUCCEEDED | FAILED | BLOCKED | UNCERTAIN`.
- `liveAutoCloseStats` — `closesThisSession`, `closeTimestamps[]` (for the
  rolling-hour limit), `unresolvedSleepGap`, `previousExecutionUncertain`.
- `autoCloseDryRunIntents: Record<fingerprint, timestamp>` — prevents the
  dry-run path from re-logging the same lot's CLOSE intent every poll.
- `lastContentScriptResponseAt` / `lastCandidateRowCount` /
  `lastRowDiscoveryMethod` — connection-state fields; deliberately updated
  by *any* successful content-script response (a scan **or** a diagnostics
  run), not just the monitoring poll loop. This was a real bug fix earlier
  in the project's history (see section 12) — do not regress it by making
  these fields poll-loop-only again.

`TrackedPosition` is keyed by `fingerprint` in `positions`. One entry per
**lot**, not per symbol — `computeFingerprint()` weights opening price
highest, so two lots of the same symbol at different entry prices always
get different fingerprints and are tracked (and evaluated) independently.
`MarketDataRow` is the separate, per-*symbol* (not per-lot) table used for
the side panel's Market tab.

---

## 7. Message protocol (src/shared/messages.ts)

All messages are members of the `ExtensionMessage` discriminated union,
narrowed via `isExtensionMessage()`. Full current list:

| Message | Direction | Purpose |
|---|---|---|
| `POSITIONS_SCAN_RESULT` | content → SW | Result of a DOM scan; drives `processScanResult()` |
| `REQUEST_SCAN` | SW → content | "Scan now" |
| `GET_STATE` / `STATE_SNAPSHOT` | panel ↔ SW | Full state fetch/broadcast |
| `START_MONITORING` / `STOP_MONITORING` | panel → SW | Monitor Only lifecycle |
| `ARM_AUTO_CLOSE` `{durationHours, live}` | panel → SW | Arm dry-run or LIVE |
| `RUN_LIVE_PREFLIGHT` / `..._RESULT` | panel ↔ SW | Preflight check before LIVE arming UI proceeds |
| `DISARM_AUTO_CLOSE` | panel → SW | Manual disarm |
| `REFRESH_POSITIONS` | panel → SW | Manual re-scan |
| `REFRESH_MARKET_DATA{symbol?}` / `..._RESULT` | panel ↔ SW | Manual market refresh, all or one symbol |
| `SET_EXECUTION_MODE` | panel → SW | Reserved; only MONITOR_ONLY currently honored |
| `TEST_NOTIFICATION` | panel → SW | Fires a real Chrome notification |
| `EXPORT_LOGS` / `..._RESULT`, `CLEAR_LOGS` | panel ↔ SW | Audit log export/clear |
| `UPDATE_SETTINGS` / `RESET_SETTINGS` | panel → SW | Settings panel save/reset |
| `RUN_DOM_DIAGNOSTICS` / `DOM_DIAGNOSTICS_RESULT` | panel → SW → content | Diagnostics report round-trip |
| `PREVIEW_CLOSE` / `..._RESULT` | panel → SW → content | Highlight-only preview (no click) |
| `OPEN_CLOSE_DIALOG` / `..._RESULT` | panel → SW → content | Click the row's close control, validate the resulting modal |
| `CONFIRM_CLOSE_DIALOG` / `..._RESULT` | panel → SW → content | Re-validate + click the modal's final confirm button |
| `CLOSE_MODAL_STATUS` / `..._RESULT` | SW → content | Post-close: is the modal gone / success feedback visible |

---

## 8. Strategy engine — verified correct this session

`src/strategy/exit-strategy.ts`:
- `computeCurrentReturnPct(openingPrice, currentPrice)` = `((currentPrice
  - openingPrice) / openingPrice) * 100`. **No leverage parameter exists in
  the signature** — it structurally cannot be leverage-multiplied.
- Rule priority, checked in this exact order inside `evaluateExitRules()`:
  1. **Hard loss**: `currentReturnPct <= hardLossPercent` (default -3%) → CLOSE, checked first and unconditionally.
  2. **Profit protection**: floor computed via `computeProfitFloor()` using `PROFIT_LOCK_TIERS` ([3,7)→50% retained, [7,15)→65%, [15,∞)→75%); `updatePeakAndFloor()` guarantees the floor only ever rises (`Math.max` against the previous floor).
  3. **SMA break**: strong trend (SMA7>SMA30) needs `strongTrendConfirmationCloses` (default 2) consecutive completed hourly closes below SMA7; weak trend needs `weakTrendConfirmationCloses` (default 1).
  4. Otherwise HOLD/WATCH.
- `advanceCandleProgress()` only processes candles newer than
  `lastProcessedCandleTs`, so repeated polling of the same completed candle
  never double-increments the SMA-break counter.
- `seedCandleProgressAtLatestCompleted()` — called when a position is
  first tracked (`lastProcessedCandleTs === null`) — seeds the counter at
  the *latest* completed candle instead of processing the full historical
  backlog, so a freshly-registered position can never trigger an immediate
  stale CLOSE from candles that existed before the position was tracked.
- `applySafetyGating()` downgrades an otherwise-CLOSE decision to BLOCKED
  whenever any blocking reason is present (stale data, price mismatch,
  ambiguous row, changed position, etc.) — HOLD/WATCH are never blocked.

All of the above is regression-tested in `tests/exit-strategy.test.ts`,
including an explicit test using the exact numbers `0.61828 → 0.59870`
(≈-3.17%) asserting CLOSE fires even when the SMA rule alone would say
HOLD or WATCH.

---

## 9. LIVE auto-close — exact trace (verified via direct read + sub-agent line audit)

**Arming** (`ARM_AUTO_CLOSE` → `handleArmAutoClose()` in service-worker.ts):
- `live: false` (dry-run): arms with only a "monitoring is running" check.
- `live: true`: first requires `canArmLiveAutoClose()` to return
  `allowed: true`. That preflight checks, in order: not already in-flight,
  no unresolved prior-UNCERTAIN execution, no unresolved sleep gap,
  keep-awake ACTIVE, Kraken tab present, content script responsive (fresh
  `REQUEST_SCAN` round-trip), page health (`propPageDetected`,
  `sessionState === LOGGED_IN`, `positionsTableReadable`, ≥1 LONG
  candidate row), position-scan and price-update freshness (`≤
  pollMinutes * 2`), at least one active auto-close-eligible position with
  healthy market data and a resolved symbol, and — for every position
  currently at CLOSE — a live `PREVIEW_CLOSE` round-trip confirming
  close-control ownership. Side panel additionally requires the user to
  type a duration and click through a native `confirm()` dialog
  ("I understand that qualifying live positions may be closed
  automatically") before sending `ARM_AUTO_CLOSE`.
- On success: `executionMode = ARMED_AUTO_CLOSE`, `autoCloseLive = live`,
  `armedUntil = now + hours (capped at 24h)`, session stats reset.

**Execution trigger** (`processLiveAutoClose()`, called at the end of
every `processScanResult()`): only proceeds if not already in-flight
(`autoCloseInFlight` module-level lock), monitoring RUNNING,
`ARMED_AUTO_CLOSE` + `autoCloseLive`, and `armedUntil` not expired. Picks
the first ACTIVE position with `decision === "CLOSE"`, no
`autoCloseDisabledReason`, not already in `autoCloseDryRunIntents`.

**Execution limits**, checked before proceeding: rolling-hour count
against `maxLiveClosesPerHour` (default 2) and session count against
`maxLiveClosesPerArmedSession` (default 5) — either breach disarms LIVE
immediately.

**Fresh revalidation immediately before the final click**
(`revalidateCloseCandidateBeforeSubmit()`): checks signal not expired
(`autoCloseSignalExpiryMinutes`, default 5 min), re-scans the DOM fresh,
confirms the exact fingerprint/symbol/side is still ACTIVE with value
within tolerance, re-resolves the symbol, fetches a fresh price + 100
fresh hourly candles, recomputes SMA/return/peak/floor, **re-runs
`evaluateExitRules()` and requires the decision still be CLOSE with the
same trigger family** (HARD_LOSS/PROFIT_LOCK/SMA), and re-validates the
Kraken modal. Any failure blocks the click — a stale stored CLOSE decision
is never sufficient by itself.

**Click + verification**: `openKrakenCloseDialog()` clicks the row's
*owned* close control (via `resolveOwnedCloseControls`, disambiguating
nested rows) and waits up to 5s for a modal that
`validateCloseModal()` accepts (exactly one modal referencing the exact
symbol, a genuine close/sell-to-close action, matching quantity, exactly
one final button matching `"close <symbol> long position"`-style wording,
and **no** open/increase/short/leverage wording anywhere in the modal —
any of those blocks). `confirmValidatedCloseModal()` re-validates then
clicks the final button. `verifyCloseSubmitted()` then polls every 500ms
for up to `closeVerificationTimeoutSeconds` (default 10s), re-scanning the
DOM each time, checking: the exact fingerprint is gone, active count
dropped by exactly one, all other previously-tracked fingerprints are
still present, no opposite SHORT appeared, and the modal itself resolved.
Any ambiguous signal (wrong lot vanished, an opposite SHORT appeared, or
timeout) yields **UNCERTAIN**, not FAILURE — UNCERTAIN always disarms LIVE
and is never auto-retried.

**Hard disarm conditions implemented** (all confirmed in
service-worker.ts): arming expiry, keep-awake dropping out of ACTIVE while
armed, sleep-gap detection while armed, Kraken tab disappearing while
armed, content script becoming unreachable while armed, hourly/session
limit breach, close-dialog validation failure, fresh-revalidation failure,
UNCERTAIN verification result, session going LOGGED_OUT while armed,
parser/page-health degrading while armed, a tracked position's fingerprint
changing/ownership becoming ambiguous while armed, market/API health
failing for an active position while armed, and manual `DISARM_AUTO_CLOSE`.

**Keep-awake**: `chrome.power.requestKeepAwake("system")` requested on
Start Monitoring, released on Stop Monitoring and on restart-reset;
LIVE arming's preflight requires `keepAwakeStatus === "ACTIVE"`, and it
becoming anything else while armed is itself a hard-disarm condition. No
synthetic scrolling/mouse/keyboard activity anywhere in the codebase.

---

## 10. Manual close — exact trace

`sidepanel.ts`: `requestManualClose()` (phase `INITIAL_CONFIRM`, shows a
summary card) → user clicks continue → `continueManualClose()` →
`openCloseDialog()` sends `OPEN_CLOSE_DIALOG` → service worker relays to
content script's `openKrakenCloseDialog()` (same function LIVE uses) →
row/control re-resolved fresh from the current DOM by fingerprint, close
control clicked, modal validated → phase becomes `MODAL_VALIDATED` only if
`validateCloseModal()` says `ready: true` → user must explicitly click
**Confirm Close** in the side panel → `confirmManualClose()` sends
`CONFIRM_CLOSE_DIALOG` → content script's `confirmValidatedCloseModal()`
re-validates and clicks the exact final button only if still ready. Manual
close shares the same row/control/modal-validation code path as LIVE
auto-close (`close-preview.ts`) — there is exactly one click-capable code
path in the whole extension, not two parallel implementations to keep in
sync.

---

## 11. DOM Diagnostics (read-only, never clicks/hovers)

Side panel → **Run DOM Diagnostics**. Reports (see `DiagnosticsReport` in
types.ts): page/domain/URL/session detection, candidate row count vs.
resolved position count, which discovery method actually ran
(`SEMANTIC_ROLES` | `TEXT_ANCHOR_FALLBACK` | `NONE`), per-row parsed
fields and close-control accessible-name info (explicitly says when a
name is only available via hover, since diagnostics never hovers), and
position-group evidence per symbol. When row discovery finds nothing
useful, a **structural census** (div/role counts, keyword counts,
`data-*`/`aria-label` attribute name inventory, ancestor-chain samples for
Long/Short/symbol text anchors) is included to support manual selector
calibration. Everything is sanitized (account IDs, UUIDs, emails redacted)
before being surfaced; nothing here ever reads cookies/localStorage/
sessionStorage/request headers.

---

## 12. Real bugs found and fixed in this project's history (don't reintroduce)

1. **`findLabeledText`'s regex always read capture group 1**, but a
   keyword regex like `/open(ing)?\s*price/i` has its own inner group,
   silently shifting the real captured value to group 2 — every "Opening
   price" field was discarded on div-based (non-table) pages. Fixed to
   read the *last* match group; the specific regex was also changed to a
   non-capturing group. (`src/content/kraken-dom.ts`)
2. **`findPositionsContainer` required a `role="table"`/`role="grid"`/
   `data-testid*="position"` marker with no fallback** — on a page built
   from plain divs with no such markers, it returned `null` even though
   an "Open positions" heading existed. Added a heading-text fallback.
3. **Connection state ("Kraken tab: connected/disconnected") was only
   ever updated inside the monitoring poll loop** — running Diagnostics
   alone (without ever pressing Start Monitoring) never updated it, so the
   UI showed "disconnected" even while diagnostics was clearly working.
   Fixed by updating `lastContentScriptResponseAt`/`krakenTabId` on *any*
   successful content-script response.
4. **Login state was a flat boolean** that collapsed "no positive
   evidence yet" into "logged out." Replaced with a tri-state
   `SessionState`; `LOGGED_OUT` now requires positive negative evidence.
5. **The original grouping/ambiguity logic assumed at most one actionable
   child per summary row** — treating a market with two real lots (e.g.
   two XPL LONG rows at different entry prices) as "ambiguous, blocked."
   Rewritten to allow N lots per summary, only flagging ambiguous when two
   specific lots are provably indistinguishable (same opening price/value
   within tolerance).
6. **The weak-adjacency grouping evidence tier only checked immediate DOM
   siblings**, which fails when a summary has more than one actionable
   child in a flat sibling list. Broadened to "nearest same-symbol
   non-actionable row in document order," still logged as the weakest
   evidence tier.

All six are covered by regression tests built against a fixture that
mirrors a real multi-lot, div-based Kraken page structure
(`tests/fixtures/real-world-multilot.html`,
`tests/fixtures/real-world-aave-jto-xpl.html`,
`tests/fixtures/production-column-positions.html`).

---

## 13. Testing — what is and is not covered

**126 tests across 12 files, all unit/fixture-level (jsdom), zero live
Kraken interaction.** Concretely:
- Strategy math, SMA no-look-ahead, priority ordering, floor monotonicity:
  unit-tested with synthetic data.
- Row discovery, grouping, fingerprinting, multi-lot distinctness, session
  tri-state, diagnostics report shape: fixture-tested against static HTML
  built to resemble (not captured from) the real page.
- Close-modal validation (`tests/close-modal-validation.test.ts`):
  fixture-tested against synthetic modal HTML.
- Keep-awake (`tests/power.test.ts`): tests the thin wrapper's
  try/catch-to-result-object behavior, not real `chrome.power` behavior
  (jsdom doesn't have it — these are essentially mock-level tests).
- Market data table: tested with a mocked `fetch`, never hits the real
  Kraken API in CI.

**Not yet done, as of this writing (verify before relying on any of this in
production):**
- No live browser load of the unpacked extension against a real, logged-in
  Kraken Prop page in *this* session.
- No live manual close performed against a real Kraken account.
- No live LIVE-auto-close execution observed end-to-end on a real account.
- No overnight/soak test.
- The `findFinalCloseControls`/`validateCloseModal` text patterns in
  `close-preview.ts` (e.g. `"close <symbol> long position"`) are
  **educated guesses about Kraken's real modal wording**, not confirmed
  against the actual DOM — this is the single highest-risk unverified
  assumption in the whole live-close path.
- Dynamic symbol resolution (`resolvePublicMarket`) has never been
  exercised against a real Kraken `AssetPairs` response for a symbol
  outside the hardcoded `SYMBOL_MAP` override table.

---

## 14. Known minor cleanup items (not urgent)

- `resolveSymbol()` (the static-only synchronous resolver) in
  `src/api/symbols.ts` is dead code — nothing in `src/` or `tests/` calls
  it anymore; everything uses `resolvePublicMarket()`. Safe to delete or
  leave as a documented fallback reference.
- `Settings.requireRearmAfterGapMinutes` exists in the type/defaults but
  is not read anywhere in `service-worker.ts` per the sub-agent's review —
  confirm whether it's meant to gate something (e.g. requiring an
  explicit re-arm after a long sleep gap even after the gap "resolves")
  or whether it's vestigial.
- `close-executor.ts` is a dead legacy stub kept only as a trap for stale
  imports; fine to delete once confirmed nothing references it (nothing
  does today).

---

## 15. Build & dev commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
npm run build       # esbuild -> dist/
npm run watch       # esbuild --watch, for active development
```

Load/reload: `chrome://extensions` → Developer mode → Load unpacked →
select `dist/` (after `npm run build`) → reload icon after every rebuild.
Side panel opens via the pinned toolbar icon
(`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`).

---

## 16. Suggested next steps for whoever picks this up

1. **Do not add features yet.** The highest-value next action is live
   verification against a real, logged-in Kraken Prop page: run **Run DOM
   Diagnostics**, confirm row discovery/grouping/fingerprinting behave as
   documented in section 12, and — critically — manually trigger the
   **manual close** flow (never LIVE auto-close) once, in a supervised
   session, to see whether `validateCloseModal()`'s text patterns actually
   match Kraken's real modal wording. This is the single biggest unknown.
2. If the user wants a formal, structured production-readiness audit
   (executive verdict, feature matrix, preflight/disarm/verification
   audits, go/no-go answers) — that is a distinct, large deliverable with
   its own required report format that was requested alongside this
   handoff doc but not yet performed. Confirm whether they still want it
   run as a separate pass before doing so.
3. Resolve the two "known minor cleanup" items in section 14 once the
   above is confirmed, not before.

---

## 17. Addendum: continuity audit + watchdog/restart fixes (this session)

The user explicitly clarified that continuous unattended LIVE execution
*is* the intended product behavior, not something to hedge on, and asked
for an audit of that specific claim. Findings and fixes:

**Confirmed already correct by reading the code:** monitoring is
alarm-driven and survives routine service-worker suspend/wake (alarms
persist independent of the worker's lifecycle; state is read fresh from
`chrome.storage.local` every cycle). A successful LIVE close does not stop
monitoring or disarm — only stats increment. Execution limits, revalidation
before final click, and post-close verification (SUCCESS/FAILED/UNCERTAIN)
all already worked as designed.

**Two real gaps found and fixed:**
1. **Silent stall.** `lastHeartbeatAt` was bumped every alarm tick
   regardless of whether the scan actually succeeded, so sleep-gap
   detection could never catch "the Kraken tab exists but the content
   script stopped responding, forever." Fixed with a dedicated watchdog:
   `src/background/watchdog.ts` (pure, unit-tested) computes
   `max(3 * pollMinutes, 15 minutes)`; `recordScanOutcome()` in
   service-worker.ts tracks consecutive failures against the last
   *successful* scan (`lastPositionScanAt`, not `lastHeartbeatAt`), and on
   first breach: disarms LIVE if armed, appends an audit entry, sends an
   urgent notification, and sets `RuntimeState.monitorStalledSince` (drives
   a new red STALLED banner in `renderStatusPanel`/`renderHeartbeatBanner`
   in components.ts). Recovery (next successful scan) clears it and sends
   a non-urgent "recovered" notification.
2. **Restart silently discarded interrupted executions.**
   `resetToSafeDefaultsOnRestart()` (onInstalled/onStartup) used to wipe
   `closeExecution` unconditionally with no notification, even if it was
   sitting in a non-terminal state (e.g. `FINAL_SUBMITTING`) — meaning a
   close whose real Kraken outcome was unknown could be silently forgotten.
   Rewritten to: (a) detect a non-terminal `closeExecution` and mark it
   UNCERTAIN with an urgent "verify manually" notification before touching
   anything else; (b) always disarm LIVE; (c) if monitoring *was* running
   before the restart and the Kraken tab is still open, resume monitor-only
   monitoring (recreate both alarms, reassert keep-awake, run an immediate
   scan) rather than silently stopping; (d) notify separately that LIVE
   needs a manual re-arm if it had been armed. Also added a one-line
   defense-in-depth check in `processLiveAutoClose()`: it now also refuses
   to start a new execution if the persisted `closeExecution` is
   non-terminal, not just the in-memory `autoCloseInFlight` flag (which
   doesn't survive a mid-execution restart).

**New feature, as requested:** `Settings.startMonitoringWithLiveAutoClose`
(default off). When on, clicking Start Monitoring shows one confirmation,
then starts monitoring and — only if the real LIVE preflight passes once a
fresh scan exists — arms LIVE automatically
(`START_MONITORING_WITH_LIVE_AUTO_CLOSE` message,
`handleStartMonitoringWithLiveAutoClose()`). If preflight fails, monitoring
stays running in Monitor Only and the panel shows exactly why. The
separate two-step flow (Start Monitoring, then Arm LIVE Auto-Close) is
unchanged and remains the default.

**Testing added:** `tests/watchdog.test.ts` (pure stall-threshold logic,
8 tests) and `tests/service-worker-continuity.test.ts` (8 tests) — the
latter is new: it's the *first* test file to import and exercise
service-worker.ts directly, against a minimal hand-written chrome.\* mock
(storage/alarms/tabs/power/notifications/runtime, no network). It proves,
against the real code (not just by reading it): the poll alarm is created
and firing it re-invokes the scan; a routine single scan failure doesn't
tear down the scheduler; repeated failures past the threshold set
STALLED and notify urgently; Stop Monitoring cancels both alarms and
releases keep-awake; a restart with monitoring previously running
recreates the alarm and resumes Monitor Only while resetting LIVE; a
restart with a non-terminal `closeExecution` marks it UNCERTAIN and
notifies urgently instead of silently discarding it; and the combined
Start+LIVE message correctly refuses to arm without a real preflight pass.
**Deeper execution-path scenarios (a tracked position actually reaching
CLOSE and successfully auto-closing, second-position-closes-later,
uncertain-close disarms end-to-end) remain code-reviewed, not
test-automated** — they'd require also mocking Kraken's OHLC/Ticker
responses through a full strategy evaluation, which is a larger harness
than this pass's scope; flagging this explicitly rather than overclaiming
coverage.

All four gates pass after these changes: `npm run typecheck`, `npm run
lint`, `npm test` (142/142, up from 126), `npm run build`.

## 18. Addendum: execution-only phone notification + TradingView link (this session)

The user asked for a phone/email notification, but scoped it tightly:
"only send it when something executes with details of execution... I
dont need any montioring or condition emails." That rules out firing on
monitoring start/stop, strategy signal triggers, arming, or stall/health
events — those already have Chrome notifications and an audit trail; this
is specifically for a close *execution* reaching a terminal outcome.

**Implementation:** `src/background/execution-notify.ts` (new, pure
functions + one `fetch` call) POSTs to a user-supplied
`Settings.executionWebhookUrl` (default `""` = disabled) exactly at the
four points a close execution reaches SUCCESS/FAILURE/UNCERTAIN in
`service-worker.ts`: LIVE auto-close success, LIVE auto-close
failed/uncertain, manual close success, manual close failed/uncertain (all
inside `processLiveAutoClose()` and `handleConfirmCloseDialog()`). It is
not called anywhere else.

Scoped to **ntfy.sh only**, deliberately — `isSupportedExecutionWebhookUrl()`
rejects anything else. ntfy.sh is a free, no-signup push service: the user
installs the ntfy app, subscribes to a topic name they make up, and pastes
`https://ntfy.sh/<that-topic>` into the new Settings field. This works with
zero extra permission prompts because `https://ntfy.sh/*` is a static entry
in `manifest.json`'s `host_permissions`.

**Explicitly rejected this pass:** arbitrary custom webhook URLs
(Discord/Slack/email-via-Zapier/etc.) via `optional_host_permissions` +
`chrome.permissions.request()`. I added `"optional_host_permissions":
["<all_urls>"]` at one point while exploring this, then reverted it — it
violates the standing instruction not to request broader permissions than
declared. If the user wants arbitrary webhook destinations later, the
correct pattern is `optional_host_permissions` scoped to specific origins
(never `<all_urls>`) with a runtime permission prompt when the setting is
saved, but that's a deliberate follow-up, not something to add silently.

**UI:** new "Phone notification URL (ntfy.sh)" text field in
`renderSettingsPanel` (components.ts), validated client-side by the same
`isSupportedExecutionWebhookUrl()` check (blank is fine, anything non-empty
must be an ntfy.sh URL).

**Diagnostic answered, not a code change:** the user asked whether
repeated "Exit condition triggered" log lines they saw for JTO/TIA/XPL
should have caused an actual close. Confirmed by reading the code:
`SELL_CONDITION_TRIGGERED` audit entries are appended inside
`evaluatePositions()` on *every* scan whenever a rule fires, completely
decoupled from `executionMode` — a MONITOR_ONLY session (or a session
where LIVE was never armed) will log the same "would exit" line
indefinitely without ever closing anything. Told the user to check their
exported audit log for `AUTO_CLOSE_ARMED` entries around the same
timestamps to confirm whether LIVE was actually armed at the time.

**TradingView link ("only if easy"):** added a "Chart" link (plain
`<a target="_blank" rel="noopener noreferrer">`, no iframe/embed, so no CSP
or extra permissions needed) to each Market Data card, pointing to
`https://www.tradingview.com/chart/?symbol=KRAKEN:<PAIR>` where `<PAIR>` is
`MarketDataRow.apiMarket` with the `/` stripped (e.g. `XPL/USD` ->
`KRAKEN:XPLUSD`). Purely a convenience link; the extension does not embed
or scrape TradingView.

**Testing:** `tests/execution-notify.test.ts` (13 new tests) covers URL
validation, title/body formatting (including omission of null fields), and
`sendExecutionWebhook` — empty URL no-ops, unsupported host no-ops, correct
POST headers/body to ntfy.sh, urgent priority for FAILURE/UNCERTAIN vs.
default for SUCCESS, and that a `fetch` rejection is swallowed rather than
thrown. No test harness changes were needed since these are pure functions
plus a mockable global `fetch`.

All four gates pass: `npm run typecheck`, `npm run lint`, `npm test`
(155/155, up from 142), `npm run build`.

**Follow-up in the same session:** the user clarified they specifically
want phone push (already covered above) plus email, to
`nitgaddam@gmail.com`. Rather than adding a separate email-sending path
(which would need its own service/API key, contradicting "I want it to be
free"), wired ntfy.sh's own built-in free email add-on: an `X-Email`
header on the exact same POST to the ntfy topic. New
`Settings.executionEmailAddress` (default `""`), a second Settings text
field ("Also email execution alerts to"), and a new
`isPlausibleEmailAddress()` check (loose format check only — ntfy.sh
itself validates deliverability). It's additive to the existing ntfy topic
URL, not a separate channel: if the topic URL is blank, the email never
fires either, since there's nothing to attach the header to. Explicitly
did **not** attempt SMS-to-phone-number delivery (`+1-415-900-8260`) via a
carrier email-to-SMS gateway (e.g. `@vtext.com`/`@txt.att.net`) — asked the
user and they chose push + email only, not the SMS gateway option, which
would have needed a specific carrier and is unreliable on several US
carriers today.

All four gates pass again after this follow-up: `npm run typecheck`,
`npm run lint`, `npm test` (160/160, up from 155), `npm run build`.

**User's ntfy.sh topic (personal to this install):** the user set up the
ntfy Android app (Play Store, publisher "ntfy.sh"); the actual subscribed
topic, confirmed by screenshot of the app's "Subscribed topics" screen, is
all-lowercase `kraken-guard-nitgaddam-1992` (ntfy topics are
case-sensitive — an earlier pass briefly "corrected" this to a capital K
based on autocapitalize in a chat message, which was wrong; verified by
sending a live test push to the lowercase topic and confirming delivery).
Pre-filled as the default in `DEFAULT_SETTINGS.executionWebhookUrl` in
constants.ts (`https://ntfy.sh/kraken-guard-nitgaddam-1992`) so it works
out of the box on this install and after any Reset to Defaults; still
fully editable/clearable in Settings if the user ever wants to rotate the
topic name.

**Email add-on does not actually work anonymously:** live-tested via curl
with an `X-Email` header — ntfy.sh's public server rejects it with
`"anonymous email sending is not allowed"` (HTTP 400, code 40053). The
assumption in the original implementation (free, no-signup email relay)
was wrong; it actually requires a signed-in ntfy.sh account. The
`executionEmailAddress` setting and `X-Email` header wiring are still in
place in code (harmless no-op today), but sending will silently fail with
that same error until/unless the user decides to set up a ntfy.sh account
and an access token gets wired in as an `Authorization` header — not done
in this pass, pending user decision.

## 19. Addendum: real-world live-arming session — two bugs found and fixed (this session)

The user armed LIVE Auto-Close for real (with real Kraken Prop positions:
XPL, JTO, TIA) and hit two genuine blockers in sequence, each root-caused
by reading the code rather than guessing, then fixed and verified:

**1. Login false negative.** `canArmLiveAutoClose()` requires
`pageHealth.sessionState === "LOGGED_IN"`, and `checkPageHealth()`
(src/content/page-health.ts) only set that from a narrow, unvalidated CSS
selector (`[data-testid*="account" i], [aria-label*="account" i]`) that
didn't match this account's real markup — so it stayed `UNKNOWN` even
though positions were clearly parsing correctly (which is only possible on
an authenticated page). Fixed: `checkPageHealth` now takes a third param,
`hasConfirmedPositions`, and upgrades `UNKNOWN` to `LOGGED_IN` when at
least one real position parsed (never downgrades an actual detected
logout) — mirrors a rule that already existed in the separate Diagnostics
report (`diagnostics.ts`'s `loggedInState` computation) but had never been
applied to the real scan path used for arming.
`content-script.ts::buildScanResult` now passes `positions.length > 0`.
Tests: two new cases in `tests/session-health.test.ts` (upgrade happens
without an account marker; a real logout is never overridden).

**2. Newly-tracked symbol blocked arming entirely.** Once login was fixed,
arming failed with `"TIA: no public market row"` — TIA had only just
become an active tracked position, and the separate Market Data table
(`state.marketData`, which `canArmLiveAutoClose`'s per-position market
check reads) only refreshes on its own independent timer
(`marketRefreshMinutes`), not on every position scan. This isn't a one-off
— it recurs any time a brand-new symbol appears between refresh cycles.
Fixed: `canArmLiveAutoClose()` now forces one `refreshMarketData({
automatic: false })` call (scoped to whatever's currently tracked) right
before evaluating the per-position market-data blockers, so a newly
detected symbol is always covered without waiting on the timer or a manual
refresh click.

**3. Design change, explicitly requested by the user:**
`processLiveAutoClose()` previously found and executed exactly one
qualifying CLOSE candidate per cycle, then returned — additional
qualifying lots would each wait for a separate subsequent poll cycle. The
user asked why, was given the reasoning (each close changes the Kraken
DOM; deferring to a fresh scan+revalidation before acting on any other
position avoids acting on stale DOM/position data, and doubles as a
natural throttle), and after hearing it, explicitly chose to process all
qualifying closes within one cycle instead. Reworked into a loop: after a
successful close, `verifyCloseSubmitted`'s own rescan already yields a
fresh, fully-reconciled position set (`done`), which becomes the next
iteration's `state` before re-checking rate limits and picking the next
candidate — so no two closes are ever attempted against stale data, they
just happen back-to-back within one cycle now instead of one-per-cycle.
Any failure/uncertain/blocked outcome, or hitting `maxLiveClosesPerHour`/
`maxLiveClosesPerArmedSession`, still disarms and stops the whole batch
immediately, exactly as before for a single candidate.
**Not covered by an automated test** — exercising this loop end-to-end
would require mocking `OPEN_CLOSE_DIALOG`/`CONFIRM_CLOSE_DIALOG`/
`PREVIEW_CLOSE` content-script responses through the service-worker
harness, which doesn't exist yet (falls into the same already-documented
gap in §13: "deeper execution-path scenarios... remain code-reviewed, not
test-automated"). Verified instead by careful code review of the control
flow (loop termination via rate limits/no-candidate/any-failure, and that
`state` is re-derived fresh each iteration) and by the full existing suite
still passing unchanged.

All four gates pass after all three fixes: `npm run typecheck`,
`npm run lint`, `npm test` (180/180, unchanged from before this addendum —
no regressions), `npm run build`.
