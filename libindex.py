"""The real music library (the MUSIC USB): scan, health check, tidy-up, trash with undo.
Waxfinder is the master library; Rekordbox is only the exporter to the CDJ stick (see AGENTS.md).
lib_index.json = scan cache (derived, safe to rebuild).  lib_log.json = every move/rename/tag change, so it can be undone: NEVER wipe.
Songs are never hard-deleted: 'delete' = move to <drive>/_Waxfinder Trash/<batch>/..., undoable. Atomic writes."""
import hashlib, json, os, re, sys, threading, time, unicodedata, uuid
from pathlib import Path
import hiddenfiles
from paths import posix, safe_replace

HERE = Path(__file__).parent
INDEX = HERE / "lib_index.json"
LOG = HERE / "lib_log.json"
ROOTS_FILE = HERE / "lib_roots.json"
DEFAULT_ROOTS = ["/Volumes/MUSIC/Contents", "/Volumes/MUSIC/Library", "/Volumes/MUSIC/Waxfinder"]
TRASH_NAME = "_Waxfinder Trash"
EXTS = {".mp3", ".wav", ".flac", ".aif", ".aiff", ".m4a"}
LOSSLESS = {".wav", ".flac", ".aif", ".aiff"}
LOW_KBPS = 192
LOCK = threading.RLock()
JOB = {"state": "idle", "done": 0, "total": 0, "current": "", "errors": 0, "started": 0}


def roots():
    try: r = json.loads(ROOTS_FILE.read_text())
    except (OSError, ValueError): r = DEFAULT_ROOTS
    try:
        import library_setting; mine = library_setting.get()
        if mine and str(mine) not in r: r = list(r) + [str(mine)]   # the folder this person chose is part of their library
    except Exception: pass
    return [x for x in r if os.path.isdir(x)]

def _atomic(p, data):
    tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(data, indent=1)); safe_replace(tmp, p)

def _load(p, default):
    try: return json.loads(p.read_text())
    except (OSError, ValueError): return default

def nfc(x): return unicodedata.normalize("NFC", posix(x))

def fid(path): return "lf" + hashlib.sha1(nfc(path).encode()).hexdigest()[:12]


# ---------- names ----------
JUNK = re.compile(r"""\[\s*[\w.\-]*(?:ezmp3|mp3|free)[\w.\-]*\s*\]|\bmy-free-mp3s(?:\.\w+)?|\(\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyric video|visuali[sz]er)\s*\)|\[\s*(?:official\s*)?(?:music\s*)?(?:video|audio)\s*\]|\(\s*audio only\s*\)|\(\s*official[^)\]]*$|\(?\s*free download\s*\)?|\b(?:www\.)?[\w-]+\.(?:com|cc|net|org|to)\b""", re.I)

def strip_junk(s):
    hit = JUNK.search(s)
    s = JUNK.sub(" ", s)
    s = re.sub(r"\s*[\(\[]\s*[\)\]]", "", s)              # brackets emptied by the strip
    s = re.sub(r"\s{2,}", " ", s).strip(" -_.")
    return re.sub(r"\s+-\d{1,2}$", "", s) if hit else s     # "... .com -1" leaves a stray -1 behind

def has_junk(s): return bool(JUNK.search(s))

def dup_key(artist, title, stem):
    base = f"{artist} {title}" if artist and title else stem
    base = strip_junk(nfc(base)).lower()
    base = re.sub(r"\s*\(\d+\)\s*$", "", base)             # "... (2)" copies
    base = re.sub(r"^[0-9a-f]{8}-", "", base)
    return re.sub(r"[^a-z0-9]+", "", base)

def split_name(s):
    """'Artist - Title', or 'First Last-Title' (a hyphen with no spaces, after two or more capitalised words, is read as the
    artist/title break; one-word artists and hyphenated words such as Run-DMC are left alone). Returns (artist, title)."""
    if " - " in s:
        a, t = s.split(" - ", 1); return a.strip(), t.strip()
    m = re.fullmatch(r"([A-Z][^\s-]*(?:\s+[A-Z][^\s-]*)+)-(\S.*)", s)
    if m: return m.group(1).strip(), m.group(2).strip()
    return "", s

def from_filename(stem):
    s = strip_junk(nfc(stem))
    if " - " in s:
        a, t = s.split(" - ", 1); return a.strip(), t.strip()
    return "", s

def guess_names(p, r):
    """Best artist/title for a file. When the artist tag is empty and the TITLE tag holds the whole name with site junk on it
    ('Artist-Title www.site.net') while the file name was cut off, the tag is the complete version, so use it."""
    a, t = strip_junk(r.get("artist", "")), strip_junk(r.get("title", ""))
    if not a and t and has_junk(r.get("title", "")):
        fa, ft = split_name(t)
        return (fa, ft) if fa else ("", t)
    fa, ft = from_filename(Path(p).stem)
    return a or fa, t or ft


# ---------- scan ----------
def _read(path):
    import mutagen
    st = os.stat(path); ext = Path(path).suffix.lower()
    rec = {"size": st.st_size, "mtime": int(st.st_mtime), "ext": ext, "dur": 0.0, "br": 0, "sr": 0, "artist": "", "title": "", "album": "", "genre": "", "ok": True}
    try:
        f = mutagen.File(path, easy=True)
        if f is None: raise ValueError("unreadable")
        i = f.info; rec["dur"] = round(float(getattr(i, "length", 0) or 0), 2); rec["sr"] = int(getattr(i, "sample_rate", 0) or 0)
        br = int(getattr(i, "bitrate", 0) or 0)
        rec["br"] = round(br / 1000) if br else (round(st.st_size * 8 / rec["dur"] / 1000) if rec["dur"] else 0)
        t = f.tags or {}
        for k in ("artist", "title", "album", "genre"):
            v = t.get(k); rec[k] = (v[0] if isinstance(v, list) and v else v or "").strip() if not isinstance(v, (int, float)) else ""
    except Exception:
        rec["ok"] = False
    return rec

def _walk():
    out = []
    for root in roots():
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if not d.startswith(".") and d != TRASH_NAME]
            for n in fn:
                if n.startswith(".") or n.startswith("._"): continue
                if Path(n).suffix.lower() in EXTS: out.append(posix(os.path.join(dp, n)))
    return out

def scan():
    """Background scan of the library roots. Only new/changed files are read. Returns immediately."""
    with LOCK:
        if JOB["state"] == "working": return JOB
        JOB.update(state="working", done=0, total=0, current="", errors=0, started=time.time())
    def go():
        try:
            files = _walk(); JOB["total"] = len(files)
            old = _load(INDEX, {}).get("files", {}); new = {}
            if not files and old: JOB.update(state="done", current=""); return   # drive not plugged in: keep the saved index, never overwrite it with nothing
            for n, p in enumerate(files):
                JOB.update(done=n, current=os.path.basename(p))
                key = nfc(p)
                try: st = os.stat(p)
                except OSError: continue
                c = old.get(key)
                if c and c.get("size") == st.st_size and c.get("mtime") == int(st.st_mtime): new[key] = c; continue
                new[key] = _read(p)
                if not new[key]["ok"]: JOB["errors"] += 1
            # Reconcile per root: records under a root that isn't mounted (or came back empty) are kept, never dropped by a scan of another root.
            rs = [nfc(r).rstrip("/") + "/" for r in roots()]
            live = {r for r in rs if any(k.startswith(r) for k in new)}
            for k, c in old.items():
                if k not in new and not any(k.startswith(r) for r in live): new[k] = c
            with LOCK: _atomic(INDEX, {"scanned": time.time(), "roots": roots(), "files": new})
            JOB.update(state="done", done=len(files), current="")
        except Exception as e:
            JOB.update(state="error", current=str(e)[:120])
    threading.Thread(target=go, daemon=True).start()
    return JOB

def index(): return _load(INDEX, {}).get("files", {})


def entries(skip_files=(), moved=None):
    """Library files as track entries for load_all (in memory only). Files already known elsewhere are skipped.
    moved = {old path: new path} for scanned files that were reconnected at a new place (relocate.py): the track keeps the id made
    from its OLD path, so crates, sets and energy tags still find it, and it is listed once whether the scan knows the old place,
    the new one, or both."""
    skip = {nfc(f) for f in skip_files}; out = []; idx = index(); moved = moved or {}
    homes = {nfc(n): o for o, n in moved.items()}
    for path, r in idx.items():
        if path in skip or not r.get("dur"): continue
        was, now = homes.get(path), moved.get(path)
        if now and (idx.get(nfc(now)) or {}).get("dur") and nfc(now) not in skip: continue   # its new home has a record of its own, which carries the track
        a, t = r["artist"], r["title"]
        if not (a and t): fa, ft = from_filename(Path(path).stem); a, t = a or fa, t or ft
        e = {"id": fid(was or path), "rb": True, "lf": True, "file": now or path, "ext": r["ext"].lstrip("."), "url": "", "channel": "Library", "channel_url": "",
             "date": r["mtime"], "duration": int(r["dur"]), "artist": a, "rbtitle": t, "title": f"{a} - {t}" if a else t}
        if was or now: e["moved_from"] = was or path
        out.append(e)
    return out


# ---------- health (read-only) ----------
def _quality(p, r):   # lossless first, then bitrate, size, tags, and a whole name (balanced brackets) over a cut-off one
    n = Path(p).stem
    return (r["ext"] in LOSSLESS, r["br"], r["size"], bool(r["artist"] and r["title"]), n.count("(") == n.count(")") and n.count("[") == n.count("]"), len(n))

_HASHES = {}
def _content_hash(p, r):
    """SHA-1 of the whole file, remembered per (path, size, mtime) for this session. None if unreadable."""
    key = (p, r.get("size"), r.get("mtime"))
    if key not in _HASHES:
        try:
            h = hashlib.sha1()
            with open(p, "rb") as f:
                for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
            _HASHES[key] = h.hexdigest()
        except OSError: _HASHES[key] = None
    return _HASHES[key]

def health():
    files = index(); dup, junk, low, notags, bad = {}, [], [], [], []
    reachable = 0
    for p, r in files.items():
        if not os.path.exists(p): continue
        reachable += 1
        stem = Path(p).stem
        row = lambda **x: {"path": p, "name": Path(p).name, "folder": posix(Path(p).parent), "ext": r["ext"], "br": r["br"], "dur": r["dur"], "size": r["size"], **x}
        if not r.get("ok"): bad.append(row()); continue
        if has_junk(stem) or has_junk(r["artist"] + " " + r["title"]):
            c = clean_name(p, r)
            junk.append(row(clean=c, why=None if c != Path(p).name else "No automatic fix: the junk is only in the tags, and the file name already reads as clean, so there is nothing safe to rename it to. Edit its title tag in a tag editor."))
        if r["ext"] not in LOSSLESS and 0 < r["br"] < LOW_KBPS: low.append(row())
        if not (r["artist"] and r["title"]): notags.append(row(guess=" - ".join(x for x in from_filename(stem) if x)))
        dup.setdefault(dup_key(r["artist"], r["title"], stem), []).append((p, r))
    groups = []
    for k, items in dup.items():
        if len(items) < 2 or not k: continue
        items.sort(key=lambda x: _quality(*x), reverse=True)
        hs = {p: _content_hash(p, r) if any(o is not r and o["size"] == r["size"] for _, o in items) else None for p, r in items}   # only same-size files can be identical
        top = hs[items[0][0]]
        groups.append({"key": k, "copies": [{"path": p, "name": Path(p).name, "folder": posix(Path(p).parent), "ext": r["ext"], "br": r["br"], "dur": r["dur"], "size": r["size"],
                                             # exact = identical bytes (hash), never just the same size. Everything else is a "possible duplicate".
                                             "exact": hs[p] is not None and (hs[p] == top if i else any(hs[q] == hs[p] for q, _ in items[1:]))} for i, (p, r) in enumerate(items)]})
    groups.sort(key=lambda g: g["copies"][0]["name"].lower())
    return {"total": len(files), "reachable": reachable, "offline": len(files) - reachable, "dups": groups, "junk": junk, "low": low, "notags": notags, "bad": bad,
            "scanned": _load(INDEX, {}).get("scanned", 0), "wasted": sum(c["size"] for g in groups for c in g["copies"][1:])}


# ---------- changes, always logged and undoable ----------
def _log(batch, kind, ops, **extra):
    with LOCK:
        d = _load(LOG, {"batches": []}); d["batches"].append({"batch": batch, "kind": kind, "time": time.time(), "undone": False, "ops": ops, **extra}); _atomic(LOG, d)

def new_batch():
    """A batch id that cannot collide (two removes in the same second used to share one trash folder and one log entry)."""
    return time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]

def _journal(batch, **upd):
    """Merge fields into an already-logged batch (state, ops, memberships...). The batch is logged BEFORE any file moves, so a crash still leaves a record."""
    with LOCK:
        d = _load(LOG, {"batches": []}); b = next((x for x in d["batches"] if x["batch"] == batch), None)
        if b is None: return False
        b.update(upd); _atomic(LOG, d); return True

def annotate(batch, **extra):
    """Attach what else the operation changed (crate memberships, hidden files, a crate swap) so Undo from the history list reverses all of it."""
    return _journal(batch, **extra)

def record(kind, **extra):
    """A batch with no file moves (e.g. 'forget'): still journalled, so it can be undone from the history list."""
    batch = new_batch(); _log(batch, kind, [], state="complete", **extra); return batch

def is_mount(p):
    """A mounted drive. On Windows /Volumes/MUSIC is a junction to the stick's drive (start.ps1 makes it); ismount() says no to junctions."""
    p = Path(p)
    try:
        if os.path.ismount(p): return True
    except OSError: return False   # Windows: a junction to an unplugged stick raises instead of saying no
    if sys.platform != "win32" or not p.is_junction(): return False
    r = os.path.realpath(p)
    return os.path.ismount(r) and os.path.isdir(r)   # ismount() is True for any drive root, even an unplugged one

def _drive_root(p):
    p = Path(p)
    for a in [p, *p.parents]:
        if is_mount(a): return a
    return p.anchor and Path(p.anchor)

def trash(paths):
    """Move files into <drive>/_Waxfinder Trash/<batch>/<original path>. Same drive only; nothing is deleted.
    The whole plan is written to the log BEFORE the first file moves; a failure part-way keeps every move already made on record."""
    batch = new_batch(); ops = []; skipped = []
    files = index()
    for p in paths:
        if nfc(p) not in files or not os.path.isfile(p): skipped.append(p); continue
        root = _drive_root(p); rel = Path(p).relative_to(root)
        ops.append({"type": "move", "from": p, "to": posix(root / TRASH_NAME / batch / rel)})
    if not ops: return {"batch": batch, "moved": 0, "skipped": skipped}
    _log(batch, "trash", ops, state="open")
    done = []; err = None
    try:
        for o in ops:
            try:
                Path(o["to"]).parent.mkdir(parents=True, exist_ok=True); os.rename(o["from"], o["to"]); o["done"] = True; done.append(o)
            except OSError as e:
                o["done"] = False; o["error"] = str(e)[:120]; skipped.append(o["from"]); err = err or e   # this file stays where it was; carry on with the rest
    finally:
        _journal(batch, ops=ops, state="complete" if len(done) == len(ops) else "partial")
        if done: _forget([o["from"] for o in done])
    return {"batch": batch, "moved": len(done), "skipped": skipped}

def _forget(paths):
    with LOCK:
        d = _load(INDEX, {}); f = d.get("files", {})
        for p in paths: f.pop(nfc(p), None)
        if d: _atomic(INDEX, d)

BAD_ARTIST = re.compile(r"^\s*(?:unknown(?:\s+artist)?|n/?a|none|untitled)\s*$", re.I)

def clean_artist(a):
    """An artist tag with the obvious noise removed: site junk, YouTube's auto-channel ' - Topic' suffix, 'Unknown Artist'. Empty if nothing real is left."""
    a = a or ""
    if has_junk(a): a = strip_junk(a)
    a = re.sub(r"\s+-\s+topic\s*$", "", a, flags=re.I).strip()   # 'F.L.G.' / 'Robin S.' keep their dots: only real noise is removed
    return "" if BAD_ARTIST.match(a) else a

def title_without_artist(a, t):
    """'Omar S-Games That We Play' or 'Omar S - Games...' tagged as the title of an Omar S track -> 'Games That We Play'."""
    if a and t:
        for sep in (" - ", "-"):
            if t.lower().startswith(a.lower() + sep): return t[len(a) + len(sep):].strip()
    return t

def no_artist_in_title(a, t):
    """'Outkast - Roses' tagged as the title of an Outkast track -> 'Roses'."""
    if a and t.lower().startswith(a.lower() + " - "): return t[len(a) + 3:].strip()
    return t

def clean_name(p, r):
    a, t = r.get("artist", ""), r.get("title", "")
    if not (a and t): a, t = guess_names(p, r)
    a, t = strip_junk(a), strip_junk(t)
    t = no_artist_in_title(a, t)
    name = f"{a} - {t}" if a and t else (t or a)
    return re.sub(r'[\\/:*?"<>|]+', "", name).strip() + r["ext"]

LABEL_WORDS = re.compile(r"\b(records?|recordings|music|distribution|official|tv|radio|label|productions?|entertainment|collective|channel|sounds?|vibes|house|underground)\b|^@", re.I)

def _nrm(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def channel_like(rows):
    """Artist tags that are really the uploader: a YouTube channel we downloaded from, a label-sounding name, or one name stamped on 3+ files
    whose file names each start with a DIFFERENT artist. Returns the set of normalised names."""
    chans = set()
    try:
        import json
        hp = Path(__file__).parent / "history.json"
        for e in json.loads(hp.read_text()):
            c = e.get("channel") or ""
            if c and c not in ("Unknown channel", "Your files"): chans.add(_nrm(c))
    except Exception: pass
    diff = {}
    for p, r in rows.items():
        a, st = r.get("artist", ""), Path(p).stem
        if a and " - " in st and _nrm(st.split(" - ", 1)[0]) != _nrm(a): diff.setdefault(_nrm(a), set()).add(_nrm(st.split(" - ", 1)[0]))
    out = {a for a, v in diff.items() if len(v) >= 3}
    return out | chans

def file_artist(p):
    """'Artist - Title' from the file name when it really looks like one (not 'Title (Mix) - Artist')."""
    st = strip_junk(nfc(Path(p).stem))
    if " - " not in st: return "", ""
    a, t = (x.strip() for x in st.split(" - ", 1))
    if not a or not t or BAD_ARTIST.match(a) or re.search(r"[()\[\]]|\b(remix|mix|edit|version)\b", a, re.I): return "", ""
    return a, t

def propose_fixes():
    """Renames (junk out of the name, 'Artist - Title') and tags fixed from what the file already tells us. Nothing is changed here.
    An artist is only ever REPLACED when it is noise ('Unknown Artist', 'X - Topic', a site name); a real-looking artist is never touched.
    Missing artist: taken from the file name ('Artist - Title', or 'First Last-Title' when two+ capitalised words precede a bare hyphen)."""
    out = []; rows = index(); chan = channel_like(rows)
    try: hid = {nfc(h) for h in hiddenfiles.hidden()}
    except Exception: hid = set()   # a damaged hidden.json must not stop Tidy; renames of forgotten files are then just offered
    for p, r in rows.items():
        if not r.get("ok") or not os.path.exists(p) or nfc(p) in hid: continue   # a forgotten file must not be renamed back into view
        new = clean_name(p, r); stem_junk = has_junk(Path(p).stem) or has_junk(r["artist"] + " " + r["title"])
        fa, ft = guess_names(p, r)
        if not (r["artist"] or fa):   # last resort for a missing artist: a bare hyphen after a two-word (or longer) name
            ha, ht = split_name(strip_junk(nfc(Path(p).stem)))
            if ha: fa, ft = ha, ht
        tags = None
        # the artist tag is the uploader / label / remixer, but the file name names the real artist
        ca, ct = file_artist(p)
        if r["artist"] and ca and _nrm(ca) != _nrm(r["artist"]) and _nrm(ca) not in _nrm(r["artist"]) and _nrm(r["artist"]) not in _nrm(ca) and r["ext"] in (".mp3", ".flac", ".m4a"):
            na = _nrm(r["artist"])
            if na in chan or LABEL_WORDS.search(r["artist"]) or (na and na in _nrm(ct) and "(" in ct):
                tags = {"artist": ca, "title": title_without_artist(ca, r["title"].strip() or ct)}
                if tags["title"] == r["title"] and r["title"] and _nrm(ca) in _nrm(r["title"]): tags["title"] = ct
                out.append({"path": p, "name": Path(p).name, "new": new if (new != Path(p).name and stem_junk) else None, "tags": tags, "old": {"artist": r["artist"], "title": r["title"]}, "why": "channel"})
                continue
        art = clean_artist(r["artist"]); bad_art = bool(r["artist"]) and art != r["artist"]
        doubled = no_artist_in_title(r["artist"] or fa, r["title"]) != r["title"]
        if (not r["artist"] or not r["title"] or doubled or bad_art or has_junk(r["artist"] + " " + r["title"])) and r["ext"] in (".mp3", ".flac", ".m4a"):
            t0 = r["title"]; t1 = (strip_junk(t0) if has_junk(t0) else t0.strip())
            ta, tt = (fa, ft) if (not r["artist"] and t0 and has_junk(t0)) else (art or fa, t1 or ft)
            tt = title_without_artist(ta, no_artist_in_title(ta, tt))
            if ta and tt and (ta, tt) != (r["artist"], r["title"]): tags = {"artist": ta, "title": tt}
        rename = new != Path(p).name and stem_junk
        if rename or tags: out.append({"path": p, "name": Path(p).name, "new": new if rename else None, "tags": tags, "old": {"artist": r["artist"], "title": r["title"]}})
    return out

# Stores that hold a file path (or the id made from it) on the user's behalf. A rename would strand those references, so a
# file named in any of them keeps its name (its tags are still fixed). history.json is not listed: apply_fixes' caller moves those paths.
REF_STORES = ("crates.json", "rb_links.json", "energy_tags.json", "manual_owned.json", "mixes.json", "taste.json", "votes.json")

def referenced(paths):
    """The subset of paths that a crate, set, Rekordbox link, energy tag, manual-owned mark, mix or vote refers to (by path or by path-made id)."""
    texts = []
    for n in REF_STORES:
        try: texts.append((HERE / n).read_text(encoding="utf-8"))
        except OSError: pass
    out = set()
    try: import relocate; homes = relocate.targets()   # the new home of a reconnected track: renaming it would lose the track again
    except Exception: homes = set()
    for p in paths:
        keys = (fid(p), nfc(p), json.dumps(nfc(p))[1:-1], json.dumps(posix(p))[1:-1])
        if nfc(p) in homes or any(k in t for t in texts for k in keys): out.add(nfc(p))
    return out

def apply_fixes(paths):
    """Plan every rename/tag change, write the plan to the log, THEN do it file by file. A failure on one file leaves it as it was and
    carries on; whatever did happen is on record, so Undo always matches reality. A file that crates/sets/links refer to is not renamed."""
    wanted = {nfc(p) for p in paths}; batch = new_batch(); failed = []; kept = []
    fixes = [fx for fx in propose_fixes() if nfc(fx["path"]) in wanted]
    held = referenced([fx["path"] for fx in fixes if fx["new"]])
    plan = []; taken = set()
    for fx in fixes:
        p = fx["path"]; ops = []
        if fx["tags"]: ops.append({"type": "tags", "path": p, "old": fx["old"], "new": fx["tags"]})
        if fx["new"]:
            if nfc(p) in held: kept.append({"path": p, "why": "it is in a crate, set or link, so its name stays"})
            else:
                dst = posix(Path(p).with_name(fx["new"])); n = 2
                while (os.path.exists(dst) or dst in taken) and dst != p: dst = posix(Path(p).with_name(f"{Path(fx['new']).stem} ({n}){Path(fx['new']).suffix}")); n += 1
                if dst != p: ops.append({"type": "move", "from": p, "to": dst}); taken.add(dst)
        if ops: plan.append((fx, ops))
    if not plan: return {"batch": None, "changed": 0, "failed": failed, "kept": kept, "moves": []}
    _log(batch, "fix", [o for _, ops in plan for o in ops], state="open")
    done = []
    try:
        for fx, ops in plan:
            p = fx["path"]
            try:
                for o in ops:
                    if o["type"] == "tags":
                        import mutagen
                        f = mutagen.File(p, easy=True)
                        if f is None: raise ValueError("unreadable")
                        if f.tags is None: f.add_tags()
                        f["artist"], f["title"] = o["new"]["artist"], o["new"]["title"]; f.save()
                    else:
                        os.rename(o["from"], o["to"]); p = o["to"]
                    o["done"] = True; done.append(o)
            except Exception as e:
                for o in ops:
                    if "done" not in o: o["done"] = False
                failed.append({"path": fx["path"], "error": str(e)[:120]})
    finally:
        _journal(batch, ops=[o for _, ops in plan for o in ops], state="complete" if not failed else "partial")
        _reindex(done)
    moves = [(o["from"], o["to"]) for o in done if o["type"] == "move"]
    return {"batch": batch, "changed": len(done), "failed": failed, "kept": kept, "moves": moves}

def _reindex(ops):
    with LOCK:
        d = _load(INDEX, {}); f = d.get("files", {})
        for o in ops:
            if o["type"] == "move": f.pop(nfc(o["from"]), None); f[nfc(o["to"])] = _read(o["to"]) if os.path.exists(o["to"]) else None
            elif o["type"] == "tags" and os.path.exists(o["path"]): f[nfc(o["path"])] = _read(o["path"])
        d["files"] = {k: v for k, v in f.items() if v}
        if d: _atomic(INDEX, d)

def undo(batch):
    """Reverse a batch from what is actually on disk, so it can be run again after a part-way undo or a crash.
    A move whose file is already back (or never left) counts as done; one with a different file in the way is reported as blocked."""
    d = _load(LOG, {"batches": []}); b = next((x for x in d["batches"] if x["batch"] == batch and not x["undone"]), None)
    if not b: return {"error": "nothing to undo"}
    back = []; blocked = []
    for o in reversed(b["ops"]):
        if o.get("done") is False: continue   # this step never happened
        if o["type"] == "move":
            src, dst = o["to"], o["from"]
            if os.path.exists(src) and not os.path.exists(dst):
                Path(dst).parent.mkdir(parents=True, exist_ok=True); os.rename(src, dst); back.append(o)
            elif os.path.exists(dst) and not os.path.exists(src): back.append(o)   # already back (an earlier Undo got this far)
            elif os.path.exists(dst) and os.path.exists(src): blocked.append(dst)   # something else now sits at the original place
            else: blocked.append(src)   # the moved file is gone
        elif o["type"] == "tags":
            try:
                import mutagen
                p = o["path"]
                for x in b["ops"]:
                    if x["type"] == "move" and x["from"] == p and os.path.exists(x["to"]): p = x["to"]   # file may have been renamed in the same batch
                if not os.path.exists(p): p = o["path"]
                f = mutagen.File(p, easy=True)
                if f is not None:
                    for k in ("artist", "title"):
                        if o["old"].get(k): f[k] = o["old"][k]
                        elif k in f: del f[k]
                    f.save()
            except Exception: blocked.append(o["path"])
    if not blocked: b["undone"] = True
    with LOCK: _atomic(LOG, d)
    if b["ops"]: JOB.update(state="idle"); scan()   # refresh the index in the background
    return {"restored": len(back), "blocked": blocked}

def batch_info(batch):
    """What else a batch changed (crate memberships, hidden paths, history path moves, a crate swap), for the full Undo."""
    b = next((x for x in _load(LOG, {"batches": []})["batches"] if x["batch"] == batch), None)
    return {k: b.get(k) for k in ("kind", "memb", "paths", "hist_moves", "swap", "reloc", "undone")} if b else {}

def history():
    return [{"batch": b["batch"], "kind": b["kind"], "time": b["time"], "count": len(b["ops"]) or len(b.get("paths") or []) or len(b.get("reloc") or []), "undone": b["undone"]} for b in reversed(_load(LOG, {"batches": []})["batches"])][:30]
