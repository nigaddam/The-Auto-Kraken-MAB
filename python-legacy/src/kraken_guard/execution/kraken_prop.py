"""Kraken Prop page automation: navigation, account/position confirmation,
and (only in later stages, only when armed) clicking Close position.

STAGE 1 STATUS: intentionally not implemented. See README.md "Staged
rollout". This module's eventual responsibilities, in order, per stage:

  Stage 2 - navigate, confirm login + account identity, locate the
            Positions panel and the target row, screenshot. No clicking.
  Stage 3 - locate the exact "Close position" control within that row and
            log/highlight it. Still no clicking.
  Stage 4 - click "Close position" and stop before the final confirmation,
            under manual supervision.
  Stage 5 - full dry-run simulation against mocked DOM fixtures.
  Stage 6 - live execution, gated on tests passing, selectors validated,
            runtime arm, and LIVE_EXECUTION_ENABLED=true.

Every function below raises NotImplementedError until its stage lands, so
that `kraken-guard execute-signal` and `kraken-guard inspect-ui` fail loudly
in Stage 1 instead of appearing to do nothing.
"""

from __future__ import annotations

from kraken_guard.execution.safety import ScrapedPosition


class KrakenPropExecutor:
    def __init__(self, base_url: str, account_id: str):
        self.base_url = base_url
        self.account_id = account_id

    async def confirm_account(self) -> bool:
        raise NotImplementedError("Stage 2+: account identity confirmation not implemented yet.")

    async def find_position_row(self, ui_symbol: str) -> list[ScrapedPosition]:
        raise NotImplementedError("Stage 2+: position row scraping not implemented yet.")

    async def click_close_position(self, ui_symbol: str) -> None:
        raise NotImplementedError("Stage 4+: clicking Close position not implemented yet.")

    async def confirm_modal(self, ui_symbol: str) -> bool:
        raise NotImplementedError("Stage 4+: confirmation modal review not implemented yet.")

    async def verify_position_closed(self, ui_symbol: str) -> bool:
        raise NotImplementedError("Stage 4+: post-close verification not implemented yet.")
