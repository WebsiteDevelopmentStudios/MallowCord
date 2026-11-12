"""Authenticated sender for MallowCord's Rust internal event API.

Keep the shared secret in the Mallow-Bot server environment. Never import this
module from browser-facing code or expose the secret to a Discord user.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from typing import Any

import aiohttp


class MallowCordRustEvents:
    def __init__(self) -> None:
        self.base_url = os.getenv("MALLOWCORD_RUST_API_URL", "").rstrip("/")
        self.secret = os.getenv("MALLOWCORD_INTERNAL_EVENT_SECRET", "")

    async def send_event(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        event_id: str,
        source: str = "mallowbot",
    ) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("MALLOWCORD_RUST_API_URL must be configured.")
        if len(self.secret.encode("utf-8")) < 32:
            raise RuntimeError("MALLOWCORD_INTERNAL_EVENT_SECRET must contain at least 32 bytes.")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", event_id):
            raise ValueError("event_id must be 1-128 ASCII letters, digits, dots, underscores, or hyphens.")

        body = json.dumps(
            {"source": source, "event_type": event_type, "payload": payload},
            separators=(",", ":"),
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
        timestamp = str(int(time.time()))
        signed = timestamp.encode("ascii") + b"." + event_id.encode("ascii") + b"." + body
        signature = hmac.new(self.secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        headers = {
            "Content-Type": "application/json",
            "X-MallowCord-Timestamp": timestamp,
            "X-MallowCord-Event-Id": event_id,
            "X-MallowCord-Signature": f"sha256={signature}",
        }

        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.base_url}/internal/v1/events",
                data=body,
                headers=headers,
            ) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    raise RuntimeError(data.get("error", "MallowCord Rust event request failed."))
                return data
