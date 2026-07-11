export function requestSystemKeepAwake(): { ok: true } | { ok: false; error: string } {
  try {
    chrome.power.requestKeepAwake("system");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function releaseSystemKeepAwake(): { ok: true } | { ok: false; error: string } {
  try {
    chrome.power.releaseKeepAwake();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
