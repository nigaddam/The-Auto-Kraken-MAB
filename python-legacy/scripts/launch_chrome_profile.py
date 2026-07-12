#!/usr/bin/env python3
"""Open a dedicated, persistent Google Chrome profile for kraken-guard.

This script does nothing Kraken-specific: it just launches Chrome (the real
installed browser, not Chromium) against a persistent user-data-dir so you
can log into Kraken Prop manually, once, and stay logged in across runs.
It never touches login fields, 2FA, passkeys, or CAPTCHA — you do that by
hand in the window it opens.

Usage:
    python scripts/launch_chrome_profile.py --user-data-dir ~/.kraken-guard-chrome

Then set CHROME_USER_DATA_DIR (and optionally CHROME_PROFILE_DIRECTORY) in
your .env to the same path so the rest of kraken-guard can reuse it.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user-data-dir",
        default=os.environ.get("CHROME_USER_DATA_DIR", ""),
        help="Directory for the dedicated persistent Chrome profile.",
    )
    parser.add_argument(
        "--profile-directory",
        default=os.environ.get("CHROME_PROFILE_DIRECTORY", "Default"),
        help="Chrome profile subdirectory name (e.g. 'Default' or 'Profile 1').",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("KRAKEN_PROP_BASE_URL") or "https://pro.kraken.com/prop",
        help="URL to open once Chrome launches.",
    )
    args = parser.parse_args()

    if not args.user_data_dir:
        raise SystemExit(
            "Provide --user-data-dir or set CHROME_USER_DATA_DIR in your .env. "
            "Use a path dedicated to this tool, not your everyday Chrome profile."
        )

    user_data_dir = Path(args.user_data_dir).expanduser()
    user_data_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(user_data_dir),
            channel="chrome",
            headless=False,
            args=[f"--profile-directory={args.profile_directory}"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(args.url)

        print(f"Chrome launched with persistent profile at: {user_data_dir}")
        print("Log in manually now (including any 2FA / passkey / email verification).")
        print("This script will not read, fill, or click anything on the page.")
        print("Press Enter here when done. The browser window will stay open.")
        input()


if __name__ == "__main__":
    main()
