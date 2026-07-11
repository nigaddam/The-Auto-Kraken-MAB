"""Kraken Prop DOM selectors, isolated in one module so they're easy to
update when the UI changes.

STAGE 1 STATUS: not yet populated. These are filled in during Stage 2 after
running `python scripts/inspect_kraken_page.py` against a real, logged-in
Kraken Prop session and reviewing the sanitized locator report. Do not guess
selectors from memory or documentation — Kraken's DOM must be inspected
directly, since data-testid attributes and structure are not publicly
documented and change over time.

Guidance for whoever fills these in (Stage 2+):
- Prefer Playwright role/name locators (get_by_role, get_by_text) and
  data-testid attributes over CSS classes, which are often generated and
  unstable.
- Scope every locator for a row's controls to that row's own element, not
  to the page globally — never rely on row ordering/position.
- Never use fixed pixel coordinates.
"""

from __future__ import annotations

# Populated in Stage 2 from a real inspection session. Left unset (None)
# deliberately: any code path that tries to use these before they exist
# must fail loudly rather than fall back to a guess.
ACCOUNT_ID_MARKER: str | None = None
POSITIONS_PANEL_TOGGLE: str | None = None
POSITION_ROW_CONTAINER: str | None = None
POSITION_ROW_SYMBOL: str | None = None
POSITION_ROW_SIDE: str | None = None
POSITION_ROW_VALUE: str | None = None
POSITION_ROW_CLOSE_BUTTON: str | None = None
CONFIRMATION_MODAL: str | None = None
CONFIRMATION_MODAL_CONFIRM_BUTTON: str | None = None
LOGIN_REQUIRED_MARKER: str | None = None
