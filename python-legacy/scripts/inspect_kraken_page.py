#!/usr/bin/env python3
"""Stage 2 placeholder: safely open the configured Kraken Prop page for
inspection. Does NOT click anything and does NOT yet dump candidate
locators for the Positions table — that is the next concrete step, to be
built together against your real, logged-in session (see README.md "Staged
rollout", Stage 2).

Currently this script only:
  - launches the same persistent Chrome profile as launch_chrome_profile.py,
  - navigates to the configured Prop account URL,
  - prints the page title and URL so you can confirm navigation worked.

It deliberately stops there so nothing about Kraken's real DOM is guessed.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-data-dir", default=os.environ.get("CHROME_USER_DATA_DIR", ""))
    parser.add_argument(
        "--profile-directory", default=os.environ.get("CHROME_PROFILE_DIRECTORY", "Default")
    )
    parser.add_argument("--account-id", default=os.environ.get("KRAKEN_PROP_ACCOUNT_ID", ""))
    parser.add_argument(
        "--base-url", default=os.environ.get("KRAKEN_PROP_BASE_URL") or "https://pro.kraken.com/prop"
    )
    args = parser.parse_args()

    if not args.user_data_dir:
        raise SystemExit("Set CHROME_USER_DATA_DIR (see .env.example) or pass --user-data-dir.")

    url = args.base_url
    if args.account_id:
        url = f"{args.base_url.rstrip('/')}/account/{args.account_id}"

    user_data_dir = Path(args.user_data_dir).expanduser()

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(user_data_dir),
            channel="chrome",
            headless=False,
            args=[f"--profile-directory={args.profile_directory}"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(url)
        page.wait_for_load_state("networkidle")

        print(f"Navigated to: {page.url}")
        print(f"Page title:   {page.title()}")
        print()
        print(
            "Next step (Stage 2, not yet built): print candidate locators for the "
            "account identifier and the Positions table rows, without clicking, so "
            "selectors.py can be filled in from real observed structure."
        )
        input("Press Enter to close this window.")
        context.close()


if __name__ == "__main__":
    main()
