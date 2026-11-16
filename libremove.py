"""Library track removal, two explicit modes (the UI explains both before anything happens):
  forget : only Waxfinder lets go. The files stay exactly where they are on the drive. Hidden from the library, crates and picks.
  trash  : also moves the files off the library into the drive's `_Waxfinder Trash/<batch>/` folder (libindex.trash). Never a hard delete:
           Undo puts them back, and space is only freed when that folder is emptied by hand. Only files Waxfinder has scanned AND can reach
           right now are moved; anything else is left completely untouched and reported.
Both remove the tracks from every crate; the response carries what an Undo needs."""
import os
import crates, hiddenfiles, libindex, setbuild

def remove(hist, ids, mode):
    by = {e["id"]: e for e in hist}
    ents = [by[i] for i in dict.fromkeys(ids or ()) if i in by and by[i].get("file")]
    if not ents: return {"error": "Those tracks are no longer in the library"}
    batch, untouched, trashed = None, [], 0
    if mode == "trash":
        reach = [e for e in ents if os.path.isfile(e["file"])]
        r = libindex.trash([e["file"] for e in reach]) if reach else {"moved": 0, "skipped": [], "batch": None}
        skipped = {setbuild.nfc(p) for p in r["skipped"]}
        batch, trashed = (r["batch"] if r["moved"] else None), r["moved"]
        done = [e for e in reach if setbuild.nfc(e["file"]) not in skipped]
        untouched = [e for e in ents if e not in done]
    elif mode == "forget":
        done = ents
    else:
        return {"error": "Unknown mode"}
    paths = [e["file"] for e in done]
    if paths: hiddenfiles.hide(paths)
    memb = crates.remove_tracks([e["id"] for e in done]) if done else {}
    if done:   # the whole operation (files, hidden list, crate memberships) goes on one batch, so Undo from the history list reverses all of it
        if batch: libindex.annotate(batch, paths=paths, memb=memb)
        else: batch = libindex.record("forget", paths=paths, memb=memb)
    return {"removed": len(done), "trashed": trashed, "batch": batch, "paths": paths, "memb": memb,
            "untouched": [{"id": e["id"], "title": e.get("rbtitle") or os.path.basename(e["file"]), "why": "not on the drive right now" if not os.path.isfile(e["file"]) else "not in Waxfinder's scanned library, so it wasn't moved"} for e in untouched]}

def undo(batch, paths=None, memb=None, hist_load=None, hist_save=None):
    """Put back everything one batch changed: files, tags, hidden list, crate memberships, history paths and a crate swap.
    What the caller passes wins; anything missing is read from the batch itself (so the Clean-up history list undoes it all too)."""
    info = libindex.batch_info(batch) if batch else {}
    paths = paths if paths is not None else (info.get("paths") or []); memb = memb if memb is not None else (info.get("memb") or {})
    restored, blocked = 0, []
    if batch:
        r = libindex.undo(batch)
        if r.get("error"): return r
        restored, blocked = r.get("restored", 0), r.get("blocked") or []
    blocked_set = {setbuild.nfc(b if isinstance(b, str) else b.get("path", "")) for b in blocked}
    hiddenfiles.unhide([p for p in (paths or []) if setbuild.nfc(p) not in blocked_set])
    crates.restore_tracks(memb)
    if info.get("hist_moves") and hist_load and hist_save:
        remap_history([(t, f) for f, t in info["hist_moves"] if setbuild.nfc(f) not in blocked_set and setbuild.nfc(t) not in blocked_set], hist_load, hist_save)
    if info.get("reloc"):
        import relocate; relocate.undo(info["reloc"])   # reconnected files: forget the pairs (no file was moved)
    if info.get("swap") and not blocked: crates.swap_back(info["swap"])   # only once the old file is really back: crates must never point at a missing track
    return {"restored": restored, "blocked": blocked}

def remap_history(moves, load, save):
    """Files were renamed: point their history entries at the new path (history ids are not made from the path, so nothing else changes)."""
    if not moves: return 0
    m = {setbuild.nfc(a): b for a, b in moves}; h = load(); n = 0
    for e in h:
        k = setbuild.nfc(e.get("file") or "")
        if k in m: e["file"] = m[k]; n += 1
    if n: save(h)
    return n
