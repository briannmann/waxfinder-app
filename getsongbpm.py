"""Online BPM lookup from GetSongBPM (free API key; their terms ask for a visible link back to getsongbpm.com wherever it is used).
Gated on the key file ~/Library/Application Support/Waxfinder/getsongbpm-key (kept out of the repo). Untested until a key exists.
Returns a tempo for a song by name + artist, or None. One request per search + one per match, spaced out."""
import json, re, time, threading, urllib.parse, urllib.request
from pathlib import Path

KEY_FILE = Path.home() / "Library/Application Support/Waxfinder/getsongbpm-key"
BASE = "https://api.getsong.co"
_LOCK = threading.Lock(); _last = [0.0]

def _key():
    try: return KEY_FILE.read_text().strip()
    except OSError: return ""

def available(): return bool(_key())

def _get(path, **q):
    with _LOCK:
        wait = .6 - (time.time() - _last[0])
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
    url = BASE + path + "?" + urllib.parse.urlencode({"api_key": _key(), **q})
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Waxfinder/1.0 (personal DJ library tool)"}), timeout=20).read())

def _n(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def tempo(artist, title):
    """-> {'bpm': float, 'title': .., 'artist': ..} for the best match whose artist agrees, or None."""
    if not available(): return None
    try:
        hits = _get("/search/", type="both", lookup=f"song:{title} artist:{artist}").get("search") or []
        if not isinstance(hits, list): return None
        for h in hits[:3]:
            a = (h.get("artist") or {}).get("name", "")
            if _n(artist)[:6] and _n(artist)[:6] in _n(a):
                s = _get("/song/", id=h["id"]).get("song") or {}
                b = float(s.get("tempo") or 0)
                if b: return {"bpm": b, "title": h.get("title", ""), "artist": a}
    except Exception: return None
    return None
