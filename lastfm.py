"""Last.fm similar artists. Optional: needs a free API key in LASTFM_API_KEY or config.json {"lastfm_api_key": "..."}.
Without a key every call returns [] and the engine carries on as before."""
import json, os, time, urllib.parse, urllib.request
from pathlib import Path

CONFIG = Path(__file__).parent / "config.json"
_CACHE = {}  # artist -> (fetched at, [(name, match)])

def api_key():
    k = os.environ.get("LASTFM_API_KEY")
    if k: return k.strip()
    try: return (json.loads(CONFIG.read_text()).get("lastfm_api_key") or "").strip() or None
    except Exception: return None

def set_key(k):
    try: cfg = json.loads(CONFIG.read_text())
    except Exception: cfg = {}
    cfg["lastfm_api_key"] = (k or "").strip()
    CONFIG.write_text(json.dumps(cfg, indent=1))

def check(k):
    """True if Last.fm accepts the key."""
    try: return bool(_call("artist.getsimilar", {"artist": "Kerri Chandler", "limit": 1}, k).get("similarartists"))
    except Exception: return False

def _call(method, params, key):
    q = urllib.parse.urlencode({"method": method, "api_key": key, "format": "json", "autocorrect": 1, **params})
    req = urllib.request.Request("https://ws.audioscrobbler.com/2.0/?" + q, headers={"User-Agent": "Waxfinder/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r: return json.loads(r.read())

def similar(artist, limit=20):
    key = api_key()
    if not key or not artist: return []
    hit = _CACHE.get(artist.lower())
    if hit and time.time() - hit[0] < 7 * 86400: return hit[1]
    try:
        _throttle()
        d = _call("artist.getsimilar", {"artist": artist, "limit": limit}, key)
        out = [(a["name"], float(a.get("match") or 0)) for a in d.get("similarartists", {}).get("artist", [])]
    except Exception: out = []
    _CACHE[artist.lower()] = (time.time(), out)
    return out

import threading
TAG_FILE = Path(__file__).parent / "lastfm_tags.json"   # artist -> [fetched at, [[tag, weight 0-100], ...]]
try: _TAGS = json.loads(TAG_FILE.read_text())
except Exception: _TAGS = {}
_TLOCK, _last = threading.Lock(), [0.0]
OFFLINE = False   # set by the engine when its time budget for lookups runs out: cached tags only

def cached_tags_w(artist):
    """Use saved genre information without any network or credential lookup."""
    with _TLOCK: hit = _TAGS.get((artist or "").lower().strip())
    return [tuple(t) for t in hit[1]] if hit and time.time() - hit[0] < 30 * 86400 else []

def _throttle():   # stay under ~5 requests a second across threads
    with _TLOCK:
        wait = _last[0] + 0.22 - time.time()
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()

def tags_w(artist):
    """Top Last.fm tags with weights, e.g. [('deep house', 100), ('house', 71)]. [] if unknown / no key."""
    key = api_key()
    if not key or not artist: return []
    k = artist.lower().strip()
    hit = _TAGS.get(k)
    if hit and time.time() - hit[0] < 30 * 86400: return [tuple(t) for t in hit[1]]
    if OFFLINE: return []
    try:
        _throttle()
        d = _call("artist.gettoptags", {"artist": artist}, key)
        out = [(t["name"].lower().strip(), int(t.get("count") or 0)) for t in d.get("toptags", {}).get("tag", [])[:15]]
        out = [t for t in out if t[1] >= 5]
    except Exception: return []           # network trouble: don't cache, try again next time
    with _TLOCK: _TAGS[k] = [time.time(), out]
    return out

def save_tags():
    with _TLOCK:
        try: TAG_FILE.write_text(json.dumps(_TAGS))
        except Exception: pass

def tags(artist):
    """Tag names only (lower case)."""
    return [t for t, _ in tags_w(artist)]
