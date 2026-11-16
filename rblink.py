"""Rekordbox playlists -> crates. Tracks stay where they are (e.g. /Volumes/MUSIC): we keep a LINK, never a copy.
Rekordbox is read through a temporary copy of master.db and never written.
rb_links.json = linked tracks + which playlist became which crate. User data: never wipe; atomic writes.
Linked tracks are merged IN MEMORY (load_all) only where crates / sets / playback read tracks; history.json is never touched."""
import json, logging, os, re, shutil, tempfile, threading, time
from pathlib import Path
import setbuild, crates
from paths import posix, safe_replace, note

FILE = Path(__file__).parent / "rb_links.json"
REF = Path(__file__).parent / "tools" / "ref"
LOCK = threading.Lock()


def _load():
    try: d = json.loads(FILE.read_text())
    except (OSError, ValueError): d = {}
    d.setdefault("tracks", {}); d.setdefault("playlists", {}); return d

def _save(d):
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, indent=1)); safe_replace(tmp, FILE)


def load_all(hist):
    """History plus linked Rekordbox tracks (a new list; never saved). A track that is already a download keeps its history entry."""
    links = _load()["tracks"]
    have = {setbuild.nfc(e["file"]) for e in hist if e.get("file")}
    out = list(hist) + [e for e in links.values() if setbuild.nfc(e["file"]) not in have]
    lib_mv = {}
    try:   # files that moved and were reconnected (relocate.py): read from their new place, same id, nothing saved
        import relocate
        mv = relocate.moves()
        if mv:
            out = relocate.apply(out, mv)
            mine = {setbuild.nfc(e["moved_from"]) for e in out if e.get("moved_from")}
            lib_mv = {o: n for o, n in mv.items() if o not in mine}   # the rest belong to scanned files
    except Exception as _e: note("rblink: moved files", _e)
    try:   # files found by the library scan (libindex) that nothing else knows yet
        import libindex
        out += libindex.entries(skip_files=[e["file"] for e in out if e.get("file")], moved=lib_mv)
    except Exception as _e: note("rblink: USB scan entries missing from the library", _e)
    try:   # files the user removed from Waxfinder ('hidden.json'): still on the drive, but not part of the library
        import hiddenfiles
        gone = hiddenfiles.hidden()
        if gone: out = [e for e in out if not e.get("file") or (setbuild.nfc(e["file"]) not in gone and setbuild.nfc(e.get("moved_from") or e["file"]) not in gone)]
    except RuntimeError: raise
    except Exception as _e: note("rblink: gone-file filter", _e)
    return out


def _open():
    """(tempdir, MasterDatabase) on a copy of this Mac's Rekordbox library."""
    logging.getLogger("pyrekordbox").setLevel(logging.CRITICAL)
    from pyrekordbox.masterdb import MasterDatabase
    src = setbuild.RB_DB
    if not src.exists(): raise FileNotFoundError("No Rekordbox library on this computer")
    d = tempfile.mkdtemp()
    for f in src.parent.glob("master.db*"):
        if f.name in ("master.db", "master.db-wal", "master.db-shm"): shutil.copy2(f, Path(d) / f.name)
    return d, MasterDatabase(path=str(Path(d) / "master.db"))


def _tree(m):
    """playlist id -> (path-name, [content ids in playlist order]) for real playlists (not folders)."""
    pls = {str(p.ID): p for p in m.get_playlist().all()}
    songs = {}
    for s in m.get_playlist_songs().all(): songs.setdefault(str(s.PlaylistID), []).append((s.TrackNo or 0, str(s.ContentID)))
    def label(p):
        parts = []
        while p:
            parts.append(p.Name or "")
            p = pls.get(str(p.ParentID)) if p.ParentID and str(p.ParentID) != "root" else None
        return " / ".join(reversed(parts))
    out = {}
    for pid, p in pls.items():
        ids = [c for _, c in sorted(songs.get(pid, []))]
        if p.Attribute == 1 or not ids: continue
        out[pid] = (label(p), p.Name or label(p), ids)
    return out


def playlists():
    """Every playlist with how many of its tracks are playable right now, and which are already imported."""
    d, m = _open()
    try:
        content = {str(c.ID): c for c in m.get_content().all()}
        tree = _tree(m)
    finally:
        try: m.close()
        except Exception: pass
        shutil.rmtree(d, ignore_errors=True)
    done = {c.get("rb_playlist") for c in crates._load()["crates"]}; out = []   # "imported" = its crate still exists
    out = []
    for pid, (label, _name, ids) in tree.items():
        ok = [c for c in ids if content.get(c) and content[c].FolderPath and os.path.exists(content[c].FolderPath)]
        out.append({"id": pid, "name": label, "total": len(ids), "ok": len(ok), "cids": list(dict.fromkeys(ok)),
                    "imported": "rb:" + pid in done})
    out.sort(key=lambda r: r["name"].lower())
    return out


def _info(c):
    """Plain facts about a track, read while the database copy is open (ArtistName is a lazy relation)."""
    return {"id": str(c.ID), "path": c.FolderPath, "artist": c.ArtistName, "title": c.Title, "length": c.Length}

_JUNK = re.compile(r"\s*[\[(]\s*[\w-]+(?:\.[\w-]+)*\.(?:cc|com|net|org|to|io|me|ru|co|fm)\s*[\])]", re.I)   # "[ ezmp3.cc ]" style download-site tags

def _entry(c):
    p = Path(c["path"]); artist, title = (c["artist"] or "").strip(), _JUNK.sub("", c["title"] or "").strip()
    stem = _JUNK.sub("", p.stem).strip()
    if not artist and " - " in stem: artist, _, title = (x.strip() for x in stem.partition(" - "))   # tags often have no artist; the filename is Artist - Title
    title = title or stem
    return {"id": "rb" + c["id"], "rb": True, "file": posix(p), "ext": p.suffix.lstrip(".").lower(), "url": "", "channel": "Rekordbox",
            "channel_url": "", "date": 0, "duration": int(c["length"] or 0), "artist": artist, "rbtitle": title,
            "title": f"{artist} - {title}" if artist else title}


def import_playlists(pids, hist):
    """Make one crate per ticked playlist from the files already on disk. Re-importing a playlist adds only what is new."""
    pids = [str(p) for p in dict.fromkeys(pids or ())]
    if not pids: return {"crates": [], "linked": 0, "skipped": 0}
    d, m = _open()
    try:
        tree = _tree(m); want = {c for _, _, ids in (tree[p] for p in pids if p in tree) for c in ids}
        content = {str(c.ID): _info(c) for c in m.get_content().all() if str(c.ID) in want}
    finally:
        try: m.close()
        except Exception: pass
        shutil.rmtree(d, ignore_errors=True)
    with LOCK:
        data = _load(); by_path = {setbuild.nfc(e["file"]): e["id"] for e in hist if e.get("file")}
        if (crates.FILE).exists() and not list(REF.glob("crates.before-rb-import-*.json")):
            shutil.copy2(crates.FILE, REF / f"crates.before-rb-import-{time.strftime('%Y%m%d-%H%M')}.json")   # one safety copy before the first import
        made, linked, skipped = [], 0, 0
        for pid in pids:
            if pid not in tree: continue
            label, name, cids = tree[pid]; ids = []
            for cid in cids:
                c = content.get(cid)
                if not (c and c["path"] and os.path.exists(c["path"])): skipped += 1; continue
                key = setbuild.nfc(c["path"])
                if key in by_path: ids.append(by_path[key]); continue          # already a Waxfinder download: use that track
                e = _entry(c)
                linked += e["id"] not in data["tracks"]; data["tracks"][e["id"]] = e   # refreshed each time; only genuinely new ones are counted
                by_path[key] = e["id"]; ids.append(e["id"])
            _save(data)                                                           # links first, so the crate never points at unknown ids
            want = set(ids); merged = hist + [e for e in data["tracks"].values() if e["id"] in want]
            r = crates.crate_from_playlist(merged, "rb:" + pid, name, ids)
            data["playlists"][pid] = {"name": label, "crate": r["id"], "ts": time.time()}
            made.append({**r, "playlist": label, "tracks": len(ids)})
    return {"crates": made, "linked": linked, "skipped": skipped}
