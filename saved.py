"""Saved Picks: tracks to download later. Permanent (saved.json, never wipe); keyed by the Pick id so save is a toggle.
Stores the whole Pick because Picks rotate out on every rebuild."""
import json
import threading
import time
from pathlib import Path

from paths import safe_replace
FILE = Path(__file__).parent / "saved.json"
LOCK = threading.Lock()
TEXT = ("id", "title", "track", "artist", "channel", "channel_url", "url", "page", "src", "src_url", "wave", "yt", "because", "why")
NUM = ("duration", "bpm")


def _load():
    try:
        data = json.loads(FILE.read_text())
    except FileNotFoundError:
        data = {"items": {}}
    if not isinstance(data, dict) or not isinstance(data.get("items"), dict):
        raise ValueError("Could not read your saved tracks; existing data was preserved")
    return data


def _save(data):
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    safe_replace(tmp, FILE)


def items():
    """Newest first."""
    with LOCK:
        rows = sorted(_load()["items"].values(), key=lambda r: r.get("created", 0), reverse=True)
    return [r["item"] for r in rows]


def add(item):
    if not isinstance(item, dict):
        raise ValueError("Choose a Pick to save")
    clean = {k: item[k].strip()[:2000] for k in TEXT if isinstance(item.get(k), str) and item[k].strip()}
    clean.update({k: item[k] for k in NUM if isinstance(item.get(k), (int, float)) and not isinstance(item.get(k), bool)})
    if not clean.get("id") or not (clean.get("title") or clean.get("track")) or not (clean.get("url") or clean.get("page")):
        raise ValueError("This Pick has no usable track details")
    with LOCK:
        data = _load()
        if clean["id"] not in data["items"]:
            data["items"][clean["id"]] = {"created": time.time(), "item": clean}
            _save(data)
    return clean["id"]


def remove(pid):
    if not isinstance(pid, str) or not pid or len(pid) > 2000:
        raise ValueError("Choose a saved track")
    with LOCK:
        data = _load()
        removed = data["items"].pop(pid, None) is not None
        if removed:
            _save(data)
    return removed
