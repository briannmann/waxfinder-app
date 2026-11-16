"""Shared read-only Discogs client. Private token stays outside the app/repository.

All library/discovery requests share one paced lane: <=59/min authenticated,
<=20/min otherwise. Never include credentials in URLs, status, errors or logs.
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.discogs.com"
TOKEN_FILE = Path.home() / "Library/Application Support/Waxfinder/discogs-token"
AUTH_INTERVAL, PUBLIC_INTERVAL = 60 / 59, 3.0
_LOCK = threading.Lock()
_last_request = 0.0
_blocked_until = 0.0
_STATUS = {"verified": False, "rate_limit": None, "remaining": None}


class RateLimited(RuntimeError):
    def __init__(self, retry_after):
        super().__init__("Discogs request limit reached; requests paused")
        self.retry_after = retry_after


def token():
    try:
        value = TOKEN_FILE.read_text().strip()
    except FileNotFoundError:
        return ""
    if any(c.isspace() for c in value):
        raise RuntimeError("Discogs token file is invalid")
    return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Discogs returned an unexpected redirect")


_OPENER = urllib.request.build_opener(_NoRedirect)


def _open(req):
    return _OPENER.open(req, timeout=25)


def read(path):
    global _last_request, _blocked_until
    parsed = urllib.parse.urlsplit(path)
    if not path.startswith("/") or path.startswith("//") or parsed.scheme or parsed.netloc:
        raise ValueError("Discogs requests must use a relative API path")
    secret = token()
    headers = {"User-Agent": "Waxfinder/1.0 (personal music library)",
               "Accept": "application/vnd.discogs.v2.plaintext+json"}
    if secret:
        headers["Authorization"] = "Discogs token=" + secret
    req = urllib.request.Request(BASE + path, headers=headers)
    interval = AUTH_INTERVAL if secret else PUBLIC_INTERVAL
    with _LOCK:
        now = time.monotonic()
        time.sleep(max(0, interval - (now - _last_request), _blocked_until - now))
        _last_request = time.monotonic()
        try:
            with _open(req) as response:
                result = response.read().decode("utf-8", "replace")
                limit = response.headers.get("X-Discogs-Ratelimit")
                remaining = response.headers.get("X-Discogs-Ratelimit-Remaining")
                _STATUS.update(verified=bool(secret and limit and int(limit) > 25),
                               rate_limit=int(limit) if limit else None,
                               remaining=int(remaining) if remaining else None)
                if remaining is not None and int(remaining) <= 0:
                    _blocked_until = time.monotonic() + 60
                return result
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                try: wait = max(60., float(exc.headers.get("Retry-After", 60)))
                except (TypeError, ValueError): wait = 60.
                _blocked_until = time.monotonic() + wait
                raise RateLimited(wait) from None
            if exc.code in (401, 403):
                _STATUS["verified"] = False
                raise RuntimeError("Discogs authentication was rejected") from None
            raise RuntimeError("Discogs returned HTTP " + str(exc.code)) from None


def get(path):
    return json.loads(read(path))


def status():
    configured = bool(token())
    return {"token_saved": configured, "verified": bool(configured and _STATUS["verified"]),
            "rate_limit": _STATUS["rate_limit"], "remaining": _STATUS["remaining"],
            "requests_per_minute": 60 / (AUTH_INTERVAL if configured else PUBLIC_INTERVAL)}
