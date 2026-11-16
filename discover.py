"""Discovery beyond YouTube, DigDeeper-style: the SOURCES find candidates around your tracks, the SOUND decides.
Sources: SoundCloud (a seed's related tracks), Bandcamp (the labels/artists behind a seed, their newest releases),
Discogs (the seed's label, its newest releases, their linked YouTube videos). Every candidate's audio is fingerprinted with
the same Discogs-EffNet model as the library and scored against your closest library tracks (library-relative %).
Runs in the background only (never inside build_recs); results live in discover.json (a growing catalogue: NEVER wipe).
Rate limits: YouTube lookups go through one paced lane (8 s apart, none during the cool-down), Discogs calls 3 s apart,
Bandcamp/SoundCloud kept to a handful per seed; a failing source is skipped for that run."""
import base64, hashlib, json, os, random, re, subprocess, threading, time, urllib.parse, urllib.request
from pathlib import Path
from paths import safe_replace
from itertools import zip_longest
import numpy as np
import setbuild, soundindex, feedback, traxsource, discogs_api, ownership
from pickrules import excluded_pick

HERE = Path(__file__).parent
FILE = HERE / "discover.json"
PREV = HERE / "preview_cache"            # disposable MP3 previews for SoundCloud/Bandcamp picks
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
UA_DISCOGS = "Waxfinder/1.0 (personal DJ library tool)"
SEEDS_PER_RUN, FP_CAP, YT_CAP, SC_RETRY_CAP = 3, 40, 6, 8
SRC_NAME = {"soundcloud": "SoundCloud", "bandcamp": "Bandcamp", "discogs": "Discogs", "traxsource": "Traxsource"}

_LOCK = threading.Lock()
STATE = {"state": "idle", "step": "", "found": 0, "scored": 0, "ts": 0, "log": []}
try: DB = json.loads(FILE.read_text())
except Exception: DB = {}
DB.setdefault("cands", {}); DB.setdefault("rot", 0)

# set by app.py: YouTube stream resolver + cool-down check (shared with the rest of the app)
YT_RESOLVE = None
YT_COOL = lambda: False
OWNED_LOADER = None
_last_yt = [0.0]
_preview_locks = {}


def _save():
    tmp = FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps(DB)); safe_replace(tmp, FILE)


def _log(msg):
    STATE["log"] = (STATE["log"] + [time.strftime("%H:%M:%S ") + msg])[-40:]


def cid(src, key): return src[:2] + ":" + hashlib.md5(key.encode()).hexdigest()[:12]


def _http(url, data=None, headers=None, timeout=20):
    h = {"User-Agent": UA, **(headers or {})}
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _key(artist, title): return re.sub(r"[^a-z0-9]+", "", f"{artist}{title}".lower())


def clean_title(artist, title):
    title = (title or "").strip()
    if artist:
        pattern = re.compile(r"^" + re.escape(artist.strip()) + r"\s+[-–—]\s+", re.I)
        while pattern.match(title): title = pattern.sub("", title, count=1)
    return title


def _sc_playable(track):
    if track.get("policy") in ("BLOCK", "SNIP") or track.get("streamable") is False: return False
    return any(t.get("url") and not t.get("snipped") and not t.get("preset", "").startswith("abr")
               and not t.get("format", {}).get("protocol", "").startswith(("ctr-", "cbc-"))
               for t in track.get("media", {}).get("transcodings", []))


# ---------------- sources (each returns candidate dicts; no audio yet) ----------------
def from_soundcloud(seed, n=10):
    import yt_dlp
    out = []
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "no_warnings": True, "extract_flat": True}) as y:
        hit = (y.extract_info(f"scsearch1:{seed['artist']} {seed['title']}", download=False).get("entries") or [None])[0]
        if not hit or not hit.get("id"): return out
        # Flat yt-dlp entries discard policy/transcoding data. Inspect the raw related-track response
        # using its native API client so Go+ / DRM / 30-second snippets never enter the listening budget.
        ie = y.get_info_extractor("Soundcloud"); ie.initialize()
        rel = ie._call_api(ie._API_V2_BASE + f"tracks/{hit['id']}/related", hit["id"],
                           query={"limit": min(50, n * 3)}, headers=ie._HEADERS)
        for e in rel.get("collection") or []:
            u = e.get("permalink_url")
            if not u or not _sc_playable(e): continue
            duration = (e.get("duration") or 0) / 1000
            if not 60 <= duration <= 1200: continue
            out.append({"id": cid("soundcloud", u), "src": "soundcloud", "page": u, "title": e.get("title") or "",
                        "artist": (e.get("publisher_metadata") or {}).get("artist") or "",
                        "label": (e.get("user") or {}).get("username") or "", "dur": duration})
            if len(out) >= n: break
    return out


def from_bandcamp(seed, albums=2, per_album=4):
    import yt_dlp
    body = json.dumps({"search_text": seed["artist"], "search_filter": "", "full_page": False, "fan_id": None}).encode()
    res = json.loads(_http("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic", body, {"Content-Type": "application/json"}))
    roots = []
    for r in res.get("auto", {}).get("results", []):
        root = r.get("item_url_root")
        if root and root not in roots: roots.append(root)
    out = []
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "no_warnings": True}) as y:
        for root in roots[:2]:                                   # the artist page and/or the label behind them
            page = y.extract_info(root + "/", download=False, process=False)
            for alb in list(page.get("entries") or [])[:albums]:
                a = y.extract_info(alb["url"], download=False)
                label = a.get("uploader") or a.get("artist") or root.split("//")[1].split(".")[0]
                for t in (a.get("entries") or [])[:per_album]:
                    url = t.get("webpage_url")
                    if not url: continue
                    out.append({"id": cid("bandcamp", url), "src": "bandcamp", "page": url, "artist": t.get("artist") or "",
                                "title": clean_title(t.get("artist"), t.get("track") or t.get("title")), "label": label, "dur": t.get("duration"),
                                "release": a.get("title")})
    return out


def _discogs(path):
    return discogs_api.get(path)   # shared authenticated pacing with library tags


def from_discogs(seed, releases=4):
    q = urllib.parse.quote(f"{seed['artist']} {seed['title']}")
    hits = _discogs(f"/database/search?q={q}&type=release&per_page=5").get("results") or []
    if not hits: return []
    rel = _discogs(f"/releases/{hits[0]['id']}")
    labels = rel.get("labels") or []
    if not labels: return []
    lab = labels[0]
    lr = _discogs(f"/labels/{lab['id']}/releases?sort=year&sort_order=desc&per_page=12").get("releases") or []
    out = []
    for r in [x for x in lr if x.get("id") != hits[0]["id"]][:releases]:
        d = _discogs(f"/releases/{r['id']}")
        for v in (d.get("videos") or [])[:2]:
            m = re.search(r"(?:v=|youtu\.be/)([\w-]{11})", v.get("uri") or "")
            if not m: continue
            out.append({"id": m.group(1), "src": "discogs", "page": "https://www.youtube.com/watch?v=" + m.group(1), "yt": m.group(1),
                        "title": v.get("title") or "", "artist": r.get("artist") or "", "label": lab.get("name") or "",
                        "dur": v.get("duration"), "release": d.get("title")})
    return out


def from_traxsource(seed): return traxsource.candidates(seed, _http, cid)


SOURCES = [("soundcloud", from_soundcloud), ("bandcamp", from_bandcamp), ("discogs", from_discogs), ("traxsource", from_traxsource)]


# ---------------- audio for fingerprinting / previews ----------------
def audio_url(c):
    """(url, headers, duration, full_info) for a candidate's audio, resolved fresh (stream links expire)."""
    if c["src"] == "traxsource": return traxsource.audio(c, _http)
    if c["src"] == "discogs":
        if YT_COOL() or not YT_RESOLVE: return None
        wait = 8 - (time.time() - _last_yt[0])
        if wait > 0: time.sleep(wait)
        _last_yt[0] = time.time()
        url, hdrs, _ = YT_RESOLVE(c["yt"])
        return url, hdrs, c.get("dur"), None
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "no_warnings": True}) as y:
        i = y.extract_info(c["page"], download=False)
    formats = i.get("requested_formats") or i.get("requested_downloads") or i.get("formats") or []
    f = i if i.get("url") else next((f for f in reversed(formats) if f.get("url") and not f.get("has_drm")
                                                   and f.get("vcodec") in (None, "none")), {})
    url = f.get("url")
    if not url: return None
    return url, {**(i.get("http_headers") or {}), **(f.get("http_headers") or {})}, i.get("duration") or c.get("dur"), i


def _preview_path(c): return PREV / (re.sub(r"[^\w]", "_", c["id"]) + ".mp3")


def preview_file(c, resolved=None):
    """Local MP3 copy for the browser (SoundCloud is HLS-only; Bandcamp links expire). Cached; oldest trimmed past 500 MB."""
    with _LOCK: lock = _preview_locks.setdefault(c["id"], threading.Lock())
    with lock: return _preview_file(c, resolved)


def _preview_file(c, resolved=None):
    PREV.mkdir(exist_ok=True)
    f = _preview_path(c)
    if f.exists() and f.stat().st_size > 10000: return f
    got = resolved or audio_url(c)
    if not got: return None
    url, hdrs, _, _ = got
    import imageio_ffmpeg
    hdr = ["-headers", "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())] if hdrs else []
    tmp = f.with_suffix(".part.mp3")
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-v", "error", "-nostdin", *hdr, "-i", url, "-vn", "-ac", "2",
                    "-c:a", "libmp3lame", "-b:a", "160k", str(tmp)], check=True, timeout=240)
    os.replace(tmp, f)
    files = sorted(PREV.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
    while sum(p.stat().st_size for p in files) > 500 * 1024 ** 2 and len(files) > 1: files.pop(0).unlink(missing_ok=True)
    return f


def fingerprint_audio(c):
    """SoundCloud's segmented streams can play but fail remote seeking. Sample one local preview instead."""
    if c["src"] == "traxsource":
        cached = preview_file(c)
        if not cached: return None
        return str(cached.resolve()), {}, traxsource.preview_duration(cached), {"preview_only": True}
    if c["src"] == "soundcloud" and c.get("dur"):
        cached = _preview_path(c)
        if cached.exists() and cached.stat().st_size > 10000:
            return str(cached.resolve()), {}, c["dur"], None
    got = audio_url(c)
    if not got or c["src"] != "soundcloud": return got
    _, _, duration, info = got
    if not duration or not 60 <= duration <= 1200: return got
    cached = preview_file(c, resolved=got)
    return (str(cached.resolve()), {}, duration, info) if cached else None


# ---------------- scoring ----------------
def _vec(b64): return np.frombuffer(base64.b64decode(b64), dtype=np.float16).astype(np.float32)


def score(c, hist):
    m = soundindex.matrix(hist)
    if c.get("v") is None or not len(m["V"]): return
    v = _vec(c["v"]); v /= (np.linalg.norm(v) or 1)
    s = m["V"] @ v
    top = np.argsort(-s)[:3]
    c["pct"] = round(soundindex.pct(float(s[top].mean()), m))          # how well it fits your library
    c["like_id"] = m["ids"][int(top[0])]; c["like_pct"] = round(soundindex.pct(float(s[top[0]]), m))


# ---------------- the background run ----------------
def _seeds(hist, k):
    ts = [t for t in setbuild.tracks(hist) if t.get("artist")]
    ts.sort(key=lambda t: -next((e.get("date", 0) for e in hist if e["id"] == t["id"]), 0))
    if not ts: return []
    r = DB["rot"] % len(ts); DB["rot"] = r + k
    return [{"id": t["id"], "artist": t["artist"], "title": re.sub(r"\s*[\(\[].*$", "", t["title"]).strip() or t["title"]}
            for t in (ts[r:] + ts[:r])[:k]]


def start(hist, seeds=None, source_names=None):
    if source_names is not None and (not isinstance(source_names, (list, tuple)) or not source_names
                                    or any(not isinstance(name, str) or name not in SRC_NAME for name in source_names)):
        raise ValueError("Choose a known discovery source")
    if not soundindex.available(): return STATE
    with _LOCK:
        if STATE["state"] == "working": return STATE
        STATE.update(state="working", step="starting", found=0, scored=0, ts=time.time())
    threading.Thread(target=_run, args=(hist, seeds, source_names), daemon=True).start()
    return STATE


def _run(hist, seeds, source_names=None):
    try:
        owned = OWNED_LOADER() if OWNED_LOADER else ownership.Index([*hist, *setbuild.tracks(hist)])
        seeds = seeds or _seeds(hist, SEEDS_PER_RUN)
        # Recover a bounded batch rejected by the old remote-seek decoder, even after the seed rotates.
        with _LOCK:
            retry = [dict(c) for c in DB["cands"].values() if c["src"] == "soundcloud"
                     and c.get("err") == "no audio" and not c.get("v") and not excluded_pick(c)][:SC_RETRY_CAP] if source_names is None or "soundcloud" in source_names else []
        new = []
        for c in retry:
            c.pop("err", None); c["found"] = time.time(); new.append(c)
        for sd in seeds:
            for name, fn in SOURCES:
                if source_names is not None and name not in source_names: continue
                STATE["step"] = f"{SRC_NAME[name]}: around {sd['artist']} - {sd['title']}"
                try:
                    got = fn(sd)
                except Exception as ex:
                    _log(f"{name} skipped for {sd['artist']}: {str(ex)[:80]}"); continue
                for c in got:
                    if excluded_pick(c): continue
                    old = DB["cands"].get(c["id"])
                    if old and (old.get("v") or (old.get("err") != "no audio" and time.time() - old.get("found", 0) < 86400)): continue
                    if any(c["id"] == x["id"] for x in new): continue
                    if owned.contains(c): continue
                    c.update(seed=sd["title"], seed_artist=sd["artist"], seed_id=sd["id"], found=time.time())
                    new.append(c)
                _log(f"{name}: {len(got)} candidates around {sd['artist']}")
        STATE["found"] = len(new)
        random.Random(len(new)).shuffle(new)                        # don't let one source eat the whole fingerprint budget
        by_source = {}
        for c in new: by_source.setdefault(c["src"], []).append(c)
        new = [c for group in zip_longest(*by_source.values()) for c in group if c is not None]
        # Downloads/crate imports may have finished while source searches were running.
        if OWNED_LOADER:
            owned = OWNED_LOADER()
            new = [c for c in new if not owned.contains(c)]
        _fingerprint(new, hist)
        with _LOCK:
            for c in new:
                if c.get("v") or c.get("err"): DB["cands"][c["id"]] = c
            DB["ts"] = time.time()
            _save()
    except Exception as ex:
        _log("run failed: " + str(ex)[:120])
    finally:
        STATE.update(state="done", step="", ts=time.time())


def _fingerprint(cands, hist, stop=None):
    if not cands: return
    py, worker = soundindex.PY, soundindex.WORKER
    p = subprocess.Popen([str(py), str(worker)], cwd=str(soundindex.SM), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1)
    p.stdout.readline()
    yt_used = attempted = 0
    for c in cands:
        if attempted >= FP_CAP or (stop and stop()): break
        if c["src"] == "discogs":
            if yt_used >= YT_CAP or YT_COOL(): continue  # retry on a later run, not a permanent catalogue error
            yt_used += 1
        STATE["step"] = f"listening: {c.get('artist') or ''} {c.get('title') or ''}".strip()
        try:
            if c.get("dur") and not 60 <= c["dur"] <= 1200:
                c["err"] = "not a single track"; continue
            got = fingerprint_audio(c)
            if not got: c["err"] = "no audio"; continue
            url, hdrs, dur, info = got
            if info:                                               # fill in what the source listing didn't have
                c["title"] = c.get("title") or info.get("track") or info.get("title") or ""
                c["artist"] = c.get("artist") or info.get("artist") or info.get("uploader") or ""
                c["label"] = c.get("label") or info.get("uploader") or ""
                c["page"] = info.get("webpage_url") or c["page"]
                if not info.get("preview_only"): c["dur"] = dur
            if not dur or dur < (30 if info and info.get("preview_only") else 60) or dur > 1200:
                c["err"] = "audio preview too short" if info and info.get("preview_only") else "not a single track"; continue
            attempted += 1
            p.stdin.write(json.dumps({"src": url, "headers": hdrs, "dur": dur, "id": c["id"]}) + "\n"); p.stdin.flush()
            r = json.loads(p.stdout.readline() or "{}")
            if r.get("v"):
                c.pop("err", None)
                c["v"] = r["v"]
                c.pop("styles", None)   # audio model genres are never listing metadata
                score(c, hist); STATE["scored"] += 1
            else: c["err"] = r.get("error") or "fingerprint failed"
        except Exception as ex:
            c["err"] = str(ex)[:120]
    try: p.stdin.close(); p.wait(timeout=30)
    except Exception: pass


# ---------------- for Picks ----------------
def preferences(hist, votes):
    with _LOCK: catalogue = [dict(c) for c in DB["cands"].values()]
    return feedback.Preferences(votes, hist, catalogue)


def picks(n, skip_ids, hist, min_pct=60, votes=None, owned=None, sources=None):
    """Best-sounding candidates not yet seen/owned/voted, round-robin across sources so no one source floods Picks."""
    lib = {t["id"]: t for t in setbuild.tracks(hist)}
    owned = owned if owned is not None else (OWNED_LOADER() if OWNED_LOADER else ownership.Index([*hist, *lib.values()]))
    with _LOCK: candidates = [dict(c) for c in DB["cands"].values()]
    for c in candidates: c["title"] = clean_title(c.get("artist"), c.get("title"))
    preference = feedback.Preferences(votes, hist, candidates) if votes else None
    pool = [c for c in candidates if c.get("v") and c.get("pct", 0) >= min_pct and c["id"] not in skip_ids and not excluded_pick(c)
            and (sources is None or c["src"] in sources)
            and not (preference and feedback.song_key(c) in preference.blocked)
            and not owned.contains(c)]
    for c in pool: c["feedback_adj"] = round(preference.adjustment(c), 3) if preference else 0.
    by = {}
    for c in sorted(pool, key=lambda c: -(c["pct"] + c["feedback_adj"])): by.setdefault(c["src"], []).append(c)
    out = []
    while len(out) < n and any(by.values()):
        for s in list(by):
            if by[s] and len(out) < n: out.append(by[s].pop(0))
    items = []
    for c in out:
        like = lib.get(c.get("like_id"))
        items.append(_pick_item(c, like["title"] if like else c.get("seed"), c.get("like_pct")))
    return items


def _pick_item(c, because, pct, kind=None):
    it = {"id": c["id"], "title": (f"{c['artist']} - {c['title']}" if c.get("artist") else c["title"]),
          "artist": c.get("artist") or "", "track": c.get("title") or "", "channel": c.get("label") or SRC_NAME[c["src"]],
          "channel_url": "", "url": c["page"], "duration": c.get("dur"), "src": c["src"], "kind": kind or c["src"],
          "because": because, "seed": "d:" + (c.get("seed") or ""),
          "pct": pct, "fit": c.get("pct"), "label": c.get("label") or "", "styles": [],
          "feedback_adj": c.get("feedback_adj", 0.)}
    if c["src"] == "traxsource" and c.get("genre"):
        from stylecleanup import published
        ref = {"style_source": "Traxsource", "style_url": c["page"]}
        if published(ref):
            it.update(ref, styles=[c["genre"]])
    if c.get("bpm"): it["bpm"] = c["bpm"]
    if c["src"] != "discogs":
        it["src_url"] = "/dstream?id=" + urllib.parse.quote(c["id"]); it["wave"] = "/dwave?id=" + urllib.parse.quote(c["id"])
    return it


def get(i): return DB["cands"].get(i)


# ---------------- "find tracks that sound like THIS one" (library track or a pasted link) ----------------
# Separate from the library-fit dig above: candidates are scored against ONE target's sound, and those scores live in
# DB["targets"][key]["hits"] (additive: c["pct"] / c["like_id"] stay the library-fit numbers normal Picks use).
# The newest target is DB["like_active"]; its hits sit at the top of Picks until cleared. Requests queue, never drop.
LIKE_MIN, LIKE_FLOOR, LIKE_SHOW = 70, 60, 30    # good match / still shown when we'd otherwise have under 6 / max rows
DB.setdefault("targets", {})
LIKE = {"state": "idle", "step": "", "key": "", "artist": "", "title": "", "found": 0, "listened": 0, "error": "", "queue": 0}
_LIKE_Q, _LIKE_LOCK = [], threading.Lock()
_LIKE_GEN = [0]   # bumped by like_clear(): a running search sees it changed and stops; queued ones are dropped


def like_key(artist, title): return "t:" + hashlib.md5(_key(artist or "", title or "").encode()).hexdigest()[:12]


def _seed_title(t): return re.sub(r"\s*[\(\[].*$", "", t or "").strip() or (t or "")


def like_start(hist, target, source_names=None):
    """target: {artist, title, lib_id?, v? (b64 fingerprint), resolve? (callable -> (url, headers, dur, meta))}.
    One song at a time: a new one REPLACES the search in progress (it stops at its next step) and anything waiting, so Picks
    always follow the last song chosen. The regular background dig can run alongside."""
    if not soundindex.available(): raise ValueError("Sound matching isn't set up on this computer")
    t = dict(target); t["sources"] = source_names
    with _LIKE_LOCK:
        _LIKE_GEN[0] += 1; _LIKE_Q.clear(); _LIKE_Q.append(t)
        LIKE.update(state="working", step="starting", error="", found=0, listened=0, queue=0)
        gen = _LIKE_GEN[0]
    threading.Thread(target=_like_loop, args=(hist, gen), daemon=True).start()
    return dict(LIKE)


class _Stopped(Exception): pass


def _like_loop(hist, gen):
    while True:
        with _LIKE_LOCK:
            if gen != _LIKE_GEN[0]: return          # cancelled: a newer loop (or none) owns LIKE now
            if not _LIKE_Q:
                LIKE.update(state="done", step="", queue=0); return
            t = _LIKE_Q.pop(0); LIKE["queue"] = len(_LIKE_Q)
        try: _like_run(hist, t, lambda: gen != _LIKE_GEN[0])
        except _Stopped: pass
        except Exception as ex:
            LIKE["error"] = str(ex)[:160]; _log("like run failed: " + str(ex)[:120])


def _fp_one(url, hdrs, dur, ident):
    p = subprocess.Popen([str(soundindex.PY), str(soundindex.WORKER)], cwd=str(soundindex.SM), stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        p.stdout.readline()
        p.stdin.write(json.dumps({"src": url, "headers": hdrs or {}, "dur": dur, "id": ident}) + "\n"); p.stdin.flush()
        return json.loads(p.stdout.readline() or "{}").get("v")
    finally:
        try: p.stdin.close(); p.wait(timeout=30)
        except Exception: p.kill()


def _like_score(tv, cands, hist):
    """{cand id: % on the library's scale} for every fingerprinted candidate vs the target vector."""
    m = soundindex.matrix(hist); out = {}
    if not len(m["V"]): return out
    for c in cands:
        if not c.get("v"): continue
        v = _vec(c["v"]); v /= (np.linalg.norm(v) or 1)
        out[c["id"]] = round(soundindex.pct(float(v @ tv), m))
    return out


def _like_run(hist, t, stopped=lambda: False):
    LIKE.update(artist=t.get("artist") or "", title=t.get("title") or "", found=0, listened=0, error="", step="listening to the track")
    vb = t.get("v")
    if not vb and t.get("resolve"):
        url, hdrs, dur, meta = t["resolve"]()                      # pasted link: find its audio (+ artist/title) and listen
        t["artist"] = t.get("artist") or meta.get("artist") or ""; t["title"] = t.get("title") or meta.get("title") or ""
        LIKE.update(artist=t["artist"], title=t["title"])
        if not dur or dur < 60 or dur > 1500: raise ValueError("That link isn't a single track")
        vb = _fp_one(url, hdrs, dur, "like")
    if stopped(): raise _Stopped
    if not vb: raise ValueError("Couldn't listen to that track")
    key = like_key(t["artist"], t["title"]); LIKE["key"] = key
    tv = _vec(vb); tv /= (np.linalg.norm(tv) or 1)
    rec = {"key": key, "artist": t["artist"], "title": t["title"], "lib_id": t.get("lib_id"), "page": t.get("page") or "",
           "ts": time.time(), "hits": {}}
    names = t.get("sources")
    # 1) instant: everything already in the catalogue, scored against this track
    with _LOCK: cat = [dict(c) for c in DB["cands"].values() if names is None or c["src"] in names]
    rec["hits"] = _like_score(tv, cat, hist)
    with _LOCK:
        if stopped(): raise _Stopped
        DB["targets"][key] = rec; DB["like_active"] = key; _save()
    LIKE["found"] = sum(p >= LIKE_MIN for p in rec["hits"].values())
    # 2) dig every source around the track, then around its two closest catalogue matches by other artists
    seeds = [{"id": t.get("lib_id") or key, "artist": t["artist"], "title": _seed_title(t["title"])}] if t["artist"] else []
    seen_art = {_key(t["artist"], "")}
    for cid_, pc in sorted(rec["hits"].items(), key=lambda kv: -kv[1]):
        c = DB["cands"].get(cid_)
        if len(seeds) >= 3 or pc < LIKE_MIN: break
        if c and c.get("artist") and _key(c["artist"], "") not in seen_art:
            seen_art.add(_key(c["artist"], "")); seeds.append({"id": c["id"], "artist": c["artist"], "title": _seed_title(c.get("title"))})
    owned = OWNED_LOADER() if OWNED_LOADER else ownership.Index([*hist, *setbuild.tracks(hist)])
    fresh, known = [], []
    for sd in seeds:
        for name, fn in SOURCES:
            if names is not None and name not in names: continue
            if stopped(): raise _Stopped
            LIKE["step"] = f"searching {SRC_NAME[name]} around {sd['artist']} - {sd['title']}"
            try: got = fn(sd)
            except Exception as ex: _log(f"like: {name} skipped for {sd['artist']}: {str(ex)[:80]}"); continue
            for c in got:
                if excluded_pick(c) or owned.contains(c) or any(c["id"] == x["id"] for x in fresh + known): continue
                old = DB["cands"].get(c["id"])
                if old and old.get("v"): known.append(dict(old)); continue
                if old and old.get("err") and old.get("err") != "no audio": continue
                c.update(seed=sd["title"], seed_artist=sd["artist"], seed_id=sd["id"], found=time.time()); fresh.append(c)
    by_source = {}
    for c in fresh: by_source.setdefault(c["src"], []).append(c)
    fresh = [c for g in zip_longest(*by_source.values()) for c in g if c is not None]
    if stopped(): raise _Stopped
    with _LOCK: rec["hits"].update(_like_score(tv, known, hist))
    LIKE["found"] = sum(p >= LIKE_MIN for p in rec["hits"].values())
    # 3) listen to the new finds (same model, same caps as the background dig), scoring each against the target as it lands
    if stopped(): raise _Stopped
    LIKE["step"] = f"listening to {min(len(fresh), FP_CAP)} new finds" if fresh else ""
    STATE_BAK = STATE.get("step")
    _fingerprint(fresh, hist, stop=stopped)
    STATE["step"] = STATE_BAK if STATE.get("state") == "working" else ""
    with _LOCK:
        for c in fresh:
            if c.get("v") or c.get("err"): DB["cands"][c["id"]] = c
        if stopped(): _save(); raise _Stopped                # keep what was listened to, don't bring the results back
        rec["hits"].update(_like_score(tv, fresh, hist)); rec["ts"] = time.time()
        DB["targets"][key] = rec; _save()
    if stopped(): raise _Stopped
    LIKE["listened"] = sum(1 for c in fresh if c.get("v"))
    LIKE["found"] = sum(p >= LIKE_MIN for p in rec["hits"].values())
    _log(f"like {t['artist']} - {t['title']}: {len(fresh)} new, {LIKE['listened']} listened, {LIKE['found']} matches")


def like_clear():
    """Clear the Sounds-like results AND stop: the running search ends at its next step, queued ones are dropped."""
    with _LIKE_LOCK:
        _LIKE_GEN[0] += 1; _LIKE_Q.clear()
        LIKE.update(state="idle", step="", queue=0, found=0, listened=0, error="", artist="", title="", key="")
    with _LOCK: DB["like_active"] = None; _save()


def like_picks(skip_ids, hist, owned=None, votes=None, sources=None):
    """The active target's best matches as Picks items ('Sounds N% like <target>'), best first."""
    with _LOCK:
        rec = DB["targets"].get(DB.get("like_active") or "")
        if not rec: return None, []
        hits = sorted(rec["hits"].items(), key=lambda kv: -kv[1]); cands = {i: dict(DB["cands"][i]) for i, _ in hits if i in DB["cands"]}
    owned = owned if owned is not None else (OWNED_LOADER() if OWNED_LOADER else ownership.Index([*hist, *setbuild.tracks(hist)]))
    preference = feedback.Preferences(votes, hist, list(cands.values())) if votes else None
    me = _key(rec["artist"], rec["title"])
    rows = []
    for i, pc in hits:
        c = cands.get(i)
        if not c or pc < LIKE_FLOOR or i in skip_ids or excluded_pick(c) or owned.contains(c): continue
        if sources is not None and c["src"] not in sources: continue
        if preference and feedback.song_key(c) in preference.blocked: continue
        c["title"] = clean_title(c.get("artist"), c.get("title"))
        if _key(c.get("artist") or "", c["title"]) == me: continue        # the track itself, found again
        if pc < LIKE_MIN and len(rows) >= 6: break
        rows.append(_pick_item(c, rec["title"] if not rec["artist"] else f"{rec['artist']} - {rec['title']}", pc, kind="like"))
        if len(rows) >= LIKE_SHOW: break
    return {k: rec[k] for k in ("key", "artist", "title", "ts")}, rows

