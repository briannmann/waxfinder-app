"""Online artist suggestions for files with no artist anywhere (tag, file name, Rekordbox). SUGGESTIONS ONLY: nothing is written to a file
until the user ticks one. Source: MusicBrainz (about 1 request/second, User-Agent names the app only). Results cached in artist_lookup.json
(permanent, resumable). A suggestion is 'sure' (pre-ticked) only when the version text matches, the length is within 3 s and exactly one artist
fits, or the candidate artist already appears in the file name. Generic one-word titles only ever offer a choice."""
import json, re, time, threading, unicodedata, urllib.error, urllib.parse, urllib.request
from pathlib import Path
import libindex

STORE = Path(__file__).parent / "artist_lookup.json"
UA = "Waxfinder/1.0 (personal DJ library tool)"
_LOCK = threading.Lock(); _last = [0.0]
JOB = {"state": "idle", "done": 0, "total": 0, "error": ""}

def _nrm(s): return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", (s or "").lower()).encode("ascii", "ignore").decode())

def _load():
    try: return json.loads(STORE.read_text())
    except Exception: return {}

def _save(d):
    tmp = STORE.with_suffix(".tmp"); tmp.write_text(json.dumps(d, ensure_ascii=False)); tmp.replace(STORE)

def _mb(query, limit=15):
    with _LOCK:
        wait = 1.6 - (time.time() - _last[0])
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
    url = "https://musicbrainz.org/ws/2/recording/?" + urllib.parse.urlencode({"query": query, "fmt": "json", "limit": limit})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for tries in range(5):   # 503 = MusicBrainz asking us to slow down: wait longer each time, then give up cleanly
        try: return json.loads(urllib.request.urlopen(req, timeout=25).read()).get("recordings", [])
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or tries == 4: raise
            time.sleep((10, 30, 60, 90)[tries]); _last[0] = time.time()

def parse_title(raw):
    """(base, version, truncated) from a title or file stem: 'Hot & Bothered (Original Mix)' -> ('Hot & Bothered', 'original mix', False).
    A name cut off mid-bracket ('(Dr Packer Extended Rem') keeps what it has and is marked truncated, so the missing tail is never held against it."""
    s = libindex.strip_junk(libindex.nfc(raw or "")).strip()
    s = re.sub(r"\.(mp3|flac|m4a|wav)$", "", s, flags=re.I)
    m = re.match(r"^(.*?)\s*[\(\[]([^\)\]]*)([\)\]]?)", s)
    if not m: return s, "", False
    base, ver, closed = m.group(1).strip(), m.group(2).strip().lower(), bool(m.group(3))
    return (base or s), ver, not closed

def _version_ok(ver, trunc, rec_title):
    if not ver: return True
    rt = rec_title.lower()
    if trunc: return _nrm(ver) in _nrm(rt)
    return _nrm(ver) in _nrm(rt)

def _artist(r): return "".join((a.get("name", "") + a.get("joinphrase", "")) for a in r.get("artist-credit", [])).strip()

GENERIC_VER = re.compile(r"^(original(\s+mix)?|extended(\s+mix)?|radio(\s+edit)?|club(\s+mix)?|album(\s+version)?|edit)$", re.I)

def _stem_parts(path):
    """(artist_guess, title) when the file name has ONE separator (' - ', '-', ' _ ', '_'); the lookup then CONFIRMS the leading words as the artist."""
    st = libindex.strip_junk(libindex.nfc(Path(path).stem)); st = re.sub(r"\s+_\s+|(?<=\w)_(?=\w)", " - ", st)
    m = re.match(r"^(.{2,40}?)\s*-\s*(.+)$", st)
    return (m.group(1).strip(), m.group(2).strip()) if m else ("", st)

def lookup(path, rec):
    """Suggestion for one file: {'level': 'sure'|'pick'|'none', 'cands': [...]}. 'sure' needs the artist to appear in the file name, or exactly one artist
    within 3 s with the version text agreeing on a title of 3+ words. Everything else is a choice the user makes."""
    ga, rest = _stem_parts(path)
    base, ver, trunc = parse_title(rec.get("title") or rest)
    if ga and rec.get("title"): base, ver, trunc = parse_title(_stem_parts(path)[1])
    if not base: return {"level": "none", "cands": []}
    stem_n = _nrm(Path(path).stem); base_n = _nrm(base); secs = float(rec.get("dur") or 0)
    queries = ['recording:"%s"' % base.replace('"', " ")]
    if ga: queries.append('recording:"%s" AND artist:"%s"' % (base.replace('"', " "), ga.replace('"', " ")))
    elif len(base.split()) >= 3: queries.append(base.replace('"', " "))   # 'Angie Stone Wish I Didn't Miss You': artist sits in front of the title
    cands = {}
    for q in queries:
        for r in _mb(q):
            a = _artist(r)
            if not a or _nrm(a) in ("variousartists", "unknown", "unknownartist"): continue
            an, tn = _nrm(a), _nrm(re.split(r"[(\[]", r.get("title", ""))[0])
            front = stem_n.startswith(an) and len(an) > 2 and (tn and stem_n[len(an):].startswith(tn[:max(4, len(tn))]))
            if tn != base_n and not front: continue
            ln = (r.get("length") or 0) / 1000; diff = abs(ln - secs) if ln and secs else None
            c = cands.setdefault(an, {"artist": a, "title": r.get("title", ""), "diff": 99, "ver_ok": False, "in_name": an in stem_n and len(an) > 2})
            if diff is not None and diff < c["diff"]: c["diff"], c["title"] = diff, r.get("title", "")
            if not ver or GENERIC_VER.match(ver) or _nrm(ver) in _nrm(r.get("title", "")): c["ver_ok"] = True
    out = sorted((c for c in cands.values() if c["in_name"] or c["diff"] <= 12 or c["diff"] == 99), key=lambda c: (not c["in_name"], c["diff"] > 8, not c["ver_ok"], c["diff"]))
    near = [c for c in out if c["diff"] <= 3 and c["ver_ok"]]
    level = "pick" if out else "none"
    if out and out[0]["in_name"] and out[0]["ver_ok"] and out[0]["diff"] <= 8: level = "sure"
    elif len(near) == 1 and len(base.split()) >= 3: level = "sure"
    return {"level": level, "cands": [{"artist": c["artist"], "title": c["title"], "secs_off": None if c["diff"] == 99 else round(c["diff"], 1), "version_match": c["ver_ok"], "in_name": c["in_name"]} for c in out[:4]]}


# ---------- v2: pure scoring on raw MusicBrainz answers (no network, so rules can be tested offline on tools/artistlab/raw.json) ----------
def remixer(ver):
    """'Sandy Rivera's Classic Mix' -> 'Sandy Rivera'; '' when the version names nobody (original / extended / radio ...)."""
    v = re.sub(r"\b(original|extended|radio|club|classic|dub|vocal|instrumental|main|12\"?|7\"?|inch|edit|mix|remix|rework|version|re-?edit|bootleg|disco|blend|rmx)\b", " ", ver or "", flags=re.I)
    v = re.sub(r"['’]s\b|[^\w\s&.'-]", " ", v); v = re.sub(r"\s+", " ", v).strip(" -.&")
    return v if len(v) > 2 else ""

def _first(a): return _nrm(re.split(r"\s*(?:feat\.?|featuring|ft\.?|&|,| and | x | vs\.?)\s*", a or "", flags=re.I)[0])

def judge(path, rec, raw):
    """raw: {query: [recordings]} -> {'level','cands'} with a plain-English `why` per candidate. Stricter than v1:
    * an artist needs SUPPORT: several matching recordings/releases (originals appear on many, one-off covers once);
    * a named remix compares length only against recordings that carry that version, and the remixer is never offered as the artist;
    * 'sure' needs a clear winner (runner-up well behind), never a generic one-word title, never a lone length coincidence."""
    ga, rest = _stem_parts(path)
    base, ver, trunc = parse_title(rec.get("title") or rest)
    if ga and rec.get("title"): base, ver, trunc = parse_title(_stem_parts(path)[1])
    if not base: return {"level": "none", "cands": []}
    stem_n, base_n, secs = _nrm(Path(path).stem), _nrm(base), float(rec.get("dur") or 0)
    rm = remixer(ver); rm_n = _nrm(rm); named = bool(ver) and not GENERIC_VER.match(ver)
    seen, cands = set(), {}
    for recs in raw.values():
        if not isinstance(recs, list): continue
        for r in recs:
            if r.get("id") in seen: continue
            seen.add(r.get("id")); a = _artist(r)
            if not a or _nrm(a) in ("variousartists", "unknown", "unknownartist"): continue
            an, fa = _nrm(a), _first(a); title = r.get("title", ""); tn = _nrm(re.split(r"[(\[]", title)[0])
            if rm_n and fa == rm_n: continue                      # the remixer is not the artist
            front = stem_n.startswith(an) and len(an) > 2 and tn and stem_n[len(an):].startswith(tn[:max(4, len(tn))])
            if tn != base_n and not front: continue
            exact = (not named) or _nrm(ver) in _nrm(title) or (bool(rm_n) and rm_n in _nrm(title))
            ln = (r.get("length") or 0) / 1000
            c = cands.setdefault(fa, {"artist": a, "title": title, "support": 0.0, "n": 0, "exact": False, "diff": 99, "in_name": fa in stem_n and len(fa) > 2 and fa != base_n})
            c["n"] += 1; c["support"] += 1 + min(len(r.get("releases") or []), 6) * .25
            if exact:
                c["exact"] = True
                d = abs(ln - secs) if ln and secs else None
                if d is not None and d < c["diff"]: c["diff"], c["title"] = d, title
            if len(a) < len(c["artist"]) or not c["artist"]: c["artist"] = a
    out = sorted(cands.values(), key=lambda c: (not c["in_name"], not c["exact"], c["diff"] > (8 if not named else 99), -c["support"], c["diff"]))
    out = [c for c in out if c["in_name"] or c["exact"] and (c["diff"] <= 12 or named or c["diff"] == 99)][:4]
    if not out: return {"level": "none", "cands": []}
    top, nxt = out[0], (out[1] if len(out) > 1 else None)
    generic = len(base.split()) < 2 or len(base_n) < 6
    length_ok = top["diff"] <= 3 or (named and top["diff"] == 99)
    clear = nxt is None or nxt["support"] * 3 <= top["support"] or (nxt["diff"] > 3 and top["diff"] <= 3 and nxt["support"] < top["support"])
    if top["in_name"] and top["exact"] and top["diff"] <= 8: level = "sure"          # the file name already says it and the search agrees
    elif not generic and top["exact"] and top["n"] >= 2 and top["support"] >= 3 and length_ok and clear and (not named or top["diff"] <= 3): level = "sure"
    else: level = "pick"
    def why(c):
        w = []
        if c["in_name"]: w.append("artist is in the file name")
        if named and c["exact"]: w.append("this version found")
        if c["diff"] != 99: w.append("length matches" if c["diff"] <= 3 else "length %.0f s off" % c["diff"])
        if c["n"] >= 2: w.append("%d recordings agree" % c["n"])
        return " · ".join(w) or "title only"
    return {"level": level, "cands": [{"artist": c["artist"], "title": c["title"], "secs_off": None if c["diff"] == 99 else round(c["diff"], 1), "version_match": c["exact"], "in_name": c["in_name"], "why": why(c), "n": c["n"]} for c in out]}

def queries(path, rec):
    """The MusicBrainz searches for one file: title; title + artist from the file name; title + remixer (a named remix)."""
    ga, rest = _stem_parts(path); base, ver, _ = parse_title(rec.get("title") or rest)
    if ga and rec.get("title"): base, ver, _ = parse_title(_stem_parts(path)[1])
    b = base.replace('"', " "); qs = ['recording:"%s"' % b]
    if ga: qs.append('recording:"%s" AND artist:"%s"' % (b, ga.replace('"', " ")))
    elif len(base.split()) >= 3: qs.append(b)
    rm = remixer(ver)
    if rm: qs.append('recording:"%s" AND recording:"%s"' % (b, rm.replace('"', " ")))
    return qs

def _slim(recs): return [{"id": r.get("id"), "title": r.get("title"), "length": r.get("length"), "artist-credit": r.get("artist-credit"), "releases": [0] * len(r.get("releases") or [])} for r in recs]

def combine(path, rec, raw, ai):
    """Text judge + audio fingerprint (ai = AcoustID answers or None). 'sure' needs two independent routes to agree, or the file name already
    naming the artist; text alone never pre-ticks. An audio match that text search never found is offered first but only ever as a choice."""
    res = judge(path, rec, raw); cs = [dict(c) for c in res["cands"]]
    strong = [x for x in (ai or []) if x.get("score", 0) >= .9 and x.get("artist")]
    top_a = _first(strong[0]["artist"]) if strong else None
    if top_a:
        hit = next((c for c in cs if _first(c["artist"]) == top_a), None)
        if hit:
            cs.remove(hit); hit["why"] = "audio match · " + hit["why"]; cs.insert(0, hit)
            return {"level": "sure" if hit["version_match"] or hit["in_name"] else "pick", "cands": cs[:4]}
        cs.insert(0, {"artist": strong[0]["artist"], "title": strong[0]["title"], "secs_off": None, "version_match": False, "in_name": False, "why": "audio match only", "n": 0})
        return {"level": "pick", "cands": cs[:4]}
    if res["level"] == "sure" and cs and not cs[0]["in_name"]: res["level"] = "pick"
    return res

def lookup2(path, rec):
    """Network part of v2: MusicBrainz title searches + AcoustID fingerprint -> the entry stored as `res2`."""
    raw = {q: _slim(_mb(q, 25)) for q in queries(path, rec)}
    try:
        import acoustid_lookup as AI
        ai = AI.lookup(path) if AI.available() else None
    except Exception: ai = None
    return {"res": combine(path, rec, raw, ai), "ai": bool(ai), "v": 2}

def targets():
    """Files with no artist in the tag, the file name or Rekordbox, and no fix already proposed for them."""
    rows = libindex.index(); fx = {x["path"] for x in libindex.propose_fixes() if x["tags"]}
    return {p: r for p, r in rows.items() if r.get("ok") and not r["artist"] and p not in fx and not libindex.guess_names(p, r)[0] and r["ext"] in (".mp3", ".flac", ".m4a")}

def run():
    global JOB
    if JOB["state"] == "running": return
    todo = [(p, r) for p, r in targets().items() if not (_load().get(libindex.nfc(p)) or {}).get("res2")]
    JOB = {"state": "running", "done": 0, "total": len(todo), "error": ""}
    def go():
        d = _load()
        try:
            for p, r in todo:
                k = libindex.nfc(p); e = d.get(k) or {}
                e["res2"] = lookup2(p, r)["res"]; e["t"] = int(time.time())   # new result beside the old `res`, which is kept until a new one exists
                if "res" not in e: e["res"] = {"level": "none", "cands": []}
                d[k] = e; JOB["done"] += 1
                if JOB["done"] % 8 == 0: _save(d)
            JOB["state"] = "done"; _CNT[0] = 0
        except Exception as e:
            JOB["state"] = "paused"; JOB["error"] = "MusicBrainz stopped answering (%s). What was found is saved; press Find again later." % str(e)[:60]
        _save(d); _CNT[0] = 0
    threading.Thread(target=go, daemon=True).start()

def _eff(e): return (e or {}).get("res2") or (e or {}).get("res") or {"level": "none", "cands": []}

def suggestions():
    d = _load(); t = targets(); out = []
    for p, r in t.items():
        e = d.get(libindex.nfc(p))
        if e: res = _eff(e); out.append({"path": p, "name": Path(p).name, "level": res["level"] if res["cands"] else "none", "cands": res["cands"]})
    # best length match first, biggest difference last; no length known goes at the end
    out.sort(key=lambda x: (not x["cands"], (x["cands"][0]["secs_off"] if x["cands"] and x["cands"][0]["secs_off"] is not None else 9999), x["name"].lower()))   # no-match rows (type it yourself) go last
    return {"items": out, "targets": len(t), "searched": sum(1 for p in t if libindex.nfc(p) in d), "job": JOB}

def apply(items):
    """items: [{path, artist, custom?}]. An artist we offered, or one the user typed (custom=true), can be written; the title tag is kept, or filled from the file name when empty."""
    d = _load(); t = targets(); batch = time.strftime("%Y%m%d-%H%M%S"); ops = []; failed = []
    for it in items:
        p = it.get("path") or ""; e = d.get(libindex.nfc(p)); r = t.get(p)
        art = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f]", " ", str(it.get("artist") or ""))).strip()
        offered = bool(e) and art in {c["artist"] for c in _eff(e)["cands"]}
        if not r or not art or len(art) > 150 or not (offered or it.get("custom")): failed.append({"path": p, "error": "not an offered or typed artist"}); continue
        it = {**it, "artist": art}
        try:
            import mutagen
            f = mutagen.File(p, easy=True)
            if f is None: raise ValueError("unreadable")
            if f.tags is None: f.add_tags()
            title = r["title"] or libindex.strip_junk(libindex.nfc(Path(p).stem))
            f["artist"], f["title"] = it["artist"], title; f.save()
            ops.append({"type": "tags", "path": p, "old": {"artist": r["artist"], "title": r["title"]}, "new": {"artist": it["artist"], "title": title}})
        except Exception as ex: failed.append({"path": p, "error": str(ex)[:120]})
    if ops: libindex._log(batch, "fix", ops)
    libindex._reindex(ops)
    return {"batch": batch, "changed": len(ops), "failed": failed}


_CNT = [0.0, 0, 0]   # when, still to search, waiting for review
def counts():
    """(still to search, suggestions waiting to be reviewed) - cached 30 s because the Crates pill asks every few seconds."""
    if time.time() - _CNT[0] > 30:
        t = targets(); d = _load()
        _CNT[:] = [time.time(), sum(1 for p in t if not (d.get(libindex.nfc(p)) or {}).get("res2")), sum(1 for p in t if _eff(d.get(libindex.nfc(p))).get("cands"))]
    return _CNT[1], _CNT[2]
