"""Sound fingerprints (Discogs-EffNet) for every library track: 'Find similar', style tags, and how alike two tracks sound.
Fingerprints come from the worker in ~/Tools/SoundMatch (its own venv); cached in sound_index.json (user data: NEVER wipe).
Predicted genre/style fields are discarded; genre tags come exclusively from published listings.
Match % is rescaled against this library's own spread, so 50% = a typical pair here and 90%+ = genuinely close."""
import base64, json, subprocess, threading, time
from pathlib import Path
from paths import safe_replace
import numpy as np
import setbuild

HERE = Path(__file__).parent
FILE = HERE / "sound_index.json"
SM = Path.home() / "Tools/SoundMatch"
PY, WORKER = SM / ".venv/bin/python", SM / "fingerprint.py"
_LOCK = threading.Lock()
JOB = {"state": "idle", "done": 0, "total": 0, "errors": 0}
_PENDING = {}   # retain linked songs requested while another fingerprint batch runs
try: CACHE = json.loads(FILE.read_text())          # nfc(file) -> {"sig", "v", "styles"}
except Exception: CACHE = {}
_MAT = {"key": None}                               # cached matrix + spread stats


def available(): return PY.exists() and WORKER.exists()


def _key(e): return setbuild.nfc(e["file"])


def cached(e):
    c = CACHE.get(_key(e))
    if not c: return None
    try: return c if c.get("sig") == setbuild._sig(e["file"]) else None
    except FileNotFoundError: return None   # renamed/deleted file or unplugged stick: no fingerprint, not a crash (it used to kill the whole Picks build)


def _save():
    tmp = FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps(CACHE)); safe_replace(tmp, FILE)


def start(hist):
    """Fingerprint any library tracks that don't have one yet (background; safe to call often)."""
    if not available(): return JOB
    with _LOCK:
        if JOB["state"] == "working":
            _PENDING.update({_key(e): e for e in hist if e.get("file")})
            JOB["again"] = True
            return JOB
        todo = [e for e in setbuild.library(hist) if cached(e) is None and _key(e) not in _FAILED]
        JOB.update(state="working" if todo else "done", done=0, total=len(todo), errors=0)
    if todo: threading.Thread(target=_run, args=(todo,), daemon=True).start()
    return JOB


_FAILED = set()   # files the worker couldn't read this session (not retried until restart)
HIST_LOADER = None


def _run(todo):
    try:
        p = subprocess.Popen([str(PY), str(WORKER)], cwd=str(SM), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, bufsize=1)
        p.stdout.readline()                                   # {"ready": true}
        by = {e["file"]: e for e in todo}; last = time.time()
        for e in todo:
            p.stdin.write(e["file"] + "\n"); p.stdin.flush()
            r = json.loads(p.stdout.readline() or "{}")
            f = r.get("file") or e["file"]; ent = by.get(f, e)
            with _LOCK:
                if r.get("v"):
                    CACHE[_key(ent)] = {"sig": setbuild._sig(ent["file"]), "v": r["v"]}
                    _MAT["key"] = None
                else: JOB["errors"] += 1; _FAILED.add(_key(ent))
                JOB["done"] += 1
                if time.time() - last > 5: _save(); last = time.time()
        p.stdin.close(); p.wait(timeout=30)
    except Exception: JOB["errors"] += 1
    with _LOCK:
        _save()
        reload = JOB.pop("again", False) and HIST_LOADER
        pending = list(_PENDING.values()); _PENDING.clear()
        JOB.update(state="done")
    if reload: pending += HIST_LOADER()
    if pending: start(pending)


def _vec(c): return np.frombuffer(base64.b64decode(c["v"]), dtype=np.float16).astype(np.float32)


def matrix(hist):
    """ids, unit vectors, and the library's similarity spread (for the % scale). Cached until a fingerprint changes."""
    lib = [e for e in setbuild.library(hist) if cached(e)]
    key = (len(CACHE), tuple(e["id"] for e in lib))
    if _MAT["key"] != key:
        ids = [e["id"] for e in lib]
        V = np.array([_vec(cached(e)) for e in lib], dtype=np.float32) if lib else np.zeros((0, 1280), np.float32)
        if len(V): V /= np.linalg.norm(V, axis=1, keepdims=True) + 1e-9
        S = V @ V.T if len(V) > 1 else np.zeros((len(V), len(V)))
        off = S[~np.eye(len(V), dtype=bool)] if len(V) > 1 else np.array([0.0, 1.0])
        _MAT.update(key=key, ids=ids, idx={i: n for n, i in enumerate(ids)}, V=V,
                    p01=float(np.percentile(off, 1)), med=float(np.median(off)), p99=float(np.percentile(off, 99.9)))
    return _MAT


def pct(s, m):
    """cosine -> 0-100 against this library: p1 -> 0, median -> 50, the closest 0.1% of pairs -> 100."""
    if s >= m["med"]: return float(np.clip(50 + 50 * (s - m["med"]) / ((m["p99"] - m["med"]) or 1), 0, 100))
    return float(np.clip(50 * (s - m["p01"]) / ((m["med"] - m["p01"]) or 1), 0, 50))


def pct_matrix(S, m):
    """Vectorised pct() for a whole similarity matrix."""
    hi = 50 + 50 * (S - m["med"]) / ((m["p99"] - m["med"]) or 1)
    lo = 50 * (S - m["p01"]) / ((m["med"] - m["p01"]) or 1)
    return np.where(S >= m["med"], np.clip(hi, 0, 100), np.clip(lo, 0, 50))


def similar(hist, tid, n=500):
    m = matrix(hist)
    if tid not in m["idx"]: return None
    s = m["V"] @ m["V"][m["idx"][tid]]
    order = [j for j in np.argsort(-s) if m["ids"][j] != tid][:n]
    return [{"id": m["ids"][j], "pct": round(pct(float(s[j]), m))} for j in order]


def alike(hist, a, b):
    """How alike two library tracks sound, 0-100 (None if either has no fingerprint yet)."""
    m = matrix(hist)
    if a not in m["idx"] or b not in m["idx"]: return None
    return pct(float(m["V"][m["idx"][a]] @ m["V"][m["idx"][b]]), m)


def styles(e, k=2):
    """Compatibility only: sound analysis must never provide genre tags."""
    return []

GENERIC = {"House", "Techno", "Electro", "Trance", "Downtempo"}
