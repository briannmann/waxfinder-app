"""Set builder: orders the tracks you've downloaded into a DJ set.

LOCAL ONLY. Nothing here touches YouTube: analysis reads the audio files on the stick, keys come from a
read-only copy of your Rekordbox library, previews use /play. No yt_dlp import, no network.

Analysis uses the AudioIntel analyser (BPM, key, sections, mix points) run in its own venv, plus gain-matched
features so energy compares across tracks. Results are cached by file path + size + mtime.
"""
import hashlib, json, math, os, random, re, shutil, subprocess, tempfile, threading, time, unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from paths import posix, safe_replace, note
import enginebin

HERE = Path(__file__).parent
CACHE_FILE = HERE / "set_analysis.json"
AI_DIR = Path.home() / "Tools/AudioIntel"
AI_PY = AI_DIR / ".venv/bin/python"
if not AI_PY.exists():   # no separate analyser install (every computer but the one it was written on): use the copy in analyser/ with this app's own Python
    import importlib.util, sys
    if all(importlib.util.find_spec(m) for m in ("librosa", "scipy")): AI_DIR, AI_PY = HERE / "analyser", Path(sys.executable)
WORKER = HERE / "tools/analyse_track.py"
RB_DB = Path.home() / "Library/Pioneer/rekordbox/master.db"
ANALYSIS_VERSION = 4

def nfc(x): return unicodedata.normalize("NFC", posix(x))
_LOCK = threading.Lock()
try: CACHE = json.loads(CACHE_FILE.read_text())
except Exception: CACHE = {}
FAILED = {}   # nfc(file) -> short reason, for files whose analysis raised (cleared when a later run succeeds)
JOB = {"state": "idle", "done": 0, "total": 0, "current": "", "errors": 0, "started": 0}

# ---------- library ----------
_STAT = {}      # path -> (checked at, (size, mtime) | None). A stat on the stick costs ~0.5 ms and pages check every
STAT_TTL = 30   # track many times per request (crates: 90k checks = 49 s). Every POST clears it (app.do_POST), so edits show at once.
def _stat(p):
    now = time.monotonic(); c = _STAT.get(p)
    if c and now - c[0] < STAT_TTL: return c[1]
    try: st = os.stat(p); v = (st.st_size, int(st.st_mtime))
    except OSError: v = None
    _STAT[p] = (now, v); return v

def forget_stats(): _STAT.clear()

def exists(p): return bool(p) and _stat(p) is not None

def _sig(p):
    v = _stat(p)
    if v is None: raise FileNotFoundError(p)
    return f"{v[0]}:{v[1]}"

def song_key(e):
    """Two copies of one song ('… (2)', double spaces) collapse to one key."""
    if e.get("rb"): return re.sub(r"[^a-z0-9]+", "", (e.get("artist", "") + e.get("rbtitle", "")).lower())   # linked Rekordbox track: names come from Rekordbox, not the filename
    stem = re.sub(r" \(\d+\)$", "", Path(e["file"]).stem)
    stem = re.sub(r"^[0-9a-f]{8}-", "", stem)
    return re.sub(r"[^a-z0-9]+", "", stem.lower())

def library(hist, offline=False):
    """Downloaded tracks that exist on disk, one per song (newest copy wins). offline=True also keeps tracks whose drive is unplugged
    but whose analysis is saved, so preparation (BPM/key/energy) stays visible; callers mark them unplayable."""
    seen, out = set(), []
    for e in sorted(hist, key=lambda e: -e.get("date", 0)):
        f = e.get("file")
        if not f or not (exists(f) or (offline and CACHE.get(nfc(f)))): continue
        k = song_key(e)
        if k in seen: continue
        seen.add(k); out.append(e)
    return out

def cached(e, offline=False):
    c = CACHE.get(nfc(e["file"]))
    if offline and c and not exists(e["file"]) and c.get("res"): return c["res"]   # drive unplugged: the saved analysis is still the best we know
    try:
        sig = _sig(e['file'])
        if not c or c['sig'] != sig: return None
        if c['res'].get('analysis_version', 0) < ANALYSIS_VERSION:
            # Reuse a newly verified AudioIntel result without deleting the
            # old library cache or recomputing unrelated features.
            size, mtime = sig.split(':')
            token = hashlib.sha1(f"{e['file']}|{size}|{mtime}|{ANALYSIS_VERSION}".encode()).hexdigest()
            fresh = AI_DIR / 'cache/tracks' / (token + '.json')
            if fresh.is_file():
                result = json.loads(fresh.read_text())
                if result.get('analysis_version') == ANALYSIS_VERSION:
                    c['res'] = {**c['res'], **result}
        return c['res']
    except OSError: return None
    except (ValueError, KeyError): return c.get('res') if c else None

def needs_analysis(e):
    a = cached(e, True)
    if a is None: return True
    if not AI_PY.exists(): return False   # no analyser on this machine (the Windows PC): keep the Mac's full results; only new files get tempo-only
    return a.get('analysis_version', 0) < ANALYSIS_VERSION

# ---------- Rekordbox keys (read-only copy) ----------
_RB = {"t": 0, "map": {}}
def rb_keys():
    if time.time() - _RB["t"] < 600: return _RB["map"]
    m = {}
    try:
        import logging; logging.getLogger("pyrekordbox").setLevel(logging.ERROR)
        from pyrekordbox.masterdb import MasterDatabase
        if RB_DB.exists():
            with tempfile.TemporaryDirectory() as d:
                for f in RB_DB.parent.glob("master.db*"):
                    if f.name in ("master.db", "master.db-wal", "master.db-shm"): shutil.copy2(f, Path(d) / f.name)
                db = MasterDatabase(path=str(Path(d) / "master.db"))
                share = RB_DB.parent / "share"
                for c in db.get_content().all():
                    if c.FolderPath and (c.KeyName or c.BPM):
                        row = {"key": c.KeyName, "bpm": (c.BPM or 0) / 100 or None}
                        if "Waxfinder" in c.FolderPath and c.AnalysisDataPath:   # Rekordbox's beat grid: first downbeat
                            try:
                                from pyrekordbox import AnlzFile
                                nums, bpms, times = AnlzFile.parse_file(share / str(c.AnalysisDataPath).lstrip("/")).get("beat_grid")
                                i = next(k for k, n in enumerate(nums) if n == 1)
                                bl = (float(times[-1]) - float(times[i])) / max(1, len(times) - 1 - i) if len(times) - i > 8 else 60 / float(bpms[i])
                                steady = float(max(bpms)) - float(min(bpms)) < 0.05   # one tempo through the track
                                row.update(first_beat=float(times[i]), grid_bpm=float(bpms[i]), beat_len=bl if steady else 60 / float(bpms[i]))
                            except Exception: pass
                        m[nfc(c.FolderPath)] = row
                db.close()
    except Exception as _e: note("setbuild: Rekordbox beat grids (using estimates)", _e)
    _RB.update(t=time.time(), map=m)
    return m

# ---------- analysis job ----------
def _analyse_one(path):
    if not AI_PY.exists():   # analyser not installed on this machine: tempo only, key unknown
        import bpm as tempo, imageio_ffmpeg
        b = tempo.estimate(imageio_ffmpeg.get_ffmpeg_exe(), path)
        return {"bpm": b, "fallback": True}
    env = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', VECLIB_MAXIMUM_THREADS='1', MKL_NUM_THREADS='1', NUMBA_NUM_THREADS='1', PYTHONUTF8='1', WF_RBX_CLI=str(enginebin.rbx_cli()))   # one core per track: parallel tracks, no thread fights
    r = subprocess.run([str(AI_PY), str(WORKER), path], cwd=str(AI_DIR), capture_output=True, text=True, timeout=600, env=env)
    line = next((l for l in r.stdout.splitlines()[::-1] if l.startswith("{")), None)
    if not line: raise RuntimeError((r.stderr or "no output")[-200:])
    return json.loads(line)

HIST_LOADER = None   # app.py sets this; lets a running job pick up files imported while it works

def start_analysis(hist):
    with _LOCK:
        if JOB["state"] == "working": JOB["again"] = True; return JOB
        todo = [e for e in library(hist) if needs_analysis(e)]
        JOB.update(state="working" if todo else "done", done=0, total=len(todo), current="", errors=0, started=time.time())
    if todo: threading.Thread(target=_run, args=(todo,), daemon=True).start()
    return JOB

def _run(todo):
    def work(e):
        JOB["current"] = Path(e["file"]).stem
        try:
            res = _analyse_one(e["file"])
            with _LOCK:
                k = nfc(e["file"]); old = CACHE.get(k)
                if not (res.get("fallback") and old and old.get("res") and not old["res"].get("fallback")):   # never trade a full result for tempo-only
                    CACHE[k] = {"sig": _sig(e["file"]), "res": res}
                    FAILED.pop(k, None)
                    tmp = CACHE_FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps(CACHE)); safe_replace(tmp, CACHE_FILE)   # atomic: user data
        except Exception as ex:
            JOB["errors"] += 1; FAILED[nfc(e["file"])] = (str(ex) or type(ex).__name__)[:120]
        JOB["done"] += 1
    with ThreadPoolExecutor(9) as ex: list(ex.map(work, todo))   # 9 of 10 cores (1 left for the server)
    with _LOCK:
        again = JOB.pop("again", False) and HIST_LOADER
        more = [e for e in library(HIST_LOADER()) if needs_analysis(e) and e["file"] not in {x["file"] for x in todo}] if again else []
        if more: JOB.update(total=JOB["total"] + len(more))
        else: JOB.update(state="done", current="")
    if more: _run(more)   # files imported mid-run (failed ones from this run are not retried here)

# ---------- music helpers ----------
NOTES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
ALIAS = {"C#": "Db", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb"}
CAM_MAJ = {0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B", 6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B"}
CAM_MIN = {9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A", 3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A"}

def camelot(k):
    if not k: return None
    if re.fullmatch(r"\d{1,2}[AB]", k): return k
    minor = k.endswith("m"); root = ALIAS.get(k[:-1] if minor else k, k[:-1] if minor else k)
    if root not in NOTES: return None
    return (CAM_MIN if minor else CAM_MAJ)[NOTES.index(root)]

def relation(a, b):
    if not a or not b: return "unknown"
    na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    step = min((na - nb) % 12, (nb - na) % 12)
    if a == b: return "same key"
    if la == lb and step == 1: return "next key"
    if na == nb: return "relative key"
    if la != lb and step == 1: return "diagonal"
    if la == lb and step == 2: return "energy boost"
    return "key clash"
KEYC = {"same key": 0, "next key": .3, "relative key": .3, "diagonal": .6, "energy boost": 1.0, "key clash": 2.5, "unknown": .6}

def secs(t):
    try:
        p = [float(x) for x in str(t).split(":")]
        return p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]
    except Exception: return None

def mmss(s): s = int(round(s)); return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"

def fold(b, lo, hi):
    """Half/double-time reads land back in range."""
    if not b: return b
    for x in (b, b * 2, b / 2):
        if lo - 6 <= x <= hi + 6: return x
    return b

# ---------- tracks ready for building ----------
def tracks(hist):
    import rbxkeys
    rb = rb_keys(); out = []
    for e in library(hist, True):
        a = cached(e, True)
        if not a: continue
        r = rb.get(nfc(e["file"]), {})
        b = a.get("bpm") or r.get("bpm")
        if not b: continue
        if r.get("key"): cam, conf, ksrc = camelot(r["key"]), 1.0, "rekordbox"
        elif rbxkeys.get(e["id"]): cam, conf, ksrc = camelot(rbxkeys.get(e["id"])), .75, "rbxport"   # measured 70% exact vs Rekordbox (AudioIntel 38%)
        else: cam, conf, ksrc = camelot(a.get("camelot") or a.get("key")), {"high": .9, "medium": .6, "low": .35}.get(a.get("key_confidence"), .35), "analysis"
        dur = secs(a.get("duration")) or e.get("duration") or 300
        mi, mo = secs(a.get("mix_in")) or 0, secs(a.get("mix_out")) or dur
        bar = 4 * 60 / b
        play = (mo - mi) if (mi > 4 or mo < dur - 10) else dur
        play = max(90, play - 16 * bar)                       # overlap with the next track
        stem = re.sub(r" \(\d+\)$", "", Path(e["file"]).stem); stem = re.sub(r"^[0-9a-f]{8}-", "", stem)
        artist, _, title = stem.partition(" - ")
        if e.get("rb"): artist, title = e.get("artist") or "", e.get("rbtitle") or stem
        grid = {"first_beat": r["first_beat"], "grid_bpm": r.get("grid_bpm") or r.get("bpm"), "beat_len": r.get("beat_len")} if r.get("first_beat") is not None else None
        out.append({"id": e["id"], "file": e["file"], "here": exists(e["file"]), "grid": grid, "level_db": a.get("level_db"), "artist": artist.strip() if title else "", "title": (title or stem).strip(),
                    "bpm": round(b, 2), "bpm_ana": a.get("bpm"), "bpm_rb": r.get("grid_bpm") or r.get("bpm"), "bpm_confidence": a.get('bpm_confidence', 'unverified'), "cam": cam, "kconf": conf, "ksrc": ksrc, "dur": dur, "play": play,
                    "mix_in": a.get("mix_in"), "mix_out": a.get("mix_out"), "feel": a.get("feel"),
                    "feats": a.get("feats"), "curve": a.get("energy_per_8_bars")})
    import trackedit, bpmedit; trackedit.apply(out); bpmedit.apply(out)   # names + BPM overrides set in the Library (right-click)
    if tracks_need_energy(out):
        import statistics as st
        def z(vals):
            m, s = st.mean(vals), (st.pstdev(vals) or 1); return [max(-2, min(2, (v - m) / s)) for v in vals]
        have = [t for t in out if t["feats"] and t["feats"].get("flux")]   # all-zero readings = failed, not quiet
        if len(have) >= 3:
            cols = {k: z([t["feats"][k] for t in have]) for k in ("flux", "onset_rate", "low", "high")}
            zb = z([t["bpm"] for t in have])
            raw = [cols["flux"][i] + cols["onset_rate"][i] + .5 * cols["low"][i] + .5 * cols["high"][i] + .5 * zb[i] for i in range(len(have))]
            lo, hi = min(raw), max(raw)
            for t, r in zip(have, raw): t["energy"] = round(1 + 9 * (r - lo) / ((hi - lo) or 1), 1)
    for t in out: t.setdefault("energy", 5.0)
    try:   # the trained (Mixed In Key style) score takes over once it beats the old one on your tags
        import energy
        if energy.active():
            for t in out:
                t["energy_old"] = t["energy"]; sc = energy.score(t)
                if sc: t["energy"], t["curve"] = sc[0], " ".join(map(str, sc[1]))
                else: t["energy"], t["energy_unknown"] = energy.median(), True
    except Exception as _e: note("setbuild: trained energy score (using fallback)", _e)
    global _SND
    try:   # sound fingerprints (soundindex, lazy import: it imports this module) -> t["sv"] unit vector or None
        import soundindex
        _SND = soundindex.matrix(hist)
        for t in out:
            j = _SND["idx"].get(t["id"]); t["sv"] = _SND["V"][j] if j is not None else None
    except Exception:
        _SND = None
        for t in out: t["sv"] = None
    return out

_SND = None
_PP = None   # build(): pct for every pair in the pool, computed once (12k annealing steps would otherwise redo dot products)
def sound_pct(a, b):
    """How alike two tracks sound, 0-100 on this library's scale; None until both are fingerprinted."""
    if _PP is not None and "si" in a and "si" in b: return _PP[a["si"]][b["si"]]
    if _SND is None or a.get("sv") is None or b.get("sv") is None: return None
    import soundindex
    return soundindex.pct(float(a["sv"] @ b["sv"]), _SND)

def tracks_need_energy(ts): return any(t.get("feats") for t in ts)

# ---------- the set ----------
SLOTS = {   # default BPM run and energy band for each slot
    "warmup":  {"bpm": (116, 122), "e": (2.0, 6.0)},
    "peak":    {"bpm": (122, 128), "e": (5.0, 9.5)},
    "closing": {"bpm": (125, 118), "e": (7.0, 3.5)},
    "allnight": {"bpm": (116, 127), "e": (2.0, 9.0)},
}
def shape_fn(shape, x):
    if shape == "waves": return min(1, max(0, .15 + .6 * x + .25 * math.sin(2 * math.pi * 2.5 * x)))
    if shape == "peak": return x / .7 if x < .7 else 1 - (x - .7) / .3 * .45
    return x   # slow build

def transition_cost(a, b, key_w):
    d = (b["bpm"] - a["bpm"]) / a["bpm"] * 100
    bpm = 1.5 * max(0, abs(d) - 3) + (1.2 * (abs(d) - 1) if d < -1 else 0) + (6 if d < -2.5 else 0) + (10 if abs(d) > 6 else 0)
    rel = relation(a["cam"], b["cam"])
    key = KEYC[rel] * key_w * min(a["kconf"], b["kconf"])
    de = abs(b["energy"] - a["energy"])
    jump = 2.0 * max(0, de - 2) ** 2 + .5 * max(0, de - 1.2)
    same = 3 if a["artist"] and a["artist"].lower() == b["artist"].lower() else 0
    sp = sound_pct(a, b)
    sound = 0 if sp is None else 1.6 * (1 - sp / 100)   # tracks that sound alike blend better (typical pair +0.8, close pair ~+0.15)
    return bpm + key + jump + same + sound

def build(hist, hours=2.0, slot="peak", shape="build", bpm_start=None, bpm_end=None, keys="relaxed", must=(), exclude=(), seed=1, start=None, only=None, bpm_mode=None):
    T = tracks(hist)
    free = bpm_mode == "ignore"   # no BPM range or target; neighbours still avoid big tempo jumps (transition_cost)
    if only is not None: T = [t for t in T if t["id"] in set(only)]   # build from one crate
    anchor = next((t for t in T if t["id"] == start), None) if start else None
    target = max(1.0, min(3.0, float(hours))) * 3600
    sd = SLOTS.get(slot, SLOTS["peak"])
    b0, b1 = (float(bpm_start), float(bpm_end)) if bpm_start and bpm_end else sd["bpm"]
    if anchor and not (bpm_start and bpm_end): b0 = anchor["bpm"]          # the set grows out of your opening track
    lo, hi = min(b0, b1), max(b0, b1)
    e0, e1 = sd["e"]
    if anchor: e0 = anchor["energy"]
    key_w = {"strict": 2.0, "relaxed": 1.0, "ignore": 0.0}.get(keys, 1.0)
    must, exclude = set(must or ()), set(exclude or ())
    if anchor: must.add(anchor["id"]); exclude.discard(anchor["id"])
    for t in T: t["bpm_use"] = t["bpm"] if free else fold(t["bpm"], lo, hi)
    pool = [t for t in T if t["id"] not in exclude and (only is not None or free or t["id"] in must or lo - 4 <= t["bpm_use"] <= hi + 4)]
    for t in pool: t["bpm"] = t["bpm_use"]
    global _PP
    _PP = None
    if _SND is not None and pool:
        import soundindex, numpy as np
        V = np.array([t["sv"] if t.get("sv") is not None else np.zeros(_SND["V"].shape[1], np.float32) for t in pool], dtype=np.float32)
        P = soundindex.pct_matrix(V @ V.T, _SND)
        miss = [k for k, t in enumerate(pool) if t.get("sv") is None]
        P[miss, :] = np.nan; P[:, miss] = np.nan
        for k, t in enumerate(pool): t["si"] = k
        _PP = [[None if v != v else float(v) for v in row] for row in P.tolist()]   # plain lists: ~10x faster lookups than numpy scalars
    available = sum(t["play"] for t in pool)
    if not pool: return {"tracks": [], "available": 0, "target": target, "note": "No analysed tracks in that BPM range yet."}

    def cost(order):
        c, tm, total = 0.0, 0.0, sum(t["play"] for t in order) or 1
        for k, t in enumerate(order):
            x = (tm + t["play"] / 2) / total
            eT = e0 + (e1 - e0) * shape_fn(shape, x) if e1 >= e0 else e0 - (e0 - e1) * shape_fn("build", x)
            bT = b0 + (b1 - b0) * x
            c += .35 * (t["energy"] - eT) ** 2 + (0 if free else .06 * (t["bpm"] - bT) ** 2)
            if k: c += transition_cost(order[k - 1], t, key_w)
            tm += t["play"]
        if anchor and order and order[0]["id"] != anchor["id"]: c += 1000      # your opener stays first
        dev = abs(total - target) / target
        c += 0 if dev <= .05 else 400 * (dev - .05) ** 2 * len(order) + (8 * len(order) if total < target * .95 and unused_fit(order) else 0)
        return c

    def unused_fit(order):
        ids = {t["id"] for t in order}
        return any(t["id"] not in ids for t in pool)

    rnd = random.Random(seed)
    order = sorted(pool, key=lambda t: t["bpm"] + rnd.random())
    order = [t for t in order if t["id"] in must] + [t for t in order if t["id"] not in must]
    cur = []
    for t in order:   # greedy fill to the target length
        if sum(x["play"] for x in cur) < target or t["id"] in must: cur.append(t)
    cur.sort(key=lambda t: (t["energy"] if e1 >= e0 else -t["energy"]) + rnd.random())
    if anchor:
        cur = [t for t in cur if t["id"] != anchor["id"]]; cur.insert(0, next(t for t in pool if t["id"] == anchor["id"]))
    best, bc = cur[:], cost(cur); cc = bc; temp = 5.0
    steps = 12000
    for it in range(steps):
        new = cur[:]; mv = rnd.random(); unused = [t for t in pool if t not in new]
        if mv < .4 and len(new) > 1:
            i, j = rnd.sample(range(len(new)), 2); new[i], new[j] = new[j], new[i]
        elif mv < .7 and len(new) > 1:
            i, j = rnd.sample(range(len(new)), 2); new.insert(j, new.pop(i))
        elif mv < .85 and unused:
            i = rnd.randrange(len(new))
            if new[i]["id"] in must: continue
            new[i] = rnd.choice(unused)
        elif mv < .93 and unused:
            new.insert(rnd.randrange(len(new) + 1), rnd.choice(unused))
        elif len(new) > 2:
            i = rnd.randrange(len(new))
            if new[i]["id"] in must: continue
            new.pop(i)
        nc = cost(new)
        if nc < cc or rnd.random() < math.exp((cc - nc) / max(temp, 1e-3)):
            cur, cc = new, nc
            if cc < bc: best, bc = cur[:], cc
        temp = 5.0 * (1 - it / steps) + .02

    res = describe(best); tm = res["total_s"]
    short = tm < target * .95
    res.update({"target": target, "available": available, "available_h": mmss(available),
            "bpm_range": None if free else [b0, b1], "note": (f"Built {mmss(tm)} of {mmss(target)}: that's everything in the crates you picked." if only is not None else
                     f"Built {mmss(tm)} of {mmss(target)}: that's all your analysed music." if free else
                     f"Built {mmss(tm)} of {mmss(target)}: that's all the music you have that fits "
                     f"{int(lo)}–{int(hi)} BPM. Download more in this range or widen it.") if short else None})
    return res

def describe(best):
    """Rows for the set list (start times, transition notes) for tracks in a fixed order."""
    out, tm = [], 0.0
    for k, t in enumerate(best):
        nxt = best[k + 1] if k + 1 < len(best) else None
        note = None
        if nxt:
            rel = relation(t["cam"], nxt["cam"]); d = nxt["bpm"] - t["bpm"]
            sp = sound_pct(t, nxt)
            note = {"key": rel, "bpm": round(d, 1), "energy": round(nxt["energy"] - t["energy"], 1), "sound": None if sp is None else round(sp),
                    "tip": "mix on the drums, keep the blend short" if rel == "key clash" else
                           "long blend" if rel in ("same key", "next key", "relative key") else "medium blend"}
        out.append({"id": t["id"], "artist": t["artist"], "title": t["title"], "bpm": round(t["bpm"], 1), "key": t["cam"],
                    "key_sure": t["ksrc"] == "rekordbox" or t["kconf"] >= .9, "key_src": t["ksrc"], "energy": t["energy"],
                    "start": mmss(tm), "length": mmss(t["dur"]), "mix_in": t["mix_in"], "mix_out": t["mix_out"],
                    "feel": t["feel"], "curve": t["curve"], "next": note})
        tm += t["play"]
    return {"tracks": out, "total": mmss(tm), "total_s": tm}

def export(hist, ids, name, out_dir):
    by = {e["id"]: e for e in hist}
    name = re.sub(r'[\\/:*?"<>|]+', " ", name).strip()[:80] or "Waxfinder set"
    d = Path(out_dir) / "Sets"; d.mkdir(exist_ok=True)
    f = d / f"{name}.m3u8"
    lines = ["#EXTM3U"]
    for i in ids:
        e = by.get(i)
        if not e or not os.path.exists(e["file"]): continue
        a = cached(e) or {}
        lines.append(f"#EXTINF:{int(secs(a.get('duration')) or e.get('duration') or 0)},{Path(e['file']).stem}")
        lines.append(e["file"])
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return posix(f)

# ---------- waveform for the deck scrubber (local file, cached) ----------
WAVE_DIR = HERE / "wave_cache"
def wave_cached(e):
    try: return (WAVE_DIR / f"{e['id']}-{_sig(e['file']).replace(':', '_')}.json").exists()
    except OSError: return False   # file gone or stick unplugged

def wave(e, bins=800):
    """Overview waveform: per-column peak of the full signal and of the bass (<150 Hz), plus the analyser's sections."""
    import numpy as np, imageio_ffmpeg
    WAVE_DIR.mkdir(exist_ok=True)
    cf = WAVE_DIR / f"{e['id']}-{_sig(e['file']).replace(':', '_')}.json"
    if cf.exists(): return json.loads(cf.read_text())
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    out = subprocess.run([ff, "-v", "error", "-nostdin", "-i", e["file"], "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
                         capture_output=True, timeout=120).stdout
    full = np.frombuffer(out, dtype=np.float32)   # ONE decode; the bass is filtered from it (was a second full decode)
    spec = np.fft.rfft(full)
    spec *= 1.0 / (1.0 + (np.fft.rfftfreq(len(full), 1 / 8000) / 150.0) ** 4)   # two cascaded 2-pole 150 Hz low-passes
    low = np.fft.irfft(spec, len(full)).astype(np.float32); del spec
    n = min(len(full), len(low))
    if n < bins: raise RuntimeError("audio too short")
    def cols(x):
        x = np.abs(x[: n - n % bins]).reshape(bins, -1)
        return np.sqrt((x ** 2).mean(axis=1))
    pk, bs = cols(full), cols(low)
    top = max(float(pk.max()), 1e-6)
    a = cached(e) or {}
    dur = n / 8000
    secs_list = []
    for part in (a.get("sections") or "").split("|"):
        bits = part.split()
        if len(bits) >= 2 and secs(bits[1]) is not None: secs_list.append({"label": bits[0], "start": secs(bits[1])})
    for i, s in enumerate(secs_list): s["end"] = secs_list[i + 1]["start"] if i + 1 < len(secs_list) else dur
    res = {"duration": dur, "peaks": [round(float(v) / top, 3) for v in pk], "bass": [round(min(1.0, float(v) / top * 1.6), 3) for v in bs],
           "sections": secs_list}
    cf.write_text(json.dumps(res))
    return res

# hi2 file name -> (kick_phase, phase_bpm). Each hi2 file is ~270 KB and /set/library needs one float from each, so the
# floats are kept here and in wave_cache/kick_index.json (derived, disposable): a restart no longer re-reads 400 MB.
KICK_FILE = WAVE_DIR / "kick_index.json"
try: _KICK = {k: tuple(v) for k, v in json.loads(KICK_FILE.read_text()).items()}
except (OSError, ValueError, TypeError): _KICK = {}
_KICK_NEW = [0]
def save_kicks():
    if not _KICK_NEW[0]: return
    _KICK_NEW[0] = 0
    try: tmp = KICK_FILE.with_suffix(".tmp"); tmp.write_text(json.dumps(_KICK)); safe_replace(tmp, KICK_FILE)
    except OSError: pass
def hi_kick(e):
    """kick_phase from the cached detailed waveform, or None if it isn't made yet (never computes it)."""
    try: cf = WAVE_DIR / f"hi2-{e['id']}-{_sig(e['file']).replace(':', '_')}.json"
    except OSError: return None
    k = _KICK.get(cf.name)
    if k is None:
        try: r = json.loads(cf.read_text())
        except (OSError, ValueError): return None
        k = _KICK[cf.name] = (r.get("kick_phase"), r.get("phase_bpm", 0)); _KICK_NEW[0] += 1
    a = cached(e) or {}
    import bpmedit
    if a.get('analysis_version', 0) >= ANALYSIS_VERSION and a.get('bpm') and abs(float(k[1] or 0) - (bpmedit.get(e['id']) or a['bpm'])) > .1: return None
    return k[0]

def hi_made(e):
    """Is there a detailed waveform file for this exact file version? (an exists check, no parsing)"""
    try: return (WAVE_DIR / f"hi2-{e['id']}-{_sig(e['file']).replace(':', '_')}.json").exists()
    except OSError: return False

def hi_cached(e):
    """The detailed waveform if it was already made (never computes it)."""
    try:
        cf = WAVE_DIR / f"hi2-{e['id']}-{_sig(e['file']).replace(':', '_')}.json"   # inside the try: a missing file/unplugged stick means "not made", not a crash
        if not cf.exists(): return None
        result = json.loads(cf.read_text())
        a = cached(e) or {}
        if a.get('analysis_version', 0) >= ANALYSIS_VERSION and a.get('bpm'):
            import bpmedit
            if abs(float(result.get('phase_bpm', 0)) - (bpmedit.get(e['id']) or a['bpm'])) > .1: return None
        return result
    except (OSError, ValueError): return None

def wave_hi(e, bpm=None, first_beat=None):
    """Detailed waveform for the scrolling beat view: 100 columns a second (peak + bass), plus a kick-based
    first-beat estimate for tracks Rekordbox hasn't gridded."""
    import numpy as np, imageio_ffmpeg
    WAVE_DIR.mkdir(exist_ok=True)
    cf = WAVE_DIR / f"hi2-{e['id']}-{_sig(e['file']).replace(':', '_')}.json"
    existing = hi_cached(e)
    if existing is not None: return existing
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    def dec(extra):
        out = subprocess.run([ff, "-v", "error", "-nostdin", "-i", e["file"], *extra, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
                             capture_output=True, timeout=120).stdout
        return np.frombuffer(out, dtype=np.float32)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:   # the two decodes run side by side (identical output, about half the wait)
        fa, fb = ex.submit(dec, []), ex.submit(dec, ["-af", "lowpass=f=120,lowpass=f=120"])
        full, low = fa.result(), fb.result()
    n = min(len(full), len(low)) // 80 * 80                      # 80 samples = 10 ms at 8 kHz
    pk = np.abs(full[:n]).reshape(-1, 80).max(axis=1)
    bs = np.sqrt((low[:n].reshape(-1, 80) ** 2).mean(axis=1))
    top = max(float(np.percentile(pk, 99.5)), 1e-6); btop = max(float(np.percentile(bs, 99.5)), 1e-6)
    res = {"rate": 100, "peaks": [min(99, int(v / top * 99)) for v in pk], "bass": [min(99, int(v / btop * 99)) for v in bs]}
    if bpm:   # kick phase: where on the beat grid the bass hits land hardest (first 60 s of steady beat)
        # kick = sharp hit in the sub AND a click across the full signal; an offbeat bassline only has the first
        fl = np.sqrt((full[:n].reshape(-1, 80) ** 2).mean(axis=1))
        eb = np.maximum(np.diff(bs, prepend=bs[0]), 0); ef = np.maximum(np.diff(fl, prepend=fl[0]), 0)
        env = eb / (eb.mean() + 1e-9) + ef / (ef.mean() + 1e-9)
        bl = 60.0 / bpm * 100
        best, bo = -1, 0.0
        for off in np.arange(0, bl, 0.5):
            idx = (off + bl * np.arange(int(min(len(env), 9000) / bl))).astype(int)
            idx = idx[idx < len(env)]
            sc = env[idx].sum()
            if sc > best: best, bo = sc, off
        res["kick_phase"] = round(bo / 100, 3)
        res['phase_bpm'] = float(bpm)
    cf.write_text(json.dumps(res))
    return res
