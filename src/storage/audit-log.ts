import { MAX_AUDIT_LOG_ENTRIES } from "../shared/constants";
import type { AuditLogEntry } from "../shared/types";

const AUDIT_LOG_KEY = "kraken_guard_audit_log";

// AuditLogEntry's fields are exhaustively enumerated in shared/types.ts and
// deliberately exclude any credential/session/token field, so anything that
// conforms to the type is already safe to export as-is.

export async function appendAuditEntry(entry: AuditLogEntry): Promise<void> {
  const log = await getAuditLog();
  log.push(entry);
  const trimmed = log.length > MAX_AUDIT_LOG_ENTRIES ? log.slice(log.length - MAX_AUDIT_LOG_ENTRIES) : log;
  await chrome.storage.local.set({ [AUDIT_LOG_KEY]: trimmed });
}

export async function getAuditLog(limit?: number): Promise<AuditLogEntry[]> {
  const stored = await chrome.storage.local.get(AUDIT_LOG_KEY);
  const log = (stored[AUDIT_LOG_KEY] as AuditLogEntry[] | undefined) ?? [];
  if (limit === undefined) {
    return log;
  }
  return log.slice(Math.max(0, log.length - limit));
}

export async function clearAuditLog(): Promise<void> {
  await chrome.storage.local.set({ [AUDIT_LOG_KEY]: [] });
}

export async function exportAuditLogAsJson(): Promise<string> {
  const log = await getAuditLog();
  return JSON.stringify(log, null, 2);
}
