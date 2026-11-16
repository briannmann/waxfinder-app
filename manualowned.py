"""User-marked owned Picks. Permanent metadata only; never a dislike or an audio-file edit."""
import json
import threading
import time
import uuid
from pathlib import Path

from paths import safe_replace
FILE = Path(__file__).parent / "manual_owned.json"
LOCK = threading.Lock()


def _load():
    try:
        data = json.loads(FILE.read_text())
    except FileNotFoundError:
        data = {"marks": {}}
    if not isinstance(data, dict) or not isinstance(data.get("marks"), dict):
        raise ValueError("Could not read your already-owned marks; existing data was preserved")
    return data


def _save(data):
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    safe_replace(tmp, FILE)


def items():
    with LOCK:
        return [r["item"] for r in _load()["marks"].values()]


def mark(item):
    if not isinstance(item, dict):
        raise ValueError("Choose a Pick to mark as already owned")
    allowed = ("id", "title", "track", "artist", "channel", "url", "page", "src", "yt")
    clean = {k: item[k].strip()[:2000] for k in allowed if isinstance(item.get(k), str) and item[k].strip()}
    if not (clean.get("title") or clean.get("track")) or not (clean.get("id") or clean.get("url") or clean.get("page")):
        raise ValueError("This Pick has no usable track details")
    key = uuid.uuid4().hex
    with LOCK:
        data = _load()
        data["marks"][key] = {"created": time.time(), "item": clean}
        _save(data)
    return key


def undo(key):
    if not isinstance(key, str) or len(key) > 100:
        raise ValueError("Choose a valid already-owned mark")
    with LOCK:
        data = _load()
        removed = data["marks"].pop(key, None) is not None
        if removed:
            _save(data)
    return removed
