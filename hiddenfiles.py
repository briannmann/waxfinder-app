"""Files Waxfinder has been told to forget ("Remove from Waxfinder only"). The file stays on the drive untouched; it just never
shows up in the library, crates or picks again, and a rescan does not bring it back. hidden.json next to app.py: USER DATA, never wipe.
Keyed by the NFC '/'-separated path, like every other stored path."""
import json, threading, time
from pathlib import Path
from paths import safe_replace, posix
import unicodedata

FILE = Path(__file__).parent / "hidden.json"
LOCK = threading.Lock()
def _k(p): return unicodedata.normalize("NFC", posix(p))

def _load():
    try: return json.loads(FILE.read_text(encoding="utf-8")).get("files", {})
    except FileNotFoundError: return {}
    except Exception as ex: raise RuntimeError(f"hidden.json is damaged: {ex}")   # refuse rather than start empty (that would un-hide everything)

def _save(files):
    tmp = FILE.with_suffix(".tmp"); tmp.write_text(json.dumps({"files": files}, indent=1, ensure_ascii=False), encoding="utf-8"); safe_replace(tmp, FILE)

def hidden():
    return set(_load())

def hide(paths):
    with LOCK:
        f = _load(); now = time.time()
        for p in paths: f[_k(p)] = now
        _save(f)

def unhide(paths):
    with LOCK:
        f = _load(); n = len(f)
        for p in paths: f.pop(_k(p), None)
        if len(f) != n: _save(f)
