"""Persistent Chrome profile management via Playwright.

STAGE 1 STATUS: intentionally not implemented. This module exists so the
project structure is in place; real browser automation begins at Stage 2
(inspection only, no clicking) per the staged rollout. Calling anything here
in Stage 1 raises NotImplementedError rather than silently doing nothing.

When implemented (Stage 2+), this must:
- launch Playwright's persistent context against CHROME_USER_DATA_DIR /
  CHROME_PROFILE_DIRECTORY (never an incognito/ephemeral context),
- never automate login, passkeys, email verification, CAPTCHA, or 2FA,
- detect and report a logged-out state instead of trying to work around it.
"""

from __future__ import annotations


class PersistentBrowser:
    def __init__(self, user_data_dir: str, profile_directory: str, headless: bool = False):
        if not user_data_dir:
            raise NotImplementedError(
                "Browser automation is not implemented yet (Stage 2+). "
                "CHROME_USER_DATA_DIR must also be configured before this can run."
            )
        self.user_data_dir = user_data_dir
        self.profile_directory = profile_directory
        self.headless = headless

    async def launch(self) -> None:
        raise NotImplementedError(
            "Stage 1 does not implement browser automation. See scripts/launch_chrome_profile.py "
            "for safely opening the dedicated profile, and README.md for the staged rollout."
        )

    async def close(self) -> None:
        raise NotImplementedError
