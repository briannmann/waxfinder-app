"""Smart crates: a saved set of Library filters. The tracks are never stored, so the crate stays up to date by itself (read-only).
{id, name, f: {filter key: value}, created} in smart_crates.json. A corrupt file is refused, never reset."""
import json, os, threading, time, uuid
from pathlib import Path

FILE = Path(__file__).with_name("smart_crates.json")
LOCK = threading.Lock()
KEYS = ("q", "b0", "b1", "key", "en", "style", "ext", "added", "af", "at", "st", "x")   # the Library's filter keys (never 'crate': a smart crate is not inside a crate)


def _load():
    if not FILE.exists(): return []
    d = json.loads(FILE.read_text())
    if not isinstance(d, list): raise ValueError("smart_crates.json is not a list")
    return d


def _write(d):
    tmp = FILE.with_suffix(".tmp"); tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1)); os.replace(tmp, FILE)


def listing():
    try: return _load()
    except Exception: return []


def save(name, f):
    name = " ".join(str(name or "").split())[:60]
    f = {k: str(f[k]) for k in KEYS if isinstance(f, dict) and f.get(k) not in (None, "")}
    if not name: raise ValueError("Give it a name")
    if not f: raise ValueError("Set at least one filter first")
    with LOCK:
        d = _load()
        s = {"id": uuid.uuid4().hex[:8], "name": name, "f": f, "created": time.time()}
        d.append(s); _write(d); return s


def delete(sid):
    with LOCK:
        d = _load(); keep = [s for s in d if s.get("id") != sid]
        if len(keep) == len(d): return False
        _write(keep); return True
