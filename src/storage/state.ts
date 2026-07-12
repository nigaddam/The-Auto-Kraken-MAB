import type { RuntimeState } from "../shared/types";
import { freshRuntimeState, migrateState } from "./migrations";

const STATE_KEY = "kraken_guard_state";

/** Note: this module does not decide when auto-close should reset to
 * disarmed on restart — that's a lifecycle decision made in
 * background/service-worker.ts (chrome.runtime.onStartup/onInstalled),
 * because a plain storage read/write can't distinguish "browser restarted"
 * from "service worker suspended and woke back up". */
export async function getState(): Promise<RuntimeState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const raw: unknown = stored[STATE_KEY];
  if (raw === undefined) {
    const initial = freshRuntimeState();
    await setState(initial);
    return initial;
  }
  return migrateState(raw);
}

export async function setState(state: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export async function updateState(
  updater: (current: RuntimeState) => RuntimeState
): Promise<RuntimeState> {
  const current = await getState();
  const next = updater(current);
  await setState(next);
  return next;
}
