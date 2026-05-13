import os
import time
from typing import Dict, List, Optional

from fastapi import Request


def parse_bool_env(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def is_production_env(env_value: str) -> bool:
    env = (env_value or "").strip().lower()
    return env in {"prod", "production", "live"}


def enforce_non_default_auth_secret(auth_secret: str) -> None:
    secret = (auth_secret or "").strip()
    if not secret or secret == "dev-secret":
        raise RuntimeError("AUTH_SECRET wajib non-default pada environment production.")


def client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for", "") or "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return str(request.client.host)
    return "-"


def login_rate_key(request: Request, username: str) -> str:
    return f"{(username or '').strip().lower()}|{client_ip(request)}"


class LoginRateLimiter:
    def __init__(self, max_attempts: int = 5, window_seconds: int = 300, cooldown_seconds: int = 300):
        self.max_attempts = max(1, int(max_attempts))
        self.window_seconds = max(1, int(window_seconds))
        self.cooldown_seconds = max(1, int(cooldown_seconds))
        self._failures: Dict[str, List[float]] = {}
        self._locked_until: Dict[str, float] = {}

    def _now(self) -> float:
        return time.time()

    def _prune(self, key: str, now: float) -> None:
        failures = [t for t in self._failures.get(key, []) if (now - t) <= self.window_seconds]
        if failures:
            self._failures[key] = failures
        elif key in self._failures:
            self._failures.pop(key, None)

        lock_until = self._locked_until.get(key, 0.0)
        if lock_until and lock_until <= now:
            self._locked_until.pop(key, None)

    def is_locked(self, key: str) -> int:
        now = self._now()
        self._prune(key, now)
        lock_until = self._locked_until.get(key, 0.0)
        if lock_until > now:
            return int(lock_until - now)
        return 0

    def register_failure(self, key: str) -> int:
        now = self._now()
        self._prune(key, now)
        failures = self._failures.setdefault(key, [])
        failures.append(now)
        if len(failures) >= self.max_attempts:
            lock_until = now + self.cooldown_seconds
            self._locked_until[key] = lock_until
            self._failures[key] = []
            return int(self.cooldown_seconds)
        return 0

    def register_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)


def build_security_headers(is_https: bool) -> Dict[str, str]:
    headers = {
        "Content-Security-Policy": (
            "default-src 'self'; "
            "img-src 'self' data: https:; "
            "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; "
            "font-src 'self' data: https:; "
            "connect-src 'self'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'"
        ),
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    }
    if is_https:
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return headers
