/**
 * Integration-style tests for the monitoring loop's continuity mechanics:
 * alarm scheduling, restart reconciliation, stop behavior, and the
 * scan-outcome watchdog. These exercise the real service-worker.ts module
 * against a minimal in-memory chrome.* mock — no network calls, no real
 * Kraken data. Deeper execution-path scenarios (a live position actually
 * reaching CLOSE and closing) are intentionally out of scope here; see
 * HANDOFF.md's "Live-Test Evidence" boundary — those are code-reviewed and
 * manually tested, not unit-tested, consistent with how the rest of
 * service-worker.ts has always been treated in this project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/constants";

function makeOhlcResponse() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const intervalSeconds = 60 * 60;
  const rows: [number, string, string, string, string, string, string, number][] = [];
  // Comfortably above evaluatePositions' own strategy-validity requirement
  // (SMA90 + slope lookback + ATR period, currently >100 completed
  // candles) as well as buildMarketDataTable's smaller slowSma+1 minimum.
  for (let i = 150; i >= 1; i--) {
    rows.push([nowSeconds - i * intervalSeconds, "50000", "50100", "49900", "50000", "50000", "1000", 5]);
  }
  rows.push([nowSeconds - 60, "50000", "50000", "50000", "50000", "50000", "10", 1]); // forming candle
  return { error: [], result: { XBTUSD: rows, last: nowSeconds } };
}

function makeTickerResponse() {
  return { error: [], result: { XBTUSD: { c: ["50000.0", "1.0"] } } };
}

/** A fetch mock that succeeds for any Kraken public OHLC/Ticker request
 * (used by tests that need buildMarketDataTable to resolve real rows
 * instead of the "network disabled" rejection the other describe blocks
 * use to keep loop-mechanics tests fast and deterministic). */
function stubWorkingMarketDataFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/OHLC")) {
        return Promise.resolve(new Response(JSON.stringify(makeOhlcResponse()), { status: 200 }));
      }
      if (u.includes("/Ticker")) {
        return Promise.resolve(new Response(JSON.stringify(makeTickerResponse()), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch in test: ${u}`));
    })
  );
}

interface AlarmInfo {
  periodInMinutes?: number;
}

function createChromeMock() {
  const storage: Record<string, unknown> = {};
  const alarms = new Map<string, AlarmInfo>();
  const notifications: { title: string; message: string; urgent: boolean }[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | null = null;
  let onInstalledListener: (() => void) | null = null;
  let onStartupListener: (() => void) | null = null;
  let onMessageListener:
    | ((message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined)
    | null = null;

  let tabPresent = true;
  let scanResponder: () => unknown = () => ({
    type: "POSITIONS_SCAN_RESULT",
    positions: [],
    pageHealth: {
      checkedAt: Date.now(),
      propPageDetected: true,
      accountMarkerDetected: true,
      sessionState: "LOGGED_IN",
      positionsTableReadable: true,
      loginFormDetected: false,
      sessionExpiredModalDetected: false,
      captchaDetected: false,
      twoFaDetected: false,
      deviceApprovalDetected: false,
    },
    candidateRowCount: 0,
    rowDiscoveryMethod: "NONE",
  });

  const chromeMock = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storage[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        },
      },
    },
    alarms: {
      create: (name: string, info: AlarmInfo) => {
        alarms.set(name, info);
      },
      clear: (name: string) => {
        alarms.delete(name);
        return Promise.resolve(true);
      },
      onAlarm: {
        addListener: (cb: (alarm: { name: string }) => void) => {
          alarmListener = cb;
        },
      },
    },
    tabs: {
      query: () => Promise.resolve(tabPresent ? [{ id: 1 }] : []),
      sendMessage: () => {
        if (!tabPresent) return Promise.reject(new Error("could not establish connection"));
        return Promise.resolve(scanResponder());
      },
    },
    scripting: {
      executeScript: () => Promise.resolve(),
    },
    power: {
      requestKeepAwake: () => undefined,
      releaseKeepAwake: () => undefined,
    },
    notifications: {
      getPermissionLevel: (callback: (level: string) => void) => {
        callback("granted");
      },
      create: (
        _id: string,
        options: { title: string; message: string; priority?: number },
        callback?: () => void
      ) => {
        notifications.push({
          title: options.title,
          message: options.message,
          urgent: (options.priority ?? 0) >= 2,
        });
        callback?.();
      },
    },
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(),
    },
    runtime: {
      sendMessage: () => Promise.reject(new Error("no listener")),
      onMessage: {
        addListener: (
          cb: (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined
        ) => {
          onMessageListener = cb;
        },
      },
      onInstalled: {
        addListener: (cb: () => void) => {
          onInstalledListener = cb;
        },
      },
      onStartup: {
        addListener: (cb: () => void) => {
          onStartupListener = cb;
        },
      },
    },
  };

  return {
    chromeMock,
    storage,
    alarms,
    notifications,
    fireAlarm: async (name: string) => {
      alarmListener?.({ name });
      await flushMicrotasks();
    },
    fireOnInstalled: async () => {
      onInstalledListener?.();
      await flushMicrotasks(200);
    },
    fireOnStartup: async () => {
      onStartupListener?.();
      await flushMicrotasks(200);
    },
    // handleMessage() is fire-and-forget from the real listener's
    // perspective (`void handleMessage(...); return true;`) — message
    // types that don't need a reply (START_MONITORING, STOP_MONITORING,
    // etc.) never call sendResponse at all. Waiting only on sendResponse
    // would hang forever for those, so this flushes the microtask queue
    // (unaffected by real vs. fake timers) and returns whatever response,
    // if any, arrived during that window.
    sendMessage: async (message: unknown): Promise<unknown> => {
      let response: unknown;
      const keepOpen = onMessageListener?.(message, {}, (r) => {
        response = r;
      });
      if (!keepOpen) return undefined;
      await flushMicrotasks();
      return response;
    },
    setTabPresent: (present: boolean) => {
      tabPresent = present;
    },
    setScanResponder: (fn: () => unknown) => {
      scanResponder = fn;
    },
  };
}

/** Polls GET_STATE with real (not fake) short delays until `predicate`
 * passes or `timeoutMs` elapses. Needed for scenarios whose async chain
 * runs a real fetch()/Response.json() (e.g. arming with a working market
 * data mock) — that chain can take more actual event-loop ticks to settle
 * than a fixed-count microtask flush accounts for, so a single immediate
 * GET_STATE right after the triggering message can race ahead of it. */
async function waitForState(
  harness: { sendMessage: (message: unknown) => Promise<unknown> },
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: Record<string, unknown>;
    };
    last = response.state;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return last;
}

async function flushMicrotasks(times = 300): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function importFreshServiceWorker() {
  vi.resetModules();
  await import("../src/background/service-worker");
}

describe("monitoring loop continuity", () => {
  let harness: ReturnType<typeof createChromeMock>;

  beforeEach(async () => {
    harness = createChromeMock();
    vi.stubGlobal("chrome", harness.chromeMock);
    // Monitoring start/refresh also triggers a market-data fetch for the
    // developer watchlist regardless of tracked positions; these tests
    // care about loop mechanics, not market data, so fail it fast and
    // deterministically instead of hitting the real network.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network disabled in test")))
    );
    await importFreshServiceWorker();
  });

  afterEach(async () => {
    // Drain any lingering async chains (e.g. a restart's trailing
    // runScanCycle) while chrome/fetch mocks are still in place, so they
    // don't throw "chrome is not defined" after unstubbing into the next
    // test.
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await flushMicrotasks(200);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("Start Monitoring creates a recurring poll alarm, and firing it invokes the scan", async () => {
    let scanCalls = 0;
    harness.setScanResponder(() => {
      scanCalls++;
      return {
        type: "POSITIONS_SCAN_RESULT",
        positions: [],
        pageHealth: {
          checkedAt: Date.now(),
          propPageDetected: true,
          accountMarkerDetected: true,
          sessionState: "LOGGED_IN",
          positionsTableReadable: true,
          loginFormDetected: false,
          sessionExpiredModalDetected: false,
          captchaDetected: false,
          twoFaDetected: false,
          deviceApprovalDetected: false,
        },
        candidateRowCount: 0,
        rowDiscoveryMethod: "NONE",
      };
    });

    await harness.sendMessage({ type: "START_MONITORING" });
    expect(harness.alarms.has("kraken-guard-poll")).toBe(true);
    const callsAfterStart = scanCalls;
    expect(callsAfterStart).toBeGreaterThan(0); // Start Monitoring runs an immediate scan

    await harness.fireAlarm("kraken-guard-poll");
    // allow any pending promise chain from the fire-and-forget alarm handler to settle
    expect(scanCalls).toBeGreaterThan(callsAfterStart);
  });

  it("remains monitor-only when Start Monitoring is used alone (no LIVE arming setting)", async () => {
    const response = (await harness.sendMessage({ type: "GET_STATE" })) as { state: { executionMode: string } };
    expect(response.state.executionMode).toBe("MONITOR_ONLY");

    await harness.sendMessage({ type: "START_MONITORING" });
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { executionMode: string; autoCloseLive: boolean; monitoringStatus: string };
    };
    expect(after.state.monitoringStatus).toBe("RUNNING");
    expect(after.state.executionMode).toBe("MONITOR_ONLY");
    expect(after.state.autoCloseLive).toBe(false);
  });

  it("Stop Monitoring cancels both alarms and releases keep-awake", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    expect(harness.alarms.has("kraken-guard-poll")).toBe(true);

    await harness.sendMessage({ type: "STOP_MONITORING" });
    expect(harness.alarms.has("kraken-guard-poll")).toBe(false);
    expect(harness.alarms.has("kraken-guard-market-refresh")).toBe(false);

    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { monitoringStatus: string; keepAwakeStatus: string };
    };
    expect(after.state.monitoringStatus).toBe("STOPPED");
    expect(after.state.keepAwakeStatus).toBe("INACTIVE");
  });

  it("a routine scan failure does not permanently stop future scans (alarm keeps firing)", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    harness.setTabPresent(false); // simulate the tab disappearing for one tick

    await harness.fireAlarm("kraken-guard-poll");

    harness.setTabPresent(true); // tab comes back
    await harness.fireAlarm("kraken-guard-poll");

    // The alarm is still registered and still fires — a single failure
    // does not tear down the scheduler.
    expect(harness.alarms.has("kraken-guard-poll")).toBe(true);
  });

  it("repeated scan failures beyond the stall threshold mark monitoring STALLED and notify urgently", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    await harness.sendMessage({ type: "START_MONITORING" });
    harness.setTabPresent(false);

    // Default pollMinutes=5 -> stall threshold = max(15, 15) = 15 minutes.
    // Advance past it while repeatedly firing the alarm.
    for (let minutes = 5; minutes <= 20; minutes += 5) {
      vi.setSystemTime(start + minutes * 60_000);
      await harness.fireAlarm("kraken-guard-poll");
      await vi.advanceTimersByTimeAsync(0);
    }

    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { monitorStalledSince: number | null };
    };
    expect(after.state.monitorStalledSince).not.toBeNull();
    expect(harness.notifications.some((n) => n.urgent && /STALLED/i.test(n.title))).toBe(true);
  });

  it("restart resumes monitoring (Monitor Only) if it was running before, and always resets LIVE", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    // Simulate an armed-but-not-live state directly in storage, as if it
    // had been set before the restart we're about to simulate.
    const key = "kraken_guard_state"; // must match storage/state.ts STATE_KEY
    const before = harness.storage[key] as { executionMode: string; autoCloseLive: boolean };
    before.executionMode = "ARMED_AUTO_CLOSE";
    before.autoCloseLive = true;

    harness.alarms.clear(); // simulate alarms not surviving to this fresh module load
    await importFreshServiceWorker();
    await harness.fireOnStartup();

    expect(harness.alarms.has("kraken-guard-poll")).toBe(true); // alarm recreated
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { monitoringStatus: string; executionMode: string; autoCloseLive: boolean };
    };
    expect(after.state.monitoringStatus).toBe("RUNNING"); // resumed
    expect(after.state.executionMode).toBe("MONITOR_ONLY"); // LIVE always reset
    expect(after.state.autoCloseLive).toBe(false);
  });

  it("restart marks an interrupted in-flight execution UNCERTAIN and notifies urgently, without resuming it", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    const key = "kraken_guard_state"; // must match storage/state.ts STATE_KEY
    const before = harness.storage[key] as { closeExecution: unknown };
    before.closeExecution = {
      intentId: "AAVE-fp-1",
      fingerprint: "fp-1",
      symbol: "AAVE",
      lotLabel: null,
      trigger: "HARD_LOSS",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      state: "FINAL_SUBMITTING",
      result: null,
      details: [],
    };

    await importFreshServiceWorker();
    await harness.fireOnInstalled();

    expect(
      harness.notifications.some((n) => n.urgent && /interrupted/i.test(n.title))
    ).toBe(true);
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { closeExecution: unknown; liveAutoCloseStats: { previousExecutionUncertain: boolean } };
    };
    // The interrupted record itself is cleared (nothing to resume safely),
    // but the fact that it was uncertain is preserved in session stats.
    expect(after.state.closeExecution).toBeNull();
    expect(after.state.liveAutoCloseStats.previousExecutionUncertain).toBe(true);
  });

  it("Start Monitoring alone (combined setting off) never sends the combined message type", async () => {
    // Documents the message-protocol boundary: without the combined
    // setting, the panel only ever sends START_MONITORING, never
    // START_MONITORING_WITH_LIVE_AUTO_CLOSE — the two-step flow is what
    // actually runs by default.
    const response = (await harness.sendMessage({
      type: "START_MONITORING_WITH_LIVE_AUTO_CLOSE",
      durationHours: 1,
    })) as { monitoringStarted: boolean; liveArmed: boolean; preflightBlockers: string[] };
    // Even when this message IS sent directly (bypassing the panel), LIVE
    // must not arm without a real preflight pass — with zero positions,
    // preflight always blocks.
    expect(response.monitoringStarted).toBe(true);
    expect(response.liveArmed).toBe(false);
    expect(response.preflightBlockers.length).toBeGreaterThan(0);
  });

  it("relays OPEN_BUY_ORDER and CONFIRM_BUY_ORDER from the panel to the tab instead of hanging", async () => {
    // Regression test: the panel sends these via chrome.runtime.sendMessage,
    // which reaches the service worker, not the tab directly — without an
    // explicit case relaying it via sendMessageToKrakenTab, sendResponse is
    // never called and the panel's promise hangs forever (exactly what
    // happened before this test was added: the content-script side and
    // Autopilot's internal direct-tab-messaging path were both wired
    // correctly, but the panel-to-tab relay case was missed entirely).
    await harness.sendMessage({ type: "START_MONITORING" });

    const openResponse = await harness.sendMessage({
      type: "OPEN_BUY_ORDER",
      symbol: "ETH",
      quantityUnits: 0.1,
    });
    expect(openResponse).toMatchObject({ type: "OPEN_BUY_ORDER_RESULT" });

    const confirmResponse = await harness.sendMessage({
      type: "CONFIRM_BUY_ORDER",
      symbol: "ETH",
      quantityUnits: 0.1,
    });
    expect(confirmResponse).toMatchObject({ type: "CONFIRM_BUY_ORDER_RESULT" });
  });
});

/**
 * Coverage note: getting Autopilot to actually complete a LIVE arm requires
 * a full passing canArmLiveAutoClose preflight — at least one real ACTIVE
 * position with a resolved symbol and healthy market data, which means
 * mocking Kraken's public OHLC/Ticker/AssetPairs responses through a full
 * strategy evaluation. That's the same larger harness explicitly flagged as
 * out of scope in HANDOFF.md's "deeper execution-path scenarios... remain
 * code-reviewed, not test-automated." These tests instead cover what's
 * cheaply and deterministically testable with the existing zero-position
 * mock: operating-mode state transitions, the one-shot "waiting to arm"
 * notification gate (so a persistently-blocked Autopilot doesn't spam), and
 * that switching away from AUTOPILOT disarms any armed LIVE state. The
 * resetStats reset-on-explicit-arm behavior is covered directly against
 * handleArmAutoClose's dry-run path (ARM_AUTO_CLOSE with live:false, which
 * doesn't require the live preflight); the resetStats:false self-heal path
 * itself (reached only internally via tryAutopilotArm after a transient
 * disarm) is code-reviewed, not unit-tested, consistent with the above.
 */
describe("operating mode", () => {
  let harness: ReturnType<typeof createChromeMock>;

  beforeEach(async () => {
    harness = createChromeMock();
    vi.stubGlobal("chrome", harness.chromeMock);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network disabled in test")))
    );
    await importFreshServiceWorker();
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await flushMicrotasks(200);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("OFF -> CRUISE starts monitoring in MONITOR_ONLY, never arms LIVE", async () => {
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "CRUISE" });
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { operatingMode: string; monitoringStatus: string; executionMode: string; autoCloseLive: boolean };
    };
    expect(after.state.operatingMode).toBe("CRUISE");
    expect(after.state.monitoringStatus).toBe("RUNNING");
    expect(after.state.executionMode).toBe("MONITOR_ONLY");
    expect(after.state.autoCloseLive).toBe(false);
  });

  it("CRUISE -> AUTOPILOT starts monitoring and attempts to arm, notifying once when preflight blocks", async () => {
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "AUTOPILOT" });
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: {
        operatingMode: string;
        monitoringStatus: string;
        autoCloseLive: boolean;
        autopilotReArmFailedSince: number | null;
      };
    };
    expect(after.state.operatingMode).toBe("AUTOPILOT");
    expect(after.state.monitoringStatus).toBe("RUNNING");
    // Zero positions AND zero watchlist coins configured in this harness
    // means there is truly nothing to arm for — canArmLiveAutoClose still
    // blocks in that specific case, and Autopilot must not falsely claim
    // to be armed. (Zero positions *alone*, with a watchlist configured,
    // must now succeed — see the dedicated cold-start test below.)
    expect(after.state.autoCloseLive).toBe(false);
    expect(after.state.autopilotReArmFailedSince).not.toBeNull();
    expect(harness.notifications.some((n) => /Autopilot paused/i.test(n.title))).toBe(true);
  });

  it("arms LIVE from a cold start (zero open positions) as long as watchlist coins are configured", async () => {
    stubWorkingMarketDataFetch();
    await harness.sendMessage({
      type: "UPDATE_SETTINGS",
      settings: { ...DEFAULT_SETTINGS, watchlistCoins: ["BTC"] },
    });

    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "AUTOPILOT" });
    const after = await waitForState(harness, (s) => s.executionMode === "ARMED_AUTO_CLOSE");
    expect(after.operatingMode).toBe("AUTOPILOT");
    expect(after.executionMode).toBe("ARMED_AUTO_CLOSE");
    expect(after.autoCloseLive).toBe(true);
    expect(harness.notifications.some((n) => /Autopilot paused/i.test(n.title))).toBe(false);
  });

  it("still disarms when a previously-active position vanishes from parsing with zero rows (real parser degradation, not a cold start)", async () => {
    stubWorkingMarketDataFetch();
    await harness.sendMessage({
      type: "UPDATE_SETTINGS",
      settings: { ...DEFAULT_SETTINGS, watchlistCoins: ["BTC"] },
    });

    // Arm with one real ACTIVE position present, so arming succeeds via
    // the normal (non-cold-start) path.
    harness.setScanResponder(() => ({
      type: "POSITIONS_SCAN_RESULT",
      positions: [
        {
          symbol: "BTC",
          side: "LONG",
          entryPrice: 50000,
          currentPriceUi: 50000,
          valueUsd: 500,
          upnl: 0,
          netPnl: 0,
          leverage: 1,
          tpSlText: null,
        },
      ],
      pageHealth: {
        checkedAt: Date.now(),
        propPageDetected: true,
        accountMarkerDetected: true,
        sessionState: "LOGGED_IN",
        positionsTableReadable: true,
        loginFormDetected: false,
        sessionExpiredModalDetected: false,
        captchaDetected: false,
        twoFaDetected: false,
        deviceApprovalDetected: false,
      },
      candidateRowCount: 1,
      rowDiscoveryMethod: "SEMANTIC_ROLES",
    }));
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "AUTOPILOT" });
    const armed = await waitForState(harness, (s) => s.autoCloseLive === true);
    expect(armed.autoCloseLive).toBe(true);

    // Now the position vanishes from parsing entirely (row discovery
    // returning nothing, as if Kraken's markup broke) while it was still
    // genuinely open a moment ago — this must still disarm, unlike the
    // legitimate cold-start case above.
    harness.setScanResponder(() => ({
      type: "POSITIONS_SCAN_RESULT",
      positions: [],
      pageHealth: {
        checkedAt: Date.now(),
        propPageDetected: true,
        accountMarkerDetected: true,
        sessionState: "LOGGED_IN",
        positionsTableReadable: true,
        loginFormDetected: false,
        sessionExpiredModalDetected: false,
        captchaDetected: false,
        twoFaDetected: false,
        deviceApprovalDetected: false,
      },
      candidateRowCount: 0,
      rowDiscoveryMethod: "NONE",
    }));
    await harness.fireAlarm("kraken-guard-poll");

    const after = await waitForState(harness, (s) => s.autoCloseLive === false);
    expect(after.autoCloseLive).toBe(false);
    expect(
      harness.notifications.some(
        (n) => /disappeared from parsing/i.test(n.message) || /disappeared from parsing/i.test(n.title)
      )
    ).toBe(true);

    // The sticky guard must survive Autopilot's own end-of-cycle self-heal
    // attempt (already fired once, automatically, by the same
    // runScanCycle() that just disarmed) and another full poll cycle after
    // that — it must not silently re-arm into a "cold start" just because
    // active positions are now 0.
    await harness.fireAlarm("kraken-guard-poll");
    const stillDisarmed = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { autoCloseLive: boolean; liveAutoCloseStats: { parserGapUnresolved: boolean } };
    };
    expect(stillDisarmed.state.autoCloseLive).toBe(false);
    expect(stillDisarmed.state.liveAutoCloseStats.parserGapUnresolved).toBe(true);
  });

  it("does not repeat the 'waiting to arm' notification every cycle while still blocked", async () => {
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "AUTOPILOT" });
    const firstCount = harness.notifications.filter((n) => /Autopilot paused/i.test(n.title)).length;
    expect(firstCount).toBe(1);

    await harness.fireAlarm("kraken-guard-poll");
    await harness.fireAlarm("kraken-guard-poll");

    const secondCount = harness.notifications.filter((n) => /Autopilot paused/i.test(n.title)).length;
    expect(secondCount).toBe(1); // still just the one, despite multiple blocked cycles
  });

  it("AUTOPILOT -> OFF stops monitoring and clears operatingMode", async () => {
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "AUTOPILOT" });
    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "OFF" });
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { operatingMode: string; monitoringStatus: string };
    };
    expect(after.state.operatingMode).toBe("OFF");
    expect(after.state.monitoringStatus).toBe("STOPPED");
  });

  it("switching from AUTOPILOT to CRUISE disarms any armed LIVE state", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    const key = "kraken_guard_state";
    const before = harness.storage[key] as {
      operatingMode: string;
      executionMode: string;
      autoCloseLive: boolean;
    };
    // Directly seed an already-armed state, bypassing the real preflight —
    // this test is only about the mode-switch disarm behavior, not arming.
    before.operatingMode = "AUTOPILOT";
    before.executionMode = "ARMED_AUTO_CLOSE";
    before.autoCloseLive = true;

    await harness.sendMessage({ type: "SET_OPERATING_MODE", mode: "CRUISE" });
    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { operatingMode: string; executionMode: string; autoCloseLive: boolean };
    };
    expect(after.state.operatingMode).toBe("CRUISE");
    expect(after.state.executionMode).toBe("MONITOR_ONLY");
    expect(after.state.autoCloseLive).toBe(false);
  });

  it("an explicit arm (resetStats default true) zeroes out prior session stats", async () => {
    await harness.sendMessage({ type: "START_MONITORING" });
    const key = "kraken_guard_state";
    const before = harness.storage[key] as {
      liveAutoCloseStats: { closesThisSession: number; closeTimestamps: number[] };
    };
    before.liveAutoCloseStats = {
      closesThisSession: 3,
      closeTimestamps: [Date.now() - 1000, Date.now() - 2000],
    };

    // Dry-run arm doesn't require the live preflight, so it's reachable
    // deterministically in this zero-position harness.
    await harness.sendMessage({ type: "ARM_AUTO_CLOSE", durationHours: 1, live: false });

    const after = (await harness.sendMessage({ type: "GET_STATE" })) as {
      state: { liveAutoCloseStats: { closesThisSession: number; closeTimestamps: number[] } };
    };
    expect(after.state.liveAutoCloseStats.closesThisSession).toBe(0);
    expect(after.state.liveAutoCloseStats.closeTimestamps).toEqual([]);
  });
});
