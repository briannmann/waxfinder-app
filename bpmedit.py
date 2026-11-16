"""BPM check: manual BPM overrides + the "models disagree" flag (Library right-click > Check BPM).
An override is stored by track id (bpm_overrides.json) and applied at the one place every screen gets its BPM
(setbuild.tracks), so the Library, Set builder and Rekordbox XML export all see it. Files and analysis are never touched.
Rekordbox's own beat grid is dropped for an overridden track when it disagrees: a wrong grid is worse than none."""
import json, threading, time
from pathlib import Path

FILE = Path(__file__).parent / "bpm_overrides.json"
LOCK = threading.Lock()
_C = {"mt": None, "d": {}}
ALIASES = (.5, 2 / 3, .75, .8, 1.25, 4 / 3, 1.5, 2.0)

def _all():
    try: mt = FILE.stat().st_mtime
    except OSError: mt = None
    if mt != _C["mt"]:
        try: _C["d"] = json.loads(FILE.read_text())
        except (OSError, ValueError): _C["d"] = {}
        _C["mt"] = mt
    return _C["d"]

def get(tid):
    o = _all().get(tid); return o and o.get("bpm")

def _save(d):
    import libindex
    libindex._atomic(FILE, d); _C["mt"] = None

def set_(tid, bpm, was=None):
    try: bpm = round(float(bpm), 2)
    except (TypeError, ValueError): return {"error": "Enter a number."}
    if not 40 <= bpm <= 220: return {"error": "BPM must be between 40 and 220."}
    with LOCK:
        d = dict(_all()); d[tid] = {"bpm": bpm, "was": was, "time": time.time()}; _save(d)
    return {"bpm": bpm}

def reset(tid):
    with LOCK:
        d = dict(_all())
        if tid not in d: return {"error": "No override on this track."}
        d.pop(tid); _save(d)
    return {"ok": True}

def disagree(a, b):
    """Do two readings of one track disagree? Differ by > 0.5 BPM, or sit a half/double/x1.5-type ratio apart (the worse kind)."""
    if not a or not b: return None
    if abs(a - b) <= .5: return None
    r = a / b
    return "tempo" if any(abs(r / v - 1) < .02 for v in ALIASES) else "close"

def _second(t):
    """The two quick readers agree with each other but not with the BPM we show: flag it (tolerance 1 BPM, they are coarser than the analysis)."""
    import bpmsecond
    c = bpmsecond.consensus(t.get("id"))
    if not c or not t.get("bpm"): return None
    return "tempo" if disagree(t["bpm"], c) == "tempo" else ("close" if abs(t["bpm"] - c) > 1.0 else None)

def apply(rows):
    """Overrides onto setbuild.tracks() rows; also stamps each row's `bpm_flag` (None | 'tempo' | 'close') from the cached readings."""
    d = _all()
    for t in rows:
        t["bpm_flag"] = disagree(t.get("bpm_ana"), t.get("bpm_rb")) or _second(t)
        o = d.get(t.get("id"))
        if not o: continue
        t["bpm"], t["bpm_confidence"], t["bpm_manual"], t["bpm_flag"] = o["bpm"], "manual", True, None
        g = t.get("grid")
        if g and abs((g.get("grid_bpm") or 0) - o["bpm"]) > .05: t["grid"] = None
    return rows
