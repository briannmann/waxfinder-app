"""Album art for the library. art_index.json + art/ are permanent user data; never rebuild or wipe them.

Order per song: (1) the cover embedded in the audio file (read-only, the file is never written),
(2) Deezer, (3) Apple iTunes Search. An online cover is only taken when the artist AND the title (and any remix name)
match; no cover beats a wrong cover. Every cover is shrunk to a 300px JPEG in art/ named by its content hash, so the
table and the player stay fast and the USB / music files are never touched.
A source that errors (rate limit, offline) is NOT recorded as 'checked', so it is tried again later. Misses are
remembered for RETRY_DAYS so restarts don't hammer the APIs. Files on an unplugged stick are skipped, not marked missed.
"""
import hashlib
import json
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import imageio_ffmpeg

import discogs_api
import genres
import setbuild
from names import split_artists
from paths import atomic_write, note

DIR = Path(__file__).parent
FILE = DIR / "art_index.json"
ART = DIR / "art"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SOURCES = ("deezer", "itunes", "discogs", "lastfm")
LOOSE = ("deezer", "lastfm", "itunes")   # second pass for versions/remixes the stores do not list: the ORIGINAL song's cover (flagged loose)
GAP = {"deezer": 0.3, "itunes": 3.2, "lastfm": 0.25}   # Discogs is paced by discogs_api itself (shared 59/min lane)      # seconds between calls (iTunes allows roughly 20 a minute)
COOLS = {"lastfm": 120}                    # Last.fm's 503s are brief: rest it 2 minutes, not 15
COOL = 15 * 60                              # a source that errors rests this long
RETRY_DAYS = 30
SIZE = 300
PAUSE_FILE = DIR / "art_paused"   # exists = the scan is paused (survives restarts). Delete it, or POST /art/resume, to carry on.
LOCK = threading.RLock()


def paused():
    return PAUSE_FILE.exists()


def pause():
    PAUSE_FILE.write_text("paused " + time.strftime("%Y-%m-%d %H:%M:%S") + "\n")
    JOB.update(state="paused", error="Paused: resumes when you say so")
    return dict(JOB)


def resume_scan(hist=None):
    PAUSE_FILE.unlink(missing_ok=True)
    return start(hist)

HIST_LOADER = None


def _load():
    try:
        d = json.loads(FILE.read_text())
    except FileNotFoundError:
        d = {}
    if not isinstance(d, dict):
        raise ValueError("Invalid art_index.json; existing art index was preserved")   # never silently replace a damaged store
    d.setdefault("tracks", {})   # entry id -> {f, src, emb, chk, t}
    d.setdefault("songs", {})    # genres.key(e) -> cover name, so copies of one song share a cover
    d.setdefault("bad_raw", ["7266ec62b29fb999864386feedf33614197eb476"])   # sha1 of the raw wrong image (Rekordbox-pasted cover), independent of how it is thumbnailed
    d.setdefault("bad", [])
    if "b1d5b2f2e5738d31" not in d["bad"]:
        d["bad"].append("b1d5b2f2e5738d31")   # Beatport's grey headphones placeholder, embedded in many Beatport files      # cover names that are known wrong (one image pasted across many tracks, Beatport placeholder): never used again
    return d


DB = _load()
JOB = {"state": "idle", "done": 0, "total": 0, "found": 0, "stage": "", "error": ""}
_cool = {}     # source -> time it may be used again
_last = {}     # source -> time of last call
_running = False
_timer = None


def _save():
    with LOCK:
        atomic_write(FILE, json.dumps(DB, ensure_ascii=False))


def name_for(e):
    """The cover file name for a library entry ('' when none yet). Cheap: dictionary lookups only."""
    rec = DB["tracks"].get(e.get("id"))
    return (rec or {}).get("f") or ""


def path_for(name):
    if not re.fullmatch(r"[0-9a-f]{16}", name or ""):
        return None
    p = ART / (name + ".jpg")
    return p if p.is_file() else None


# ---------- 1. embedded art ----------
def embedded(path):
    """Raw bytes of the first embedded picture, or None. Read-only."""
    try:
        import mutagen
        f = mutagen.File(path)
    except Exception:
        return None
    if f is None:
        return None
    try:
        pics = getattr(f, "pictures", None)          # FLAC / Ogg
        if pics:
            return bytes(pics[0].data)
        t = f.tags
        if t is None:
            return None
        for k in list(t.keys()):                      # ID3 (MP3, AIFF, WAV)
            if str(k).startswith("APIC"):
                return bytes(t[k].data)
        if "covr" in t and t["covr"]:                 # MP4 / M4A
            return bytes(t["covr"][0])
    except Exception:
        return None
    return None


def _probe(raw):
    """(width, height, has_alpha) of an image, from ffmpeg's own stream line. None if it isn't an image."""
    try:
        r = subprocess.run([FFMPEG, "-hide_banner", "-i", "pipe:0"], input=raw, capture_output=True, timeout=30)
        err = r.stderr.decode("utf-8", "replace")
    except Exception:
        return None
    m = re.search(r"Video: ([^\n]*?),? (\d{2,5})x(\d{2,5})", err)
    line = next((x for x in err.split("\n") if "Video:" in x), "")
    if not m:
        return None
    return int(m.group(2)), int(m.group(3)), bool(re.search(r"rgba|argb|bgra|abgr|ya8|yuva|gbra|pal8", line))


def _crop_plan(raw):
    """(x, y, side) for a centred square crop, or None when the image is already a clean square.
    YouTube covers are 16:9 frames; some are embedded as a square PNG with TRANSPARENT bars above and below. The real picture is the
    opaque area: find it, then take the centred square of that (the art sits in the middle of the frame)."""
    pr = _probe(raw)
    if not pr:
        return None
    w, h, alpha = pr
    x0, y0, x1, y1 = 0, 0, w, h
    if alpha:
        try:
            import numpy as np
            r = subprocess.run([FFMPEG, "-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], input=raw, capture_output=True, timeout=30)
            a = np.frombuffer(r.stdout, np.uint8)
            if a.size == w * h * 4:
                op = a.reshape(h, w, 4)[:, :, 3] > 24
                rows, cols = np.where(op.any(axis=1))[0], np.where(op.any(axis=0))[0]
                if rows.size and cols.size:
                    x0, x1, y0, y1 = int(cols[0]), int(cols[-1]) + 1, int(rows[0]), int(rows[-1]) + 1
        except Exception as ex:
            note("artwork: alpha box", ex)
    cw, ch = x1 - x0, y1 - y0
    if (x0, y0, x1, y1) == (0, 0, w, h) and abs(cw - ch) <= max(2, .02 * max(cw, ch)):
        return None
    side = min(cw, ch)
    return x0 + (cw - side) // 2, y0 + (ch - side) // 2, side


def _thumb(raw):
    """Image bytes -> a 300x300 JPEG through the bundled ffmpeg (png/jpg/webp). Non-square or padded pictures are cropped to the
    centred square of their real picture area so they fill the space like an album cover. None if it isn't an image."""
    if not raw or len(raw) < 200:
        return None
    plan = _crop_plan(raw)
    vf = (f"crop={plan[2]}:{plan[2]}:{plan[0]}:{plan[1]},scale={SIZE}:{SIZE}:flags=lanczos" if plan
          else f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=decrease")
    try:
        r = subprocess.run([FFMPEG, "-v", "error", "-i", "pipe:0", "-vf", vf, "-frames:v", "1", "-q:v", "3",
                            "-f", "image2", "-c:v", "mjpeg", "pipe:1"], input=raw, capture_output=True, timeout=30)
    except Exception:
        return None
    out = r.stdout
    return out if r.returncode == 0 and out[:2] == b"\xff\xd8" and len(out) > 500 else None


def _weak(raw):
    """True for an embedded picture that is a poor cover: a 16:9 video frame / padded picture whose real art is small, or a tiny image.
    (YouTube downloads embed these.) A weak cover is kept only as a fallback; the online sources are tried first."""
    pr = _probe(raw)
    if not pr:
        return False
    plan = _crop_plan(raw)
    return (plan[2] < 400) if plan else (min(pr[0], pr[1]) < 250)


def _store(jpg):
    ART.mkdir(exist_ok=True)
    name = _name(jpg)
    p = ART / (name + ".jpg")
    if not p.exists():
        tmp = p.with_name(name + f".{threading.get_ident()}.tmp")
        tmp.write_bytes(jpg)
        tmp.replace(p)
    return name


def _name(jpg):
    return hashlib.sha1(jpg).hexdigest()[:16]


SPREAD = 6   # one cover on this many DIFFERENT primary artists is a pasted-over cover, not an album


def _primary(a):
    first = (split_artists(a or "") or [a or ""])[0]
    return genres.norm(first)


def block(name):
    """Mark a cover as wrong. Every track holding it loses it and is looked up again (embedded art is not re-read)."""
    with LOCK:
        if name not in DB["bad"]:
            DB["bad"].append(name)
        n = 0
        for rec in DB["tracks"].values():
            if rec.get("f") == name:
                rec.pop("f", None); rec.pop("src", None)
                rec.update(emb=True, chk=[], t=0)
                n += 1
        DB["songs"] = {k: v for k, v in DB["songs"].items() if v != name}
        p = ART / (name + ".jpg")
        if p.exists():
            p.unlink()
        _save()
    return n


def sweep(hist):
    """Block any cover that sits on SPREAD or more different artists, plus anything already on the bad list. Returns {name: tracks reset}."""
    out = {}
    with LOCK:
        for name in list(DB["bad"]):
            if any(r.get("f") == name for r in DB["tracks"].values()):
                out[name] = block(name)
        by = {}
        for e in hist:
            rec = DB["tracks"].get(e.get("id"))
            if rec and rec.get("f") and e.get("file"):
                by.setdefault(rec["f"], set()).add(_primary(names(e)[0]))
        for name, artists in by.items():
            artists.discard("")
            if len(artists) >= SPREAD:
                out[name] = block(name)
    return out


# ---------- 2/3. online ----------
def _get(src, url):
    """GET json, paced per source. Raises on any HTTP / network problem (the caller cools the source down)."""
    wait = GAP[src] - (time.monotonic() - _last.get(src, 0))
    if wait > 0:
        time.sleep(wait)
    _last[src] = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": "Waxfinder/1.0 (personal music library)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _image(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Waxfinder/1.0 (personal music library)"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read(8 * 1024 * 1024)


_CODE = re.compile(r"[A-Za-z]{2,8}[ -]?\d{2,5}[A-Za-z]?")


def _clean(t):
    """A track title as the stores would write it: no site junk, no catalogue codes / years in brackets, no feat. credit in the body,
    no half-open bracket from a truncated file name, underscores as spaces."""
    t = (t or "").replace("_", " ")
    t = re.sub(r"\bwww\.\S+|\b[\w-]+\.(?:com|net|org|cc|me|io|ru|info)\b", " ", t, flags=re.I)        # my-free-mp3s.com, [ ezmp3.cc ]
    t = re.sub(r"[\(\[]\s*[\)\]]", " ", t)

    def drop(m):
        inner = m.group(1).strip()
        return " " if (_CODE.fullmatch(inner) or re.fullmatch(r"(?:19|20)\d\d|\d+", inner)) else m.group(0)
    t = re.sub(r"[\(\[]([^\)\]]*)[\)\]]", drop, t)                                               # [PHREEK016], (SCDD011), (2001)
    t = re.sub(r"\s*[\(\[][^\)\]]*$", "", t)                                                       # "Natural High (Mike Dunn Black Gl" -> cut off mid-bracket
    t = re.sub(r"\s+(?:feat\.?|ft\.?|featuring)\s+[^\(\[\-\u2013\u2014]+", " ", t, flags=re.I)         # "... Featuring Ania Szarmach (Zed Bias ...)"
    return re.sub(r"\s+", " ", t).strip(" -\u2013\u2014")


def _truncated(t):
    return bool(re.search(r"[\(\[][^\)\]]*$", t or ""))


_PREFIX = re.compile(r"^(.{2,80}?)(?:\s+[-\u2013\u2014]\s*|\s*[\u2013\u2014]\s+)(.+)$")


def _cands(e):
    """(artist, title) pairs to look up, best first: the names we hold; the artist read out of a 'Artist - Title' title; the file name's own split."""
    a0, t0 = names(e)
    out, seen = [], set()

    def add(a, t):
        a, t = (a or "").strip(), _clean(t)
        k = (genres.norm(a), genres.norm(t))
        if a and t and k not in seen:
            seen.add(k)
            out.append((a, t))
    add(a0, t0)
    m = _PREFIX.match((t0 or "").replace("_", " "))
    if m:
        add(m.group(1), m.group(2))
    try:
        fa, ft = genres.identity(e)
        add(fa, ft)
    except Exception as ex:
        note("artwork: file-name split", ex)
    if not out and m:
        add(m.group(1), m.group(2))
    return out[:3]


_VERSION_OK = {"originalmix", "original", "extendedmix", "extended", "clubmix", "radioedit", "radiomix", "album version",
               "albumversion", "remastered", "remaster", "mix", "edit", "originalversion", "main", "mainmix"}


def _parts(title):
    """'Heaven (Joe Remix) [Label]' -> ('heaven', 'joeremix' or '')."""
    t = _clean(genres.clean_title(title or ""))
    base = genres.norm(re.sub(r"\s*[\(\[].*?[\)\]]", "", t))
    tags = [genres.norm(x) for x in re.findall(r"[\(\[]([^\)\]]*)[\)\]]", t)]
    tags = [x for x in tags if x and x not in _VERSION_OK]
    return base, "".join(tags)


def _artists(s):
    out = set()
    for a in split_artists(s or "") or [s or ""]:
        k = genres.norm(a)
        if k:
            out.add(k)
    whole = genres.norm(s or "")
    if whole:
        out.add(whole)
    return out


def _close(a, b):
    """Same name allowing a one-letter slip (swap / missing / extra / wrong letter; two for long names): 'siege' ~ 'seige'."""
    if a == b:
        return True
    n = max(len(a), len(b))
    if n < 5 or abs(len(a) - len(b)) > 2:
        return False
    limit = 1 if n < 12 else 2
    # Damerau-Levenshtein (optimal string alignment), small strings only
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            c = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)] <= limit


def _artists_match(x, y):
    return bool(x & y) or any(_close(p, q) for p in x for q in y if min(len(p), len(q)) >= 6)


def good(artist, title, r_artist, r_title, loose=False):
    """Strict: artist overlaps, title base equal, and a remix named in our title must appear in theirs."""
    if not _artists_match(_artists(artist), _artists(r_artist)):
        return False
    b, v = _parts(title)
    rb, rv = _parts(r_title)
    if len(b) < 3 or not _close(b, rb):
        return False
    if loose or _truncated(title):
        return True                      # our file name was cut off mid-bracket: the remix name is unknown, base title + artist is what we have
    if not v:
        return not rv                    # we have a plain title: don't take a remix / edit by someone else (its art differs)
    return v in rv or v in genres.norm(r_title or "")


def _qartist(artist):
    a = re.sub(r"\s+(?:feat\.?|ft\.?|featuring)\s+.*$", "", artist or "", flags=re.I).strip()
    return a if 0 < len(a) <= 40 else ((split_artists(a) or [a])[0])


def _qtitle(title):
    return re.sub(r"[\"\u201c\u201d*~|{}]", " ", re.sub(r"\s*[\(\[].*?[\)\]]", "", _clean(genres.clean_title(title or "")))).strip()


def _q(artist, title):
    return re.sub(r"\s+", " ", f"{_qartist(artist)} {_qtitle(title)}").strip()


def _deezer(artist, title, loose=False):
    d = _get("deezer", "https://api.deezer.com/search?limit=8&q=" + urllib.parse.quote(_q(artist, title)))
    if not isinstance(d, dict) or "data" not in d:
        raise RuntimeError("Deezer: unexpected reply")
    for r in d["data"]:
        al = r.get("album") or {}
        if good(artist, title, (r.get("artist") or {}).get("name", ""), r.get("title", ""), loose):
            return al.get("cover_big") or al.get("cover_medium")
    return None


def _itunes(artist, title, loose=False):
    d = _get("itunes", "https://itunes.apple.com/search?entity=song&limit=10&term=" + urllib.parse.quote(_q(artist, title)))
    if not isinstance(d, dict) or "results" not in d:
        raise RuntimeError("iTunes: unexpected reply")
    for r in d["results"]:
        if good(artist, title, r.get("artistName", ""), r.get("trackName", ""), loose):
            u = r.get("artworkUrl100") or ""
            return re.sub(r"/\d+x\d+(bb)?\.", "/600x600bb.", u) if u else None
    return None


def _discogs(artist, title, loose=False):
    """Discogs release search by artist + track. Artist must match the release's artist; a title that names a remix is only accepted when
    that release's tracklist has the remix (one extra request). Returns a cover URL or None."""
    base = _qtitle(title)
    first = _qartist(artist)
    q = "/database/search?type=release&per_page=10&artist=" + urllib.parse.quote(first) + "&track=" + urllib.parse.quote(base + "~")   # ~ = fuzzy: Discogs spells it "Seige"
    d = json.loads(discogs_api.read(q))
    if not isinstance(d, dict) or "results" not in d:
        raise RuntimeError("Discogs: unexpected reply")
    want_base, want_ver = _parts(title)
    if len(want_base) < 3:
        return None
    rows = [r for r in d["results"] if r.get("cover_image") and "spacer" not in r["cover_image"]]
    rows.sort(key=lambda r: "Compilation" in (r.get("format") or []))   # an artist's own release before a compilation
    for r in rows:
        prefix = (r.get("title") or "").split(" - ")[0]
        if prefix.lower().startswith("various") or not _artists_match(_artists(artist), _artists(prefix)):
            continue
        rel = json.loads(discogs_api.read("/releases/%s" % r["id"]))      # confirm the track really is on this release (fuzzy search can drift)
        tl = rel.get("tracklist", [])
        if not any(_close(want_base, _parts(t.get("title", ""))[0]) and (loose or not want_ver or want_ver in genres.norm(t.get("title", ""))) for t in tl):
            continue
        return r["cover_image"]
    return None


def _lastfm(artist, title, loose=False):
    """Last.fm track.getInfo with autocorrect (it fixes typos and formatting itself): the album cover of the matched track. Its grey
    star placeholder is not a cover. Cover URL or None."""
    import lastfm
    key = lastfm.api_key()
    if not key or len(genres.norm(_qtitle(title))) < 3:
        return None
    q = urllib.parse.urlencode({"method": "track.getInfo", "api_key": key, "format": "json", "autocorrect": 1,
                                "artist": _qartist(artist), "track": _qtitle(title)})
    try:
        d = _get("lastfm", "https://ws.audioscrobbler.com/2.0/?" + q)
    except urllib.error.HTTPError as ex:
        if ex.code not in (500, 502, 503, 504):
            raise
        time.sleep(2)                                      # Last.fm's 503s are momentary: one retry before the source rests
        d = _get("lastfm", "https://ws.audioscrobbler.com/2.0/?" + q)
    t = d.get("track") if isinstance(d, dict) else None
    if not t:
        return None                                        # {"error": 6, ...}: Last.fm doesn't know it
    if not good(artist, title, (t.get("artist") or {}).get("name", ""), t.get("name", ""), loose):
        return None
    imgs = (t.get("album") or {}).get("image") or []
    return next((i["#text"] for i in reversed(imgs) if i.get("#text") and "2a96cbd8b46e442fc41c2b86b821562f" not in i["#text"]), None)


FIND = {"deezer": _deezer, "itunes": _itunes, "discogs": _discogs, "lastfm": _lastfm}


# ---------- names used for the lookup ----------
def names(e):
    """(artist, title): the file's own tags when the library index has them, else the filename / Rekordbox names."""
    try:
        import libindex
        r = libindex.index().get(setbuild.nfc(e["file"])) or libindex.index().get(e["file"]) or {}
        if r.get("artist") and r.get("title"):
            return r["artist"], r["title"]
    except Exception as ex:
        note("artwork: names from library index", ex)
    return genres.identity(e)


# ---------- the job ----------
def needs(e):
    rec = DB["tracks"].get(e.get("id")) or {}
    if rec.get("f"):
        return False
    if not rec.get("emb") and setbuild.exists(e["file"]):
        return True
    if (set(SOURCES) | {x + "~" for x in LOOSE}) - set(rec.get("chk", [])):
        return True
    return time.time() - rec.get("t", 0) > RETRY_DAYS * 86400


def pending(hist):
    return [e for e in hist if e.get("file") and needs(e)]


LIMIT = {"deezer": 3, "itunes": 1, "discogs": 2, "lastfm": 2}   # how many name candidates each source gets (iTunes is slow, Discogs is a shared lane)


def _all_chk():
    return list(SOURCES) + [x + "~" for x in LOOSE]


def _has_version(cands):
    return any(_parts(t)[1] or _truncated(t) for _, t in cands)


def _online(rec, cands):
    """Strict pass over every source not yet checked, then (when a title names a version/remix) a loose pass that takes the original song's
    cover. chk holds 'src' (strict) and 'src~' (loose). Returns (cover name, source) or (None, None); rec['loose'] marks a loose cover."""
    chk = set(rec.get("chk", []))
    plan = [(src, False) for src in SOURCES]
    if _has_version(cands):
        plan += [(src, True) for src in LOOSE]
    else:
        chk.update(src + "~" for src in LOOSE)              # nothing to loosen: those checks are done
    for src, loose in plan:
        key = src + ("~" if loose else "")
        if key in chk or _cool.get(src, 0) > time.time():
            continue
        if loose and any(x not in chk and _cool.get(x, 0) <= time.time() for x in SOURCES):
            break                                           # strict matches first, everywhere (sources that are resting don't hold it up)
        failed = False
        for artist, title in cands[:LIMIT[src]]:
            try:
                url = FIND[src](artist, title, loose)
                jpg = _thumb(_image(url)) if url else None
            except Exception as ex:
                _cool[src] = time.time() + COOLS.get(src, COOL)   # rate limit / offline: rest this source, don't record it as checked
                note(f"artwork: {src} lookup", ex)
                failed = True
                break
            if jpg and _name(jpg) in DB["bad"]:
                jpg = None
            if jpg:
                chk.add(key)
                rec["chk"] = sorted(chk)
                rec["loose"] = 1 if loose else 0
                return _store(jpg), src
        if not failed:
            chk.add(key)
    rec["chk"] = sorted(chk)
    return None, None


def _one(e):
    """Work on one entry. Returns True when a cover was stored."""
    tid = e["id"]
    rec = DB["tracks"].setdefault(tid, {})
    if rec.get("t") and time.time() - rec["t"] > RETRY_DAYS * 86400 and not rec.get("f"):
        rec["chk"] = []                                   # old miss: try the sources again
    sk = genres.key(e)
    shared = DB["songs"].get(sk)
    if shared and shared not in DB["bad"] and path_for(shared):
        rec.update(f=shared, src="shared", t=int(time.time()))
        return True
    fallback = None
    if not rec.get("emb") and setbuild.exists(e["file"]):
        rawimg = embedded(e["file"])
        jpg = None if (rawimg and hashlib.sha1(rawimg).hexdigest() in DB["bad_raw"]) else _thumb(rawimg)
        rec["emb"] = True
        if jpg and _name(jpg) in DB["bad"]:
            jpg = None                                    # the file carries a known-wrong cover: ignore it, look online instead
        if jpg:
            name = _store(jpg)
            if not _weak(rawimg):
                rec.update(f=name, src="embedded", t=int(time.time()), v=2)
                DB["songs"][sk] = name
                return True
            fallback = name                               # a video frame / tiny picture: try the online sources first
            rec["wk"] = 1
    cands = _cands(e)
    if cands:
        name, src = _online(rec, cands)
        if name:
            rec.update(f=name, src=src, t=int(time.time()), v=2)
            DB["songs"][sk] = name
            return True
    else:
        rec["chk"] = _all_chk()
    if fallback:
        rec.update(f=fallback, src="embedded", t=int(time.time()), v=2)
        DB["songs"][sk] = fallback
        return True
    rec["t"] = int(time.time())
    return False


def upgrade_weak(hist):
    """One-time: covers already taken from a weak embedded picture (video frame / tiny) get a try at the online sources; a real match replaces
    them. Embedded stays when nothing better is found. Manual covers are never touched."""
    swapped, old = 0, set()
    for e in hist:
        rec = DB["tracks"].get(e.get("id"))
        if not rec or rec.get("src") != "embedded" or rec.get("wk") is not None or not rec.get("f") or not e.get("file"):
            continue
        if not setbuild.exists(e["file"]):
            continue
        raw = embedded(e["file"])
        rec["wk"] = 1 if (raw and _weak(raw)) else 0
        if not rec["wk"]:
            continue
        cands = _cands(e)
        if not cands:
            continue
        name, src = _online(rec, cands)
        if name and name != rec["f"]:
            old.add(rec["f"])
            rec.update(f=name, src=src, t=int(time.time()))
            DB["songs"][genres.key(e)] = name
            swapped += 1
        if swapped % 10 == 0:
            _save()
    with LOCK:
        still = {r.get("f") for r in DB["tracks"].values()} | set(DB["songs"].values())
        for n in old - still:
            q = ART / (n + ".jpg")
            if q.exists():
                q.unlink()
        _save()
    return swapped


def set_from_url(e, url):
    """Manual cover for one track from a Discogs release link or a direct image link. Never replaced by the automatic lookups."""
    url = (url or "").strip()
    m = re.search(r"discogs\.com/(?:[a-z]{2}/)?release/(\d+)", url)
    if m:
        rel = json.loads(discogs_api.read("/releases/" + m.group(1)))
        imgs = rel.get("images") or []
        img = next((i for i in imgs if i.get("type") == "primary"), imgs[0] if imgs else None)
        if not img:
            raise ValueError("That Discogs release has no picture")
        url = img.get("uri") or img.get("resource_url")
    if not re.match(r"https://", url or ""):
        raise ValueError("Needs a Discogs release link or an https image link")
    jpg = _thumb(_image(url))
    if not jpg:
        raise ValueError("Could not read that picture")
    name = _store(jpg)
    with LOCK:
        rec = DB["tracks"].setdefault(e["id"], {})
        rec.update(f=name, src="manual", t=int(time.time()), v=2, wk=0, emb=True, chk=_all_chk())
        DB["songs"][genres.key(e)] = name
        _save()
    return name


def _recrop_bg(hist):
    try:
        fixed = recrop(hist)
        if fixed:
            note(f"artwork: re-cropped {fixed} embedded covers to square")
    except Exception as ex:
        note("artwork: recrop", ex)
    try:
        up = upgrade_weak(hist)
        if up:
            note(f"artwork: replaced {up} weak embedded covers with a better match")
    except Exception as ex:
        note("artwork: upgrade weak", ex)


def recrop(hist):
    """One-time: embedded covers made before the square-crop fix (v < 2) are re-read from their files and re-made, so 16:9 YouTube
    frames and padded pictures fill the square. Files that can't be reached right now are left for next time."""
    done, by_raw, old_names = 0, {}, set()
    with LOCK:
        for e in hist:
            rec = DB["tracks"].get(e.get("id"))
            if not rec or rec.get("src") != "embedded" or rec.get("v", 1) >= 2 or not rec.get("f") or not e.get("file"):
                continue
            if not setbuild.exists(e["file"]):
                continue
            rawimg = embedded(e["file"])
            if not rawimg:
                rec["v"] = 2
                continue
            h = hashlib.sha1(rawimg).hexdigest()
            if h not in by_raw:
                j = None if h in DB["bad_raw"] else _thumb(rawimg)
                by_raw[h] = _store(j) if j else None
            new = by_raw[h]
            if new and new not in DB["bad"]:
                if new != rec["f"]:
                    old_names.add(rec["f"])
                    for k, v in DB["songs"].items():
                        if v == rec["f"]:
                            DB["songs"][k] = new
                    rec["f"] = new
                    done += 1
            rec["v"] = 2
        still = {r.get("f") for r in DB["tracks"].values()} | set(DB["songs"].values())
        for n in old_names - still:
            q = ART / (n + ".jpg")
            if q.exists():
                q.unlink()
        if done or old_names:
            _save()
    return done


def start(hist=None):
    """Find covers for everything outstanding, in the background. Safe to call repeatedly."""
    global _running, JOB
    hist = hist if hist is not None else (HIST_LOADER() if HIST_LOADER else [])
    if paused():
        JOB.update(state="paused", error="Paused: resumes when you say so")
        return dict(JOB)
    with LOCK:
        if _running:
            return dict(JOB)
        if DB.get("match_v", 1) < 2:                          # matching got much better (name cleaning, fuzzy, Discogs): old misses get another go
            for r in DB["tracks"].values():
                if not r.get("f"):
                    r["chk"] = []
                    r["t"] = 0
            DB["match_v"] = 2
            _save()
        try:
            reset = sweep(hist)
            if reset:
                note("artwork: blocked wrong covers " + json.dumps(reset))
        except Exception as ex:
            note("artwork: sweep", ex)
        threading.Thread(target=_recrop_bg, args=(hist,), daemon=True).start()   # one-time re-crop of older embedded covers, off the startup path
        todo = sorted(pending(hist), key=lambda e: -float(e.get("date") or 0))   # newest first: the Library's default top rows fill first
        if not todo:
            JOB.update(state="done" if DB["tracks"] else "idle", done=0, total=0, stage="", error="")
            return dict(JOB)
        _running = True
        JOB.update(state="working", done=0, total=len(todo), found=0, stage="Looking for album art", error="")

    def go():
        global _running, _timer
        try:
            for i, e in enumerate(todo):
                if paused():
                    break                                   # paused mid-run: stop at a clean point, progress is saved below
                try:
                    if _one(e):
                        JOB["found"] += 1
                except Exception as ex:
                    note("artwork: one track", ex)
                JOB["done"] = i + 1
                if (i + 1) % 10 == 0:
                    _save()
            _save()
            if paused():
                JOB.update(state="paused", error="Paused: resumes when you say so")
                return
            resting = [s for s in SOURCES if _cool.get(s, 0) > time.time()]
            if resting and pending(todo):
                JOB.update(state="paused", error=" and ".join(x.title() for x in resting) + " didn't answer; trying again in a few minutes")
                _timer = threading.Timer(max(30, min(_cool[x] for x in SOURCES if _cool.get(x, 0) > time.time()) - time.time() + 5), lambda: start())
                _timer.daemon = True
                _timer.start()
            else:
                JOB.update(state="done", stage="")
        except Exception as ex:
            note("artwork: job", ex)
            JOB.update(state="paused", error=str(ex)[:80])
        finally:
            _running = False

    threading.Thread(target=go, daemon=True).start()
    return dict(JOB)


def resume(hist):
    return start(hist)


def status(hist):
    p = len(pending(hist)) if not _running else max(0, JOB["total"] - JOB["done"])
    return {"job": dict(JOB), "have": sum(1 for r in DB["tracks"].values() if r.get("f")), "pending": p}
