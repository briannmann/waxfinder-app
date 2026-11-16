"""Genre ESTIMATES from the sound itself (Essentia Discogs-EffNet via ~/Tools/SoundMatch), shown ONLY when no real listing genre exists.
Never counted as a genre tag: never filtered or sorted on, never written to a file, never mixed into genre_tags.json (so stylecleanup's
purge of model-made styles cannot touch it). Shown in the Library as a muted '~ Deep House'. Store: sound_styles.json {track id: {top, sig}};
resumable, never wiped, atomic. Gated on SoundMatch's venv + worker (Mac only); without them nothing shows."""
import json, os, subprocess, threading
from pathlib import Path

FILE = Path(__file__).parent / "sound_styles.json"
PY = Path.home() / "Tools/SoundMatch/.venv/bin/python"; WORKER = Path.home() / "Tools/SoundMatch/styles_batch.py"
JOB = {"state": "idle", "done": 0, "total": 0}
_C = {"mt": None, "d": {}}; _LOCK = threading.Lock()

def available(): return PY.is_file() and WORKER.is_file()

def _all():
    try: mt = FILE.stat().st_mtime
    except OSError: mt = None
    if mt != _C["mt"]:
        try: _C["d"] = json.loads(FILE.read_text())
        except (OSError, ValueError): _C["d"] = {}
        _C["mt"] = mt
    return _C["d"]

def pick(top, n=2, strong=.2, floor=.12):
    """Up to n style names from [[ 'Electronic---Deep House', .52 ], ...]: those scoring >= strong, else the best one if >= floor."""
    names, seen = [], set()
    for s, p in top or []:   # "Funk / Soul---Disco" and "Electronic---Disco" are both just "Disco": show it once
        nm = s.split("---")[-1].strip()
        if nm not in seen: seen.add(nm); names.append((nm, p))
    out = [s for s, p in names if p >= strong][:n]
    return out or [s for s, p in names[:1] if p >= floor]

def estimate(tid):
    return pick((_all().get(tid) or {}).get("top"))

def _sig(path):
    st = os.stat(path); return f"{st.st_size}:{int(st.st_mtime)}"

def _save(d):
    import libindex
    with _LOCK: libindex._atomic(FILE, d); _C["mt"] = None

def scan(rows):
    """rows: history entries (id, file) that have no listing genre. Skips ones already estimated for this exact file."""
    if JOB["state"] == "running" or not available(): return
    d = dict(_all()); todo = []
    for e in rows:
        try:
            if e.get("file") and os.path.exists(e["file"]) and (d.get(e["id"]) or {}).get("sig") != _sig(e["file"]): todo.append(e)
        except OSError: pass
    JOB.update(state="running", done=0, total=len(todo))
    def go():
        try:
            for i in range(0, len(todo), 60):
                batch = todo[i:i + 60]; sigs = {e["id"]: _sig(e["file"]) for e in batch if os.path.exists(e["file"])}
                p = subprocess.Popen(["nice", "-n", "10", str(PY), str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                p.stdin.write(json.dumps([{"id": e["id"], "file": e["file"]} for e in batch])); p.stdin.close()
                for line in p.stdout:
                    try: j = json.loads(line)
                    except ValueError: continue
                    if j.get("top") and j["id"] in sigs: d[j["id"]] = {"top": j["top"], "sig": sigs[j["id"]]}
                    JOB["done"] += 1
                p.wait(); _save(d)
        except Exception: pass
        finally:
            _save(d); JOB["state"] = "done"
    threading.Thread(target=go, daemon=True).start()
