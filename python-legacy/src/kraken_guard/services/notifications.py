"""macOS (osascript) notifications, with optional Telegram support.

Telegram credentials come only from environment variables (see
config.EnvSecrets) and are never logged. Telegram is only used when
notifications.telegram is true in config.yaml AND both the bot token and
chat id are present.
"""

from __future__ import annotations

import logging
import subprocess

import httpx

from kraken_guard.config import EnvSecrets, NotificationsConfig

logger = logging.getLogger(__name__)


def _applescript_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


class Notifier:
    def __init__(
        self,
        config: NotificationsConfig,
        env_secrets: EnvSecrets | None = None,
        http_client: httpx.Client | None = None,
    ):
        self.config = config
        self.env_secrets = env_secrets or EnvSecrets()
        self._http_client = http_client

    def notify(self, title: str, message: str, urgent: bool = False) -> None:
        if self.config.macos:
            self._notify_macos(title, message)
        if self.config.telegram:
            self._notify_telegram(title, message, urgent)

    def _notify_macos(self, title: str, message: str) -> None:
        safe_title = _applescript_escape(title)
        safe_message = _applescript_escape(message)
        script = f'display notification "{safe_message}" with title "{safe_title}"'
        try:
            subprocess.run(["osascript", "-e", script], check=True, capture_output=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            logger.warning("macos_notification_failed", extra={"error": str(exc)})

    def _notify_telegram(self, title: str, message: str, urgent: bool) -> None:
        token = self.env_secrets.telegram_bot_token
        chat_id = self.env_secrets.telegram_chat_id
        if not token or not chat_id:
            logger.warning(
                "telegram_notifications_enabled_but_not_configured",
                extra={"has_token": bool(token), "has_chat_id": bool(chat_id)},
            )
            return
        text = f"{'🚨 ' if urgent else ''}{title}\n{message}"
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        try:
            client = self._http_client or httpx.Client(timeout=10.0)
            client.post(url, json={"chat_id": chat_id, "text": text})
        except httpx.HTTPError as exc:
            logger.warning("telegram_notification_failed", extra={"error": str(exc)})
