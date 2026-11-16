"""Musical key (and a BPM second opinion) from rbxport's analysis engine, via ~/Tools/rbx-cli (about 1 s per track).
Measured on 80 tracks against Rekordbox's own keys: rbxport 70% exact, AudioIntel 38%. So for tracks with NO Rekordbox key, setbuild.tracks
now prefers this over AudioIntel's key (AudioIntel stays the fallback). Store: rbx_keys.json {track id: {key, camelot, bpm, sig}}; resumable,
never wiped, written atomically. Gated on the binary existing (Mac only), so the Windows copy simply keeps using AudioIntel."""
import json, os, subprocess, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FILE = Path(__file__).parent / "rbx_keys.json"
import enginebin
BIN = enginebin.rbx_cli()
JOB = {"state": "idle", "done": 0, "total": 0}
_C = {"mt": None, "d": {}}; _LOCK = threading.Lock()

def available(): return BIN.is_file()

def _all():
    try: mt = FILE.stat().st_mtime
    except OSError: mt = None
    if mt != _C["mt"]:
        try: _C["d"] = json.loads(FILE.read_text())
        except (OSError, ValueError): _C["d"] = {}
        _C["mt"] = mt
    return _C["d"]

def get(tid):
    """Camelot code (e.g. '10A') rbxport read for this track, or None."""
    return (_all().get(tid) or {}).get("camelot")

def _sig(path):
    st = os.stat(path); return f"{st.st_size}:{int(st.st_mtime)}"

def _save(d):
    import libindex
    with _LOCK: libindex._atomic(FILE, d); _C["mt"] = None

def analyse(path, timeout=240):
    try:
        p = subprocess.run([*enginebin.gentle(10), str(BIN), "analyse", str(path)], capture_output=True, text=True, timeout=timeout)
        for line in p.stdout.splitlines():
            j = json.loads(line)
            if j.get("camelot"): return {"key": j.get("key"), "camelot": j["camelot"], "bpm": j.get("bpm")}
    except Exception: pass
    return None

def scan(tracks, skip_ids=()):
    """tracks: setbuild.tracks()-style rows (id, file, here). Analyses only tracks on disk with no current entry, 3 at a time."""
    if JOB["state"] == "running" or not available(): return
    d = dict(_all()); todo = []
    for t in tracks:
        try:
            if t.get("here") and t["id"] not in skip_ids and (d.get(t["id"]) or {}).get("sig") != _sig(t["file"]): todo.append(t)
        except OSError: pass
    JOB.update(state="running", done=0, total=len(todo))
    def one(t):
        try:
            r = analyse(t["file"]); return t, (dict(r, sig=_sig(t["file"])) if r else None)
        except Exception: return t, None
    def go():
        try:
            with ThreadPoolExecutor(3) as ex:
                for t, e in ex.map(one, todo):
                    if e: d[t["id"]] = e
                    JOB["done"] += 1
                    if JOB["done"] % 50 == 0: _save(d)
        finally:
            _save(d); JOB["state"] = "done"
    threading.Thread(target=go, daemon=True).start()
