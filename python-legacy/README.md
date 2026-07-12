> **ARCHIVED — 2026-07-11.** This Python/Playwright approach was superseded by
> a Chrome-extension-only design (see `../README.md` at the repo root). This
> code is preserved as-is (tests were passing, ruff/mypy clean) in case the
> browser-extension approach is abandoned and a Python/Playwright executor is
> needed again. It is not being developed further.

# kraken-guard

A local macOS tool that watches crypto prices and, only after extensive
validation, **closes** existing manually-opened LONG positions in the
Kraken Prop web interface. It never opens a position, never increases size,
and never shorts anything.

> **Warning:** This tool uses browser automation against a live trading
> interface. UI changes, connectivity problems, stale data, browser state,
> slippage, and software bugs can result in missed or unintended executions.
> Maintain native platform risk controls where available and obtain
> confirmation that this type of automation is permitted for your Kraken
> Prop account.

## What stage this is

This repository currently implements **Stage 1** of a staged rollout — see
"Staged rollout" below. Stage 1 covers:

- fetching Kraken public market data,
- computing SMA7/SMA30 and evaluating the `CONFIRMED_BEARISH_CROSS` sell
  condition,
- persisting signals to SQLite with deduplication, cooldown, and expiry,
- manual position registration and safety-check logic,
- a dry-run CLI and macOS/Telegram notifications.

**No browser automation runs yet.** `inspect-ui` and `execute-signal` exist
in the CLI but currently refuse to do anything beyond reporting what the
safety checks would decide. Nothing in this stage can click anything on
Kraken Prop.

## Architecture

Two independent layers connected only through a persistent SQLite record
(`signals` table), never through direct function calls:

1. **Signal engine** (`market_data/`, `strategy/`) — fetches candles,
   computes SMAs, evaluates the configured sell condition, and writes a
   `Signal` row.
2. **Execution engine** (`execution/`) — Stage 2+. Will read `Signal` rows,
   run pre-flight safety checks (`execution/safety.py`, already
   implemented and tested), and only in later stages actually open a
   browser and click "Close position".

## Setup from a clean Mac

```bash
git clone <this-repo>
cd kraken_prop_guard  # or wherever you cloned it
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
playwright install chromium  # only needed ahead of Stage 2+
```

Copy the example config and env files and let `init` create the data
directories:

```bash
kraken-guard init
```

This copies `config.example.yaml` -> `config.yaml` and `.env.example` ->
`.env`, and creates `./data`, `./data/screenshots`, `./data/logs`.

## Creating a dedicated Chrome profile

This tool must reuse a Chrome profile where **you** are already logged into
Kraken Prop. It never automates login, passkeys, email verification,
CAPTCHA, or 2FA.

```bash
python scripts/launch_chrome_profile.py --user-data-dir ~/.kraken-guard-chrome
```

This opens a real (non-incognito) Google Chrome window using a persistent
profile at the path you gave it. Log into Kraken Prop by hand in that
window, including any 2FA/passkey step, then come back to the terminal and
press Enter. Set the same path in `.env`:

```
CHROME_USER_DATA_DIR=/Users/you/.kraken-guard-chrome
CHROME_PROFILE_DIRECTORY=Default
```

Use a profile dedicated to this tool — not your everyday browsing profile.

## Configuration

Two separate files, on purpose:

- **`config.yaml`** — strategy, asset, and behavioral configuration.
  Not secret. Safe to keep in version control (though `.gitignore` excludes
  the real file by default; only `config.example.yaml` is tracked).
- **`.env`** — secrets and machine-specific paths: your Kraken Prop account
  ID, base URL, Chrome profile path, Telegram credentials. Never commit
  this file.

### Configuring JTO and XPL

`config.yaml` already ships with JTO and XPL configured as an example:

```yaml
assets:
  JTO:
    enabled: true
    data_symbol: "JTO/USD"      # used to query Kraken public market data
    ui_symbol: "JTO"            # exact text expected in the Kraken Prop UI
    route_symbol: "jto-usd"     # for the execution engine's URL, Stage 2+
    expected_side: "LONG"
    expected_value_min_usd: 400
    expected_value_max_usd: 650
    candle_interval_minutes: 5
    fast_sma: 7
    slow_sma: 30
    strategy_mode: "CONFIRMED_BEARISH_CROSS"
    confirmation_candles: 1
    cooldown_minutes: 60

  XPL:
    enabled: true
    data_symbol: "XPL/USD"
    ui_symbol: "XPL"
    route_symbol: "xpl-usd"
    expected_side: "LONG"
    expected_value_min_usd: 400
    expected_value_max_usd: 650
    candle_interval_minutes: 5
    fast_sma: 7
    slow_sma: 30
    strategy_mode: "CONFIRMED_BEARISH_CROSS"
    confirmation_candles: 1
    cooldown_minutes: 60
```

Both `JTO/USD` and `XPL/USD` currently resolve on Kraken's public OHLC
endpoint. If you track a different asset, confirm its `data_symbol` works
against `https://api.kraken.com/0/public/OHLC?pair=<SYMBOL>USD` before
relying on it.

`ui_symbol` must be the *exact* text Kraken Prop shows for that asset in the
Positions table — this is validated character-for-character in Stage 2+,
never as a prefix/substring match.

## SMA7/SMA30 mean different things at different candle intervals

This is a common point of confusion, so it's worth stating plainly:

| Candle interval | SMA7 covers  | SMA30 covers  |
|------------------|--------------|---------------|
| 5 minutes        | 35 minutes   | 150 minutes   |
| 4 hours           | 28 hours     | 120 hours (5 days) |
| 1 day             | 7 days       | 30 days       |

A "7-period SMA" on 5-minute candles is **not** a "7-day moving average" —
it's 35 minutes of price history. Only on daily candles does SMA7 actually
correspond to a calendar week. Both `candle_interval_minutes` and
`fast_sma`/`slow_sma` are configurable per asset so you can move to 4-hour
or daily candles later without code changes.

## Registering a manually-opened position

You open positions by hand in Kraken Prop. Before the (future) executor
will ever consider closing one, you must register it here. This makes no
trade — it only tells the safety system what to expect:

```bash
kraken-guard position add \
    --symbol JTO \
    --side LONG \
    --approx-value 500 \
    --entry-price 0.61828
```

`--value-tolerance-pct` (default 15%) sets how far the position's live
value may drift from `--approx-value` before the execution engine refuses
to act on it (Stage 2+). Other commands:

```bash
kraken-guard position list
kraken-guard position disable JTO
kraken-guard position remove JTO
kraken-guard position sync-preview   # compare registered positions vs. config, no changes made
kraken-guard positions               # shortcut for `position list`
```

Registering a position with `--side SHORT` is refused outright — this tool
only ever closes LONG positions.

## Starting in dry-run

`config.yaml` defaults to `dry_run: true` and `live_execution_enabled: false`.
In this mode the signal engine runs exactly as it will in live mode, but
every detected signal is recorded with status `DRY_RUN_RECORDED` instead of
being handed to an executor (which doesn't exist yet in this stage anyway).

```bash
kraken-guard monitor
```

This runs forever, polling each enabled asset every
`market_data.poll_seconds`, evaluating the strategy every tick, and writing
a heartbeat file. Stop with Ctrl-C.

Check on it from another terminal:

```bash
kraken-guard status   # one-line summary
kraken-guard health    # full report: heartbeat age, last completed candle,
                       # armed/killed state, registered positions, pending signals
kraken-guard signals   # recent signal history
```

## Reading signals

```bash
kraken-guard signals --asset JTO --limit 10
```

Each row shows the trigger close price, SMA7/SMA30 at the trigger candle,
status, and signal ID. Statuses you'll see in Stage 1:
`DRY_RUN_RECORDED` (dry-run mode), `EXPIRED` (older than
`signal_expiry_minutes`, e.g. after the Mac slept through several ticks).
Later stages add `EXECUTION_STARTED`, `EXECUTED`, `VERIFIED`,
`BLOCKED_BY_SAFETY`, `FAILED`.

## Arming and disarming

Even once live execution exists (Stage 6+), it additionally requires a
runtime "arm":

```bash
kraken-guard arm --duration 8h
kraken-guard disarm
```

Arming creates a local, time-limited authorization record in SQLite — not a
password. It has no effect unless `app.live_execution_enabled: true` is
also set in `config.yaml`. `kraken-guard status`/`health` show whether
you're currently armed and until when.

## Emergency stop

```bash
kraken-guard kill --reason "market looks weird"
```

This immediately blocks all future execution (Stage 2+) and also disarms.
There's no automatic un-kill — nothing clears it until you decide to.

## Enabling live mode (not yet functional — future stages)

Live execution requires, in order:

1. Stages 2-5 implemented and reviewed against your real Kraken Prop
   session (selectors filled in from real DOM inspection, not guessed).
2. All tests passing (`pytest`), `ruff check .`, and `mypy src` clean.
3. `config.yaml`: `app.live_execution_enabled: true`.
4. `config.yaml`: `execution.final_confirmation_enabled: true`.
5. `kraken-guard arm --duration <n>` run for the session.

None of this is implemented yet. `kraken-guard execute-signal` currently
only prints what the pre-flight safety checks would decide and then exits
with an error — it cannot click anything.

## Staged rollout

Building browser automation against a live trading UI incrementally, per
stage, each gated on the previous one:

- **Stage 1 (this repo, now):** market data, SMA strategy, signal
  persistence/dedup, dry-run CLI, unit tests. No browser code runs.
- **Stage 2:** `scripts/inspect_kraken_page.py` navigates to your Prop
  account and confirms login/account identity — no clicking. You run it
  against your real session; the sanitized locator output is used to fill
  in `execution/selectors.py`.
- **Stage 3:** locate the exact "Close position" control within the target
  row and log/highlight it. Still no clicking.
- **Stage 4:** click "Close position" and stop before the final
  confirmation, under manual supervision.
- **Stage 5:** full dry-run simulation against mocked Kraken DOM fixtures
  (no live account needed).
- **Stage 6:** live execution, gated on everything above plus explicit
  configuration (`live_execution_enabled`, `final_confirmation_enabled`)
  and a runtime arm.

Do not skip stages, and do not enable `final_confirmation_enabled` without
having personally walked through Stages 2-5 against your own account.

## launchd (auto-start at login)

An example plist is not included yet — add one under
`~/Library/LaunchAgents/com.kraken-guard.monitor.plist` pointing at
`<venv>/bin/kraken-guard monitor` with `WorkingDirectory` set to this repo,
if/when you want the monitor to survive logout/reboot. Because this
requires a logged-in Chrome session (Stage 2+) and the Mac to be awake,
read "macOS reliability" below before relying on it unattended.

## macOS reliability

Browser automation (Stage 2+) cannot work if:

- the Mac is powered off,
- the `kraken-guard monitor` process is not running,
- your Chrome session has logged out or expired,
- the machine is asleep in a way that suspends the process,
- there is no network connectivity.

`kraken-guard monitor` writes a heartbeat file (`data/logs/heartbeat.txt`)
on every tick; `kraken-guard health` reports its age. If you need the Mac
to stay awake during an armed monitoring session, consider running
`caffeinate -s` alongside it — understand that this keeps your Mac awake
and drawing power for as long as it runs.

## Troubleshooting

- **"Config file not found"** — run `kraken-guard init` first, or check
  you're running from the directory containing `config.yaml`.
- **Notifications don't show up** — run `kraken-guard test-notification`;
  macOS may need Terminal/iTerm granted notification permissions in System
  Settings.
- **Recovery after browser logout (Stage 2+)** — the execution engine will
  detect a logged-out page and refuse to act; re-run
  `scripts/launch_chrome_profile.py` and log in again by hand.
- **Recovery after Kraken UI changes (Stage 2+)** — selectors live only in
  `execution/selectors.py`. Re-run the inspection script and update that
  one file; nothing else should need to change.
- **Signal never fires** — check `kraken-guard health` for stale data or an
  insufficient candle count (`market_data.min_candles_required`), and
  `kraken-guard position sync-preview` to confirm the asset is registered.

## Risk limitations

This tool cannot guarantee execution. It depends on: Kraken's public data
API staying available and accurately priced, Kraken Prop's web UI
remaining structurally similar to whatever selectors were last validated,
your Mac being awake and online, your Chrome session remaining logged in,
and the absence of software bugs. Safety checks (`execution/safety.py`)
default-deny on ambiguity, but a default-deny system can still miss a
real sell condition if the Mac was asleep, the network was down, or the
process had crashed. This is a risk-reduction tool, not a guarantee.

## Development

```bash
pytest
ruff check .
mypy src
```

All three must pass before considering any stage complete. Passing unit
tests does not mean live trading is safe — see "Risk limitations".
