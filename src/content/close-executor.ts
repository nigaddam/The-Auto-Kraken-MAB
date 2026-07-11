/**
 * LEGACY STUB. The guarded live/manual close path is implemented in
 * close-preview.ts and mediated by the service worker. These old exports
 * remain disabled so stale callers cannot bypass modal validation or the
 * execution gates.
 */

export function highlightPositionRow(_uiSymbol: string): never {
  throw new Error(
    "highlightPositionRow is a disabled legacy stub. Use the guarded close-preview/service-worker flow."
  );
}

export function clickClosePosition(_uiSymbol: string): never {
  throw new Error(
    "clickClosePosition is a disabled legacy stub. Use the guarded close-preview/service-worker flow."
  );
}

export function confirmCloseModal(_uiSymbol: string): never {
  throw new Error(
    "confirmCloseModal is a disabled legacy stub. Use the guarded close-preview/service-worker flow."
  );
}
