"""Rename a track's artist/title from the Library (right-click > Rename).
The name Waxfinder shows comes from the file NAME (or Rekordbox data), and files are never renamed here: other things depend on their paths.
So a rename is a stored override (track_names.json, keyed by track id, path kept alongside) shown everywhere, plus a best-effort write of
the file's artist/title tags so a CDJ export carries the new name. Tag changes are logged like the Clean-up fixes (Undo there covers them)."""
import json, re, threading, time
from pathlib import Path

FILE = Path(__file__).parent / "track_names.json"
LOCK = threading.Lock()
_C = {"mt": None, "d": {}}

def _all():
    try: mt = FILE.stat().st_mtime
    except OSError: mt = None
    if mt != _C["mt"]:
        try: _C["d"] = json.loads(FILE.read_text())
        except (OSError, ValueError): _C["d"] = {}
        _C["mt"] = mt
    return _C["d"]

def get(tid): return _all().get(tid)

def clean(s): return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f]", " ", str(s or ""))).strip()

def _save(d):
    import libindex
    libindex._atomic(FILE, d); _C["mt"] = None

def _tags(path, artist, title):
    """Write artist/title tags; returns (old, error). Easy tags cover mp3/m4a/flac/ogg/aiff; others report why not."""
    import mutagen
    f = mutagen.File(path, easy=True)
    if f is None: return None, "this file type has no tags Waxfinder can write"
    old = {"artist": (f.get("artist") or [""])[0], "title": (f.get("title") or [""])[0]}
    if f.tags is None: f.add_tags()
    f["artist"], f["title"] = artist, title; f.save()
    return old, None

def rename(hist, tid, artist, title, was=None):
    artist, title = clean(artist), clean(title)
    if not title: return {"error": "Title can't be empty"}
    if len(artist) > 150 or len(title) > 200: return {"error": "That's too long"}
    e = next((x for x in hist if x.get("id") == tid), None)
    if not e or not e.get("file"): return {"error": "That track isn't in the library any more"}
    f = e["file"]; note = ""; tags_old = None
    try:
        import setbuild, libindex
        if not setbuild.exists(f): note = "Waxfinder only: the file isn't reachable (stick not plugged in)"
        else:
            old, err = _tags(f, artist, title)
            if err: note = "Waxfinder only: " + err
            else:
                tags_old = old; batch = time.strftime("%Y%m%d-%H%M%S")
                ops = [{"type": "tags", "path": f, "old": old, "new": {"artist": artist, "title": title}}]
                libindex._log(batch, "fix", ops); libindex._reindex(ops)
    except Exception as ex:
        note = "Waxfinder only: " + str(ex)[:80]
    with LOCK:
        d = dict(_all()); prev = d.get(tid) or {}
        d[tid] = {"artist": artist, "title": title, "path": f, "t": time.time(),
                  "old": prev.get("old") or {"artist": clean((was or {}).get("artist")), "title": clean((was or {}).get("title"))},
                  "tags_old": prev.get("tags_old") or tags_old}
        _save(d)
    return {"artist": artist, "title": title, "note": note}

def reset(hist, tid):
    with LOCK:
        d = dict(_all()); o = d.pop(tid, None)
        if not o: return {"error": "Nothing to reset"}
        _save(d)
    note = ""
    if o.get("tags_old") is not None:
        try:
            import setbuild
            if setbuild.exists(o["path"]): _tags(o["path"], o["tags_old"].get("artist", ""), o["tags_old"].get("title", ""))
        except Exception: note = "The file's tags were left as renamed"
    return {"artist": o["old"]["artist"], "title": o["old"]["title"], "note": note}

def apply(rows):
    """Show stored names on rows (dicts with id/artist/title)."""
    d = _all()
    if not d: return rows
    for r in rows:
        o = d.get(r.get("id"))
        if o: r["artist"], r["title"], r["renamed"] = o["artist"], o["title"], True
    return rows
