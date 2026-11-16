"""Energy, the Mixed In Key way (patent US8865993, personal use): per-8-bar features (tools/energy_track.py)
scored by a linear SVM trained on YOUR 1-10 tags (older Low..Peak tags map onto 1-10) (tools/energy_train.py).
Overall energy = 75th percentile of the track's 8-bar scores, so intros and breakdowns don't drag it down.
The model only takes over set building once it beats the old score on your tags (leave-one-out).

Data files (never wipe): energy_feats.json, energy_tags.json, energy_model.json."""
import json, os, random, subprocess, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from paths import safe_replace, note
import numpy as np
import setbuild
from setbuild import nfc, _sig, AI_DIR, AI_PY

HERE = Path(__file__).parent
FEATS_FILE, TAGS_FILE, MODEL_FILE = HERE / "energy_feats.json", HERE / "energy_tags.json", HERE / "energy_model.json"
WORKER, TRAINER = HERE / "tools/energy_track.py", HERE / "tools/energy_train.py"
V, MIN_TAGS = 1, 30
_LOCK = threading.Lock()
JOB = {"state": "idle", "done": 0, "total": 0, "errors": 0, "current": ""}

def _read(p, empty):
    try: return json.loads(p.read_text())
    except Exception: return empty
FEATS, TAGS, MODEL = _read(FEATS_FILE, {}), _read(TAGS_FILE, {}), _read(MODEL_FILE, None)

def _write(p, obj):
    tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(obj)); safe_replace(tmp, p)

# ---------- features ----------
def feats(t):
    c = FEATS.get(nfc(t["file"]))
    if not (c and c["v"] == V and c["segs"] and abs(c["bpm"] - t["bpm"]) < .5): return None
    try: return c if c["sig"] == _sig(t["file"]) else None
    except OSError: return c   # the file can't be reached right now (drive unplugged): keep the saved score rather than lose it

def _one(t):
    env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", VECLIB_MAXIMUM_THREADS="1", NUMBA_NUM_THREADS="1")
    fb = (t.get("grid") or {}).get("first_beat")
    r = subprocess.run([str(AI_PY), str(WORKER), t["file"], str(t["bpm"]), str(fb)], cwd=str(AI_DIR),
                       capture_output=True, text=True, timeout=600, env=env)
    line = next((l for l in r.stdout.splitlines()[::-1] if l.startswith("{")), None)
    if not line: raise RuntimeError((r.stderr or "no output")[-200:])
    return json.loads(line)

def start(hist, workers=3):
    with _LOCK:
        if JOB["state"] == "working": return JOB
        JOB.update(state="working", done=0, total=0, errors=0, current="", started=time.time())
    def run():
        todo = [t for t in setbuild.tracks(hist) if t.get("bpm") and not feats(t)]
        JOB["total"] = len(todo)
        last = [time.time()]
        def work(t):
            JOB["current"] = Path(t["file"]).stem
            try:
                res = _one(t)
                with _LOCK:
                    FEATS[nfc(t["file"])] = {**res, "sig": _sig(t["file"])}
                    if time.time() - last[0] > 20: _write(FEATS_FILE, FEATS); last[0] = time.time()
            except Exception: JOB["errors"] += 1
            JOB["done"] += 1
        with ThreadPoolExecutor(workers) as ex: list(ex.map(work, todo))
        with _LOCK: _write(FEATS_FILE, FEATS); JOB.update(state="done", current="")
    threading.Thread(target=run, daemon=True).start()
    return JOB

# ---------- scoring ----------
def active():
    """The new score drives set building only once it has enough tags and beats the old one on them."""
    m = MODEL
    return bool(m and m["n"] >= MIN_TAGS and m["new"]["agree"] >= m["old"]["agree"] + .05 and m["new"]["rho"] > m["old"]["rho"])

def median(): return (MODEL or {}).get("lib", {}).get("p50", 5.0)

def score(t):
    """(overall 1-10, [8-bar scores]) from the trained model, or None."""
    c = feats(t)
    if not (MODEL and c): return None
    S = (np.array(c["segs"]) - MODEL["mean"]) / MODEL["std"]
    bz = (t["bpm"] - MODEL["bpm_mean"]) / MODEL["bpm_std"]
    p = np.clip(S @ np.array(MODEL["coef"]) + MODEL["bpm_coef"] * bz + MODEL["intercept"], 1, 10)
    return round(float(np.percentile(p, 75)), 1), [int(round(x)) for x in p]

# ---------- tags + training ----------
T5 = {1: 2.0, 2: 3.75, 3: 5.5, 4: 7.25, 5: 9.0}   # 5-step tags (Low, Low-mid, Mid, High-mid, Peak) on the 1-10 scale
def legacy3(g): return "s" not in g                # earliest tags: 3-step Low / Mid / Peak, no "s"
def target(g):
    """Any tag as a 1-10 energy. Now tagged 1-10 directly (s=10); older 5-step (s=5) and 3-step tags map onto it."""
    if g.get("s") == 10: return float(g["v"])
    if g.get("s") == 5: return T5[g["v"]]
    return {1: 2.0, 2: 5.5, 3: 9.0}[g["v"]]

def level(g):
    """Tag as one of the 5 steps (Low .. Peak) - the buckets the "within a step" score is judged on."""
    return int(np.digitize(target(g), [2.875, 4.625, 6.375, 8.125]) + 1)

def tag(tid, v, t=None):
    with _LOCK:
        g = TAGS.get(tid)
        # re-rating an older (3/5-step) tag keeps it as "prev", so clearing the new rating brings the old one back
        prev = g and (g.get("prev") or (None if g.get("s") == 10 else dict(g)))   # the whole original record
        if v in range(1, 11): TAGS[tid] = {"v": v, "s": 10, "t": time.time(), **({"file": t["file"], "artist": t["artist"], "title": t["title"]} if t else {}), **({"prev": prev} if prev else {})}
        elif prev: TAGS[tid] = prev
        else: TAGS.pop(tid, None)
        _write(TAGS_FILE, TAGS)
    if t and v in range(1, 11) and t.get("bpm") and not feats(t):   # analyse it now, not hours from now in the job
        def go():
            try:
                res = _one(t)
                with _LOCK: FEATS[nfc(t["file"])] = {**res, "sig": _sig(t["file"])}; _write(FEATS_FILE, FEATS)
            except Exception as _e: note("energy: analysing/saving a track's features", _e)
        threading.Thread(target=go, daemon=True).start()

def train(tracks):
    """tracks: setbuild.tracks() output (holds the old score). Returns the model summary or {'error'}."""
    global MODEL
    by = {t["id"]: t for t in tracks}
    with _LOCK: cs = [c for c in FEATS.values() if c.get("v") == V]   # snapshot: the job keeps adding
    allsegs = np.array([s for c in cs for s in c["segs"]])
    if len(allsegs) < 50: return {"error": "Energy analysis hasn't run yet"}
    rows = []
    for tid, g in TAGS.items():
        t = by.get(tid); c = t and feats(t)
        if c: rows.append({"id": tid, "label": level(g), "y": target(g), "x": np.percentile(np.array(c["segs"]), 75, axis=0).tolist(), "bpm": t["bpm"], "old": t.get("energy_old", t["energy"])})
    if len(rows) < 10 or not {1, 5} & {r["label"] for r in rows} or len({r["label"] for r in rows}) < 3: return {"error": "Tag at least 10 analysed tracks, from Low to Peak"}
    bpms = np.array([t["bpm"] for t in tracks if t.get("bpm")])
    names = cs[0]["names"]
    inp = {"rows": rows, "names": names, "mean": allsegs.mean(0).tolist(), "std": (allsegs.std(0) + 1e-6).tolist(),
           "bpm_mean": float(bpms.mean()), "bpm_std": float(bpms.std() or 1)}
    r = subprocess.run([str(AI_PY), str(TRAINER)], input=json.dumps(inp), cwd=str(AI_DIR), capture_output=True, text=True, timeout=600)
    line = next((l for l in r.stdout.splitlines()[::-1] if l.startswith("{")), None)
    if not line: return {"error": (r.stderr or "training failed")[-200:]}
    m = {**json.loads(line), "trained": time.time()}
    old, MODEL = MODEL, m
    lib = [s[0] for t in tracks if (s := score(t))]
    MODEL = old
    if lib: m["lib"] = {k: round(float(np.percentile(lib, q)), 1) for k, q in (("p5", 5), ("p50", 50), ("p95", 95))}
    with _LOCK: MODEL = m; _write(MODEL_FILE, m)
    return summary()

def summary():
    m = MODEL
    return {"tags": len(TAGS), "old_mids": sum(1 for g in TAGS.values() if legacy3(g) and g["v"] == 2),
            "old_tags": sum(1 for g in TAGS.values() if g.get("s") != 10), "min": MIN_TAGS, "active": active(), "job": JOB,
            "model": m and {k: m.get(k) for k in ("n", "new", "old", "with_bpm", "counts", "trained", "lib")}}

def _row(t):
    g = TAGS.get(t["id"])
    return {"id": t["id"], "artist": t["artist"], "title": t["title"], "bpm": t["bpm"],
            "start": max(setbuild.secs(t.get("mix_in")) or 0, .4 * t["dur"]),
            "now": None if t.get("energy_unknown") or t.get("energy") is None else round(float(t["energy"]), 1),   # what set building uses today
            **({"tag": g["v"] if g.get("s") == 10 else None, "was": round(target(g), 2)} if g else {})}

def queue(tracks, n=40, seed=None, mids=False, retag=False):
    """Untagged, analysed tracks spread across the score (low to high) so tags aren't all Peak.
    mids=True: tracks tagged Mid on the old 3-step scale. retag=True: tags not yet on the 1-10 scale, oldest first,
    so they can be re-rated (each row carries "was" = the old tag on the 1-10 scale)."""
    rnd = random.Random(seed)
    if mids or retag:
        pick = (lambda g: legacy3(g) and g["v"] == 2) if mids else (lambda g: g.get("s") != 10)
        out = sorted((t for t in tracks if (g := TAGS.get(t["id"])) and pick(g)), key=lambda t: TAGS[t["id"]].get("t", 0))[:n]
        return [_row(t) for t in out]
    pool = [t for t in tracks if t["id"] not in TAGS and feats(t)] or [t for t in tracks if t["id"] not in TAGS]
    pool.sort(key=lambda t: t["energy"])
    k = max(1, len(pool) // n); out = [rnd.choice(pool[i:i + k]) for i in range(0, len(pool), k)][:n]
    rnd.shuffle(out)
    return [_row(t) for t in out]
