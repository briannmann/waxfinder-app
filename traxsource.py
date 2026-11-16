"""Public Traxsource search/player adapter. No login, shared browser profile, or executable page data.

Search pages may require a JavaScript browser. One dedicated ordinary Chrome session is reused,
with six-hour search caching; browser checks that persist are reported, never bypassed.
The public player supplies short previews, not downloadable DJ-quality tracks.
"""
import json
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

import imageio_ffmpeg
from names import akey, split_artists
from traxsource_browser import SearchBrowser, BrowserError

BASE = "https://www.traxsource.com"
PLAYER = "https://w-static.traxsource.com/scripts/playlist.php"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
_SEARCHES = {}
_BROWSER = threading.Lock()
_BROWSER_RETRY_AT = 0.
_SEARCH_BROWSER = None
BROWSER_TRANSPORT = 'regular-chrome-pipe-v3'
BROWSER_RETRY_SECONDS = 30


class QueryRejected(RuntimeError):
    """A specific search string was refused; other tracks can still be searched."""
    retry_after = 86400


class SearchUnavailable(RuntimeError):
    def __init__(self, message, retry_after=BROWSER_RETRY_SECONDS):
        super().__init__(message)
        self.retry_after = max(1, retry_after)


def browser_html(url):
    global _SEARCH_BROWSER
    if _SEARCH_BROWSER is None:
        if not CHROME.is_file():
            raise BrowserError('Traxsource search needs Google Chrome')
        _SEARCH_BROWSER = SearchBrowser(CHROME)
    return _SEARCH_BROWSER.html(url)


def browser_ready():
    """Notice user-completed verification without sending another search request."""
    global _BROWSER_RETRY_AT
    with _BROWSER:
        if _SEARCH_BROWSER is None:
            return False
        try:
            page = _SEARCH_BROWSER.snapshot()
            url = urllib.parse.urlsplit(page.get('url', ''))
            term = urllib.parse.parse_qs(url.query).get('term', [''])[0]
            html = page.get('html', '')
            valid = is_search_page(html)
            if url.scheme != 'https' or url.netloc != 'www.traxsource.com' or url.path != '/search' or page.get('ready') != 'complete' or not term or not valid:
                return False
        except (BrowserError, KeyError, ValueError):
            return False
        _SEARCHES[term.casefold()] = (time.time(), html)
        _BROWSER_RETRY_AT = 0.
        return True


class TrackIDs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        track = attrs.get("data-trid", "")
        if "trk-row" in attrs.get("class", "").split() and track.isdigit() and track not in self.ids:
            self.ids.append(track)


def track_ids(html):
    parser = TrackIDs(); parser.feed(html)
    return parser.ids


def is_search_page(html):
    """Searches may legitimately contain only release/artist results, no tracks."""
    if track_ids(html):
        return True
    if re.search(r'no (?:tracks|results)|nothing found|0 results|search results', html, re.I):
        return True
    return bool(re.search(r'<title>[^<]*\|\s*Traxsource\s*</title>', html, re.I) and 'Filters:' in html)


def search_html(artist, http):
    global _BROWSER_RETRY_AT
    query = urllib.parse.urlencode({"term": artist, "cn": "tracks"})
    url = BASE + "/search?" + query
    with _BROWSER:
        hit = _SEARCHES.get(artist.casefold())
        if hit and time.time() - hit[0] < 6 * 3600: return hit[1]
        if time.time() < _BROWSER_RETRY_AT:
            raise SearchUnavailable("Traxsource search is cooling down", _BROWSER_RETRY_AT - time.time())
        html = ""
        if _SEARCH_BROWSER is None:
            try: html = http(url)
            except urllib.error.HTTPError as exc:
                if exc.code != 403: raise
                html = exc.read(100000).decode('utf-8', 'replace') if exc.fp else ''
        if 'administrative rules' in html.lower():
            raise QueryRejected('Traxsource rejected this track search text')
        valid = is_search_page(html)
        if _SEARCH_BROWSER is not None or not valid or "Just a moment" in html:
            try:
                html = browser_html(url)
            except BrowserError as exc:
                _BROWSER_RETRY_AT = time.time() + BROWSER_RETRY_SECONDS
                raise SearchUnavailable(str(exc)) from exc
            if 'administrative rules' in html.lower():
                raise QueryRejected('Traxsource rejected this track search text')
            if not html.strip():
                _BROWSER_RETRY_AT = time.time() + BROWSER_RETRY_SECONDS
                raise SearchUnavailable("Traxsource search browser returned no page")
            if not is_search_page(html) and ("Just a moment" in html or "cf-chl-" in html):
                _BROWSER_RETRY_AT = time.time() + BROWSER_RETRY_SECONDS
                raise SearchUnavailable("Traxsource verification is waiting in its search window")
        _SEARCHES[artist.casefold()] = (time.time(), html)
        return html


def player_rows(xml):
    data = ET.fromstring(xml).findtext("data")
    if not data: return []
    # Player responses use object-literal keys. Quote bare keys only outside strings;
    # JSON parsing rejects expressions, function calls and other executable JavaScript.
    tokens = re.compile(r'"(?:\\.|[^"\\])*"|([A-Za-z_$][\w$]*)(\s*:)')
    def json_token(match):
        if match[1]: return json.dumps(match[1]) + match[2]
        # The legacy player escapes apostrophes even inside double-quoted strings.
        # Match escape pairs so an escaped backslash before an apostrophe stays intact.
        return re.sub(r"\\.", lambda escape: "'" if escape[0] == "\\'" else escape[0], match[0])
    data = tokens.sub(json_token, data)
    rows = json.loads(data)
    return rows if isinstance(rows, list) else []


def seconds(value):
    parts = str(value or "").split(":")
    if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts): return None
    total = 0
    for p in parts: total = total * 60 + int(p)
    return total


def valid_preview(url):
    u = urllib.parse.urlsplit(url or "")
    return u.scheme == "https" and u.hostname in ("geo-preview.traxsource.com", "preview.traxsource.com") and u.path.endswith(".mp3")


def candidates(seed, http, make_id, n=8):
    ids = track_ids(search_html(seed["artist"], http))[:20]
    if not ids: return []
    rows = player_rows(http(PLAYER + "?" + urllib.parse.urlencode({"tracks": ",".join(ids)})))
    wanted = {akey(a) for a in split_artists(seed["artist"]) if akey(a)}
    out = []
    for row in rows:
        artists = [a for a in row.get("artist", []) if isinstance(a, list) and len(a) >= 3]
        if not wanted.intersection(akey(a[2]) for a in artists): continue
        track = str(row.get("track_id") or "")
        duration = seconds(row.get("duration"))
        if not track.isdigit() or not duration or not 60 <= duration <= 1200 or not valid_preview(row.get("mp3")): continue
        artist = ", ".join(a[2] for a in artists if a[1] == 1) or ", ".join(a[2] for a in artists)
        label = row.get("label") or []
        path = row.get("track_url") or ""
        if not path.startswith("/track/" + track + "/"): continue
        out.append({"id": make_id("traxsource", track), "src": "traxsource", "trax_id": track,
                    "page": BASE + path, "artist": artist, "title": row.get("title") or "",
                    "label": label[1] if len(label) > 1 else "", "dur": duration,
                    "preview": row["mp3"], "preview_ts": time.time(), "preview_only": True,
                    "bpm": row.get("bpm"), "store_key": row.get("keysig"), "genre": row.get("genre")})
        if len(out) >= n: break
    return out


def audio(c, http):
    url = c.get("preview")
    if not valid_preview(url) or time.time() - c.get("preview_ts", 0) > 6 * 3600:
        rows = player_rows(http(PLAYER + "?" + urllib.parse.urlencode({"tracks": c["trax_id"]})))
        row = next((r for r in rows if str(r.get("track_id")) == c["trax_id"]), {})
        url = row.get("mp3")
    if not valid_preview(url): return None
    return url, {}, None, {"preview_only": True}


def preview_duration(path):
    result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-nostdin", "-i", str(path)],
                            capture_output=True, text=True, timeout=15)
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match: raise RuntimeError("Could not read Traxsource preview duration")
    return int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
