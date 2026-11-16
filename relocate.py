"""Moved files: a track whose file is no longer where Waxfinder last saw it (folder renamed, music copied to another drive or
onto this computer) can be found again and reconnected, keeping its crates, sets, energy tags, analysis and waveforms.

Nothing is rewritten. relocated.json holds {old path: new path}; the library (rblink.load_all) reads each moved track from its new
place while every saved id and path stays as it was, so Undo is simply forgetting the pair. If the file turns up at its old
place again, the old place wins and the pair is ignored.

A match needs the SAME FILE NAME, and then either the same size in bytes (ticked) or, when the old size was never recorded, the
same length (ticked). Same name but a different size is offered unticked. Several possible matches = left alone and counted.
relocated.json is per computer (not in git). Paths are stored '/'-separated like everywhere else."""
import json, os, threading, time, unicodedata
from pathlib import Path
from paths import posix, atomic_write, note

FILE = Path(__file__).parent / "relocated.json"
LOCK = threading.RLock()
MAX_FILES = 300_000          # a search stops reading a folder tree after this many audio files
_MEMO = {"sig": None, "moves": {}}
_LAST = {}                   # old path -> the row offered by the last search (apply only accepts these)


def nfc(x): return unicodedata.normalize("NFC", posix(x))

def _read():
    """{old: new}. A damaged file raises: starting empty would let the next save drop every reconnected track."""
    try: d = json.loads(FILE.read_text(encoding="utf-8"))
    except FileNotFoundError: return {}
    m = d["moves"]
    if not isinstance(m, dict): raise ValueError("relocated.json: moves is not a table")
    return m

def _all():
    """Every saved pair, re-read only when the file changes. Reading never fails the library: a damaged file is reported and ignored."""
    try: st = os.stat(FILE); sig = (st.st_size, st.st_mtime_ns)
    except OSError: sig = None
    if sig != _MEMO["sig"] or sig is None:
        try: _MEMO["moves"] = _read()
        except Exception as ex: note("relocate: relocated.json unreadable", ex); _MEMO["moves"] = {}
        _MEMO["sig"] = sig
    return _MEMO["moves"]

def moves():
    """The pairs in force right now: {old path: new path}. A pair whose old file is back where it was is skipped."""
    import setbuild
    return {o: n for o, n in _all().items() if not setbuild.exists(o)}

def targets():
    """New homes of moved tracks (must not be renamed or adopted as new songs behind the library's back)."""
    return {nfc(n) for n in _all().values()}

def apply(entries, mv):
    """Entries with moved files pointed at their new place (copies; the originals and every saved id are untouched)."""
    if not mv: return entries
    out = []
    for e in entries:
        f = e.get("file"); n = mv.get(nfc(f)) if f else None
        out.append({**e, "file": n, "moved_from": f} if n else e)
    return out


# ---------- find ----------
def _old(e): return e.get("moved_from") or e["file"]

def _known_size(key):
    """Bytes of the file as last seen, from the scan index or any saved analysis ('size:mtime'). None = never recorded."""
    import setbuild, energy, soundindex, libindex
    r = libindex.index().get(key)
    if r and r.get("size"): return int(r["size"])
    for store in (setbuild.CACHE, energy.FEATS, soundindex.CACHE):
        c = store.get(key)
        try:
            if c and c.get("sig"): return int(str(c["sig"]).split(":")[0])
        except (ValueError, AttributeError): pass
    return None

def _walk(folders):
    """file name (lower case) -> [(path, size)] for every audio file under the folders. Hidden folders and the trash folder are skipped."""
    import libindex
    by, n = {}, 0
    for root in folders:
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if not d.startswith(".") and d != libindex.TRASH_NAME]
            for name in fn:
                if name.startswith(".") or Path(name).suffix.lower() not in libindex.EXTS: continue
                p = os.path.join(dp, name)
                try: size = os.stat(p).st_size
                except OSError: continue
                by.setdefault(nfc(name).casefold(), []).append((posix(p), size)); n += 1
                if n >= MAX_FILES: return by, True
    return by, False

def _renamed():
    """old path -> where Clean up's own renames (lib_log.json, not undone) finally put the file."""
    import libindex
    mv = {}
    for b in libindex._load(libindex.LOG, {"batches": []})["batches"]:
        if b.get("undone"): continue
        for o in b.get("ops") or ():
            if o.get("type") == "move" and o.get("done") is not False: mv[nfc(o["from"])] = o["to"]
    def final(p):
        seen = set()
        while nfc(p) in mv and nfc(p) not in seen: seen.add(nfc(p)); p = mv[nfc(p)]
        return p
    return {o: final(o) for o in mv}

def summary(lib):
    """How many library tracks have no file right now, and whether there is anywhere to look without asking."""
    import setbuild, libindex
    setbuild.forget_stats()
    return {"missing": sum(1 for e in lib if e.get("file") and not setbuild.exists(e["file"])), "tracks": len(lib),
            "can_search": bool(libindex.roots()), "reconnected": len(moves())}

def find(lib, folder=None, only_renamed=False):
    """Look for the library's missing files by name under `folder` (or the library's own folders). Read-only.
    only_renamed: no folder search, just the files Clean up renamed itself (its log says where each went)."""
    import setbuild, libindex
    setbuild.forget_stats()
    folders = ["-"] if only_renamed else [folder] if folder else libindex.roots()
    gone = [e for e in lib if e.get("file") and not setbuild.exists(e["file"])]
    if not folders and not gone: return {"missing": 0, "found": [], "several": 0, "left": 0}
    if not folders: return {"missing": len(gone), "found": [], "several": 0, "left": len(gone), "nowhere": True}
    by, capped = ({}, False) if only_renamed else _walk(folders)
    taken = targets() | {nfc(e["file"]) for e in lib if e.get("file") and not e.get("lf") and setbuild.exists(e["file"])}
    rows, several, used = [], 0, set(); ren = _renamed()
    for e in gone:
        old = nfc(_old(e)); t = ren.get(old)
        if t and nfc(t) != old and ("/" + libindex.TRASH_NAME + "/") not in posix(t) and os.path.isfile(t) and nfc(t) not in taken and nfc(t) not in used:
            used.add(nfc(t))   # Clean up renamed this file itself: its log says exactly where it went
            rows.append({"old": old, "new": posix(t), "name": os.path.basename(t), "title": e.get("title") or os.path.basename(old), "why": "renamed", "tick": True}); continue
        cands = [c for c in by.get(nfc(os.path.basename(old)).casefold(), []) if nfc(c[0]) not in taken and nfc(c[0]) != old]
        if not cands: continue
        size = _known_size(old); why = None
        if size:
            same = [c for c in cands if c[1] == size]
            if len(same) == 1: pick, why = same[0], "same"
            elif len(same) > 1: several += 1; continue
            elif len(cands) == 1: pick, why = cands[0], "size"      # same name, different size: offered, not ticked
            else: several += 1; continue
        else:
            if len(cands) > 1: several += 1; continue
            pick = cands[0]; dur = e.get("duration"); got = (libindex._read(pick[0]) or {}).get("dur")
            why = "length" if (not dur or not got or abs(float(dur) - float(got)) <= 2) else "size"
        if nfc(pick[0]) in used: several += 1; continue       # two missing tracks claim one file: leave both
        used.add(nfc(pick[0]))
        rows.append({"old": old, "new": pick[0], "name": os.path.basename(pick[0]), "title": e.get("title") or os.path.basename(old), "why": why, "tick": why != "size"})
    held = libindex.referenced([r["new"] for r in rows]) if rows else set()   # the found file is already a library track in a crate/set of its own
    rows = [r for r in rows if nfc(r["new"]) not in held]
    _LAST.clear(); _LAST.update({r["old"]: r for r in rows})
    rows.sort(key=lambda r: r["name"].lower())
    return {"missing": len(gone), "found": rows, "several": several, "left": len(gone) - len(rows) - several, "where": [posix(f) for f in folders], "capped": capped}


# ---------- reconnect / undo ----------
def _carry(pairs):
    """Give the saved analysis, energy features and sound fingerprint of each moved file to its new path (the old ones stay)."""
    import setbuild, energy, soundindex
    from paths import safe_replace
    def copy(store, lock, save):
        n = 0
        with lock:
            for old, new in pairs:
                k = nfc(new); c = store.get(old)
                if not c or k in store: continue
                try: sig = setbuild._sig(new)
                except OSError: continue
                store[k] = {**c, "sig": sig}; n += 1
            if n: save()
    def save_set():
        tmp = setbuild.CACHE_FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps(setbuild.CACHE)); safe_replace(tmp, setbuild.CACHE_FILE)
    for store, lock, save, name in ((setbuild.CACHE, setbuild._LOCK, save_set, "analysis"), (energy.FEATS, energy._LOCK, lambda: energy._write(energy.FEATS_FILE, energy.FEATS), "energy"),
                                    (soundindex.CACHE, soundindex._LOCK, soundindex._save, "fingerprints")):
        try: copy(store, lock, save)
        except Exception as ex: note("relocate: carry " + name, ex)   # the track still reconnects; it would just be analysed again

def reconnect(olds):
    """Reconnect the ticked rows of the last search. Each is re-checked first: the new file must exist and the old one must still be gone."""
    import setbuild, libindex
    setbuild.forget_stats()
    with LOCK:
        d = dict(_read()); pairs = []; carry = []
        for o in dict.fromkeys(nfc(x) for x in olds or ()):
            r = _LAST.get(o)
            if not r or not os.path.isfile(r["new"]) or os.path.exists(o): continue
            pairs.append([o, r["new"], d.get(o)]); d[o] = r["new"]
            if r["why"] in ("same", "renamed"): carry.append((o, r["new"]))
        if not pairs: return {"moved": 0}
        atomic_write(FILE, json.dumps({"moves": d, "saved": time.time()}, indent=1, ensure_ascii=False))
        _MEMO["sig"] = None
    for o, *_ in pairs: _LAST.pop(o, None)
    _carry(carry)
    batch = libindex.record("relocate", reloc=pairs)
    setbuild.forget_stats()
    return {"moved": len(pairs), "batch": batch}

def auto(lib):
    """Clean up renamed a file that a Rekordbox link or download still points at by its old name: follow the rename, no asking.
    Runs at start-up and after every Names & tags tidy, so a rename can never leave a track behind. Journalled and undoable like any reconnect."""
    with LOCK:
        keep = dict(_LAST)
        try:
            r = find(lib, only_renamed=True)
            out = reconnect([x["old"] for x in r["found"] if x["why"] == "renamed"])
        finally:
            for o in list(keep):
                if o in _all(): keep.pop(o)
            _LAST.clear(); _LAST.update(keep)   # a search the person has open stays usable
    return out

def undo(pairs):
    """Forget reconnected pairs (each back to what it was before). Only pairs that still say what this batch wrote are touched."""
    import setbuild
    with LOCK:
        d = dict(_read()); n = 0
        for o, new, prev in pairs or ():
            if d.get(o) != new: continue
            if prev: d[o] = prev
            else: d.pop(o)
            n += 1
        if n: atomic_write(FILE, json.dumps({"moves": d, "saved": time.time()}, indent=1, ensure_ascii=False)); _MEMO["sig"] = None
    setbuild.forget_stats()
    return n
