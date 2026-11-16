"""Background second opinion on every track's BPM: two cheap independent readers (bpm.py's quick reader and rtbpm) on one 30 s clip.
Where those two AGREE (measured 99% right) and the library's BPM disagrees with them, the track is flagged 'BPM to check'.
Store: bpm_second.json {track id: {"q": .., "r": .., "sig": "<size:mtime>"}}; resumable, never wiped, written atomically. Nothing here changes a BPM."""
import json, os, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FILE = Path(__file__).parent / "bpm_second.json"
JOB = {"state": "idle", "done": 0, "total": 0}
_C = {"mt": None, "d": {}}; _LOCK = threading.Lock()

def _all():
    try: mt = FILE.stat().st_mtime
    except OSError: mt = None
    if mt != _C["mt"]:
        try: _C["d"] = json.loads(FILE.read_text())
        except (OSError, ValueError): _C["d"] = {}
        _C["mt"] = mt
    return _C["d"]

def consensus(tid):
    """The two readers' shared BPM, or None when missing or they disagree."""
    e = _all().get(tid) or {}; q, r = e.get("q"), e.get("r")
    return round((q + r) / 2, 2) if q and r and abs(q - r) <= .6 else None

def _sig(path):
    st = os.stat(path); return f"{st.st_size}:{int(st.st_mtime)}"

def scan(tracks, ffmpeg):
    """tracks: setbuild.tracks() rows. Reads only tracks on disk with no (current) entry, 3 at a time, then saves."""
    if JOB["state"] == "running": return
    import bpm, rtbpm
    d = dict(_all()); todo = []
    for t in tracks:
        try:
            if t.get("here") and (d.get(t["id"]) or {}).get("sig") != _sig(t["file"]): todo.append(t)
        except OSError: pass
    JOB.update(state="running", done=0, total=len(todo))
    def one(t):
        try:
            q = bpm.estimate(ffmpeg, t["file"]); r = rtbpm.estimate(ffmpeg, t["file"]); return t, {"q": q, "r": r, "sig": _sig(t["file"])}
        except Exception: return t, None
    def go():
        try:
            with ThreadPoolExecutor(3) as ex:
                for t, e in ex.map(one, todo):
                    if e: d[t["id"]] = e
                    JOB["done"] += 1
                    if JOB["done"] % 100 == 0: _save(d)
        finally:
            _save(d); JOB["state"] = "done"
    threading.Thread(target=go, daemon=True).start()

def _save(d):
    import libindex
    with _LOCK: libindex._atomic(FILE, d); _C["mt"] = None
