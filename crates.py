"""Crates (unordered bags of tracks) and saved setlists (exact order). Stored in crates.json next to app.py.
User data: never wipe. Writes are atomic (temp file + rename). Tracks are kept when the stick is out:
they come back marked missing, with the artist/title snapshot taken when they were added."""
import json, re, threading, time, uuid, urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from paths import safe_replace
import setbuild, soundindex, genres, artwork

FILE = Path(__file__).parent / "crates.json"
LOCK = threading.Lock()
# Crate plastic colours, handed out in order (first unused wins); past the end, new hues on the golden angle.
NAMED = {"purple": "#7b3fe4", "sky": "#8ec5f0", "sage": "#79b47e", "pink": "#ff5fa8", "amber": "#ffb23d", "lime": "#c6ff3d"}
PALETTE = ["#7b3fe4", "#8ec5f0", "#79b47e", "#ff5fa8", "#ffb23d", "#c6ff3d", "#ff7a2e", "#1fb5a8", "#e8364a", "#ffe066",
           "#2f5bea", "#9df2c8", "#ff8a7a", "#b9a3ff", "#2e7d4f", "#ffc2dc", "#24306e", "#d9f99d", "#8b5a3c", "#f2f2ee"]

def _hex(c): return NAMED.get(c, c) if isinstance(c, str) and (c in NAMED or re.fullmatch(r"#[0-9a-fA-F]{6}", c)) else NAMED["purple"]

def _next_colour(crates):
    used = {_hex(c.get("colour")) for c in crates}
    for c in PALETTE:
        if c not in used: return c
    import colorsys
    n = len(crates); r, g, b = colorsys.hls_to_rgb((n * 137.508 % 360) / 360, .6 if n % 2 else .5, .78)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))
SLOTS = ("warmup", "peak", "closing", "allnight")

def _load():
    try: d = json.loads(FILE.read_text())
    except FileNotFoundError: d = {}   # a damaged crates.json raises instead of reading as empty (the next save would wipe every crate)
    d.setdefault("crates", []); d.setdefault("sets", []); return d

def _save(d):
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, indent=1)); safe_replace(tmp, FILE)

def _name(s, fallback):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:60] or fallback

def _snap(hist, ids):
    by = {e["id"]: e for e in hist}; out = {}
    for i in ids:
        e = by.get(i)
        if not e: continue
        artist, _, title = Path(e["file"]).stem.partition(" - ")
        if e.get("rb"): artist, title = e.get("artist") or "", e.get("rbtitle") or ""
        out[i] = {"artist": artist.strip() if title else "", "title": (title or artist).strip(), "key": setbuild.song_key(e)}
    return out

def _index(hist):
    """id -> entry, and song key -> newest copy that exists. Built once per request, not once per crate."""
    by = {e["id"]: e for e in hist}; bykey = {}
    for e in sorted(hist, key=lambda e: -float(e.get("date") or 0)):
        if setbuild.exists(e.get("file")): bykey.setdefault(setbuild.song_key(e), e)
    return by, bykey

def _resolve(hist, ids, snap, idx=None):
    """id -> live history entry; falls back to the same song under another id (re-download / duplicate copy)."""
    by, bykey = idx or _index(hist)
    out = []
    for i in ids:
        e = by.get(i)
        if not (e and setbuild.exists(e.get("file"))):
            e = bykey.get((snap.get(i) or {}).get("key")) or e
        out.append((i, e))
    return out

def _tracks(hist, ids, snap, ana=None, idx=None, by_song=None):
    ana = ana if ana is not None else {t["id"]: t for t in setbuild.tracks(hist)}
    if by_song is None: by_song = {setbuild.song_key(t): t for t in ana.values()}   # a second copy of a song uses the analysed copy's numbers
    rows = []
    for i, e in _resolve(hist, ids, snap, idx):
        s = snap.get(i) or {}
        here = bool(e and setbuild.exists(e.get("file")))
        t = (ana.get(e["id"]) or by_song.get(setbuild.song_key(e))) if e else None   # saved BPM/key/energy stay visible while the file is away
        rows.append({"id": e["id"] if here else i, "artist": (t or {}).get("artist", s.get("artist", "")),
                     "title": (t or {}).get("title", s.get("title", "Unknown track")),
                     "bpm": t and t["bpm"], "key": t and t["cam"], "energy": t and (None if t.get("energy_unknown") else t["energy"]),
                     "missing": not here, "analysed": bool(t), "play": t and round(t["play"]), "dur": t and round(t["dur"]),
                     "styles": genres.styles(e) if here else [], "style_source": genres.source(e) if here else "",
                     "art": artwork.name_for(e) if e else ""})
    return rows

def listing(hist):
    d = _load(); ana = {t["id"]: t for t in setbuild.tracks(hist)}   # analyse once, not once per crate
    idx = _index(hist); by_song = {setbuild.song_key(t): t for t in ana.values()}
    return {"crates": [{"id": c["id"], "name": c["name"], "colour": _hex(c["colour"]), "created": c.get("created", 0), "updated": c.get("updated") or c.get("created", 0), "tracks": _tracks(hist, c["ids"], c.get("snap", {}), ana, idx, by_song)} for c in d["crates"]],
            "sets": [{"id": s["id"], "name": s["name"], "slot": s["slot"], "date": s["date"], "count": len(s["ids"])} for s in d["sets"]]}

def crate_new(hist, name, ids=()):
    with LOCK:
        d = _load(); ids = [i for i in dict.fromkeys(ids or ()) if i]
        c = {"id": uuid.uuid4().hex[:8], "name": _name(name, "New crate"), "colour": _next_colour(d["crates"]),
             "ids": ids, "snap": _snap(hist, ids), "created": time.time()}
        d["crates"].insert(0, c); _save(d); return {"id": c["id"], "name": c["name"], "colour": c["colour"]}   # newest crate first (Crates page, Library rail, Set picker all follow this order)

def crate_from_playlist(hist, key, name, ids):
    """The crate made from a Rekordbox playlist (key 'rb:<id>'). Importing again adds only the tracks it doesn't have yet."""
    with LOCK:
        d = _load(); ids = [i for i in dict.fromkeys(ids or ()) if i]
        c = next((x for x in d["crates"] if x.get("rb_playlist") == key), None)
        if c:
            new = [i for i in ids if i not in c["ids"]]
            c["ids"] += new; c.setdefault("snap", {}).update(_snap(hist, new))
            if new: c["updated"] = time.time()
        else:
            new = ids
            c = {"id": uuid.uuid4().hex[:8], "name": _name(name, "Rekordbox"), "colour": _next_colour(d["crates"]),
                 "ids": ids, "snap": _snap(hist, ids), "created": time.time(), "rb_playlist": key}
            d["crates"].append(c)
        _save(d); return {"id": c["id"], "name": c["name"], "colour": c["colour"], "added": len(new)}

def crate_edit(hist, cid, add=None, remove=None, name=None, colour=None, delete=False):
    with LOCK:
        d = _load(); c = next((x for x in d["crates"] if x["id"] == cid), None)
        if not c: return None
        if delete: d["crates"].remove(c)
        else:
            adds = [x for x in (add if isinstance(add, list) else [add] if add else []) if x and x not in c["ids"]]   # one id or a list (Library drag + drop)
            rems = [x for x in (remove if isinstance(remove, list) else [remove] if remove else []) if x in c["ids"]]
            if adds: c["ids"].extend(dict.fromkeys(adds)); c.setdefault("snap", {}).update(_snap(hist, adds)); c["updated"] = time.time()   # "recently updated" = tracks added or removed
            for x in rems: c["ids"].remove(x); c.get("snap", {}).pop(x, None)
            if rems: c["updated"] = time.time()
            if name: c["name"] = _name(name, c["name"])
            if colour: c["colour"] = _hex(colour)
        _save(d); return True

def remove_tracks(ids):
    """Take track ids out of every crate (library 'Remove / Delete'). Returns {crate_id: [ids that were in it]} so an undo can put them back."""
    ids = set(ids); memb = {}
    with LOCK:
        d = _load()
        for c in d["crates"]:
            hit = [i for i in c["ids"] if i in ids]
            if hit:
                c["ids"] = [i for i in c["ids"] if i not in ids]; c["updated"] = time.time(); memb[c["id"]] = hit
        if memb: _save(d)
    return memb

def restore_tracks(memb):
    with LOCK:
        d = _load(); by = {c["id"]: c for c in d["crates"]}
        for cid, ids in (memb or {}).items():
            c = by.get(cid)
            if c:
                c["ids"].extend(i for i in ids if i not in c["ids"]); c["updated"] = time.time()
        _save(d)

def crate_move(hist, src, dst, ids, copy=False):
    """Move (or copy) tracks between crates in one locked write. ids are row ids from /crates/data; they are mapped back to the
    ids actually stored in the source crate (a row can show a re-downloaded copy of a stored id). A track the target already
    holds (same song) is not added twice. Returns moved (added to the target) and already (target had it), for an exact Undo."""
    with LOCK:
        d = _load(); a = next((x for x in d["crates"] if x["id"] == src), None); b = next((x for x in d["crates"] if x["id"] == dst), None)
        if not a or not b or a is b: return None
        want = set(ids or ()); a_snap = a.setdefault("snap", {}); b_snap = b.setdefault("snap", {})
        have = set()
        for i, e in _resolve(hist, b["ids"], b_snap):
            have.add(i); have.add(e["id"] if e else i)
            k = (b_snap.get(i) or {}).get("key") or (setbuild.song_key(e) if e else None)
            if k: have.add(("k", k))
        moved, already = [], []   # already: the target had the song; Undo must COPY those back, not take them out of the target
        for i, e in _resolve(hist, a["ids"], a_snap):
            if i not in want and not (e and e["id"] in want): continue
            k = (a_snap.get(i) or {}).get("key") or (setbuild.song_key(e) if e else None)
            if not (i in have or (e and e["id"] in have) or (k and ("k", k) in have)):
                b["ids"].append(i)
                if i in a_snap: b_snap[i] = a_snap[i]
                else: b_snap.update(_snap(hist, [i]))
                have.add(i)
                if k: have.add(("k", k))
                moved.append(i)
            else: already.append(i)
            if not copy:
                a["ids"].remove(i); a_snap.pop(i, None)
        if moved or (already and not copy):
            now = time.time(); b["updated"] = now
            if not copy: a["updated"] = now
            _save(d)
        return {"moved": moved, "already": already}

def swap_file(hist, old_path, new_id, rec=None):
    """A better copy of a track was downloaded: every crate and saved set that held the old file gets the new track in the
    same place (nothing else moves). Returns how many crates/sets changed."""
    import unicodedata
    nf = lambda x: unicodedata.normalize("NFC", str(x or ""))
    old = nf(old_path); new_snap = _snap(hist, [new_id]); n = 0
    with LOCK:
        d = _load(); now = time.time()
        for c in d["crates"]:
            snap = c.setdefault("snap", {})
            hits = [i for i, e in _resolve(hist, c["ids"], snap) if e and nf(e.get("file")) == old]
            if not hits: continue
            for i in hits:
                if rec is not None: rec.setdefault("crates", {}).setdefault(c["id"], []).append({"id": i, "snap": snap.get(i)})
                if new_id in c["ids"]: c["ids"].remove(i)
                else: c["ids"][c["ids"].index(i)] = new_id
                snap.pop(i, None)
            snap.update(new_snap); c["updated"] = now; n += 1
        by = {e["id"]: e for e in hist}
        for s in d["sets"]:
            ids = s.get("ids") or []
            if any(nf((by.get(i) or {}).get("file")) == old for i in ids):
                if rec is not None: rec.setdefault("sets", {})[s["id"]] = [i for i in ids if nf((by.get(i) or {}).get("file")) == old]
                s["ids"] = [new_id if nf((by.get(i) or {}).get("file")) == old else i for i in ids]; n += 1
        if n: _save(d)
    return n

def swap_back(rec):
    """Reverse swap_file from its record: the new track goes back to the old one in the crates/sets it replaced it in. Later edits are kept."""
    new_id = rec.get("new")
    with LOCK:
        d = _load(); now = time.time(); by = {c["id"]: c for c in d["crates"]}
        for cid, olds in (rec.get("crates") or {}).items():
            c = by.get(cid)
            if not c: continue
            ids = c["ids"]; snap = c.setdefault("snap", {})
            for o in olds:
                if o["id"] in ids: continue
                if new_id in ids: ids[ids.index(new_id)] = o["id"]
                else: ids.append(o["id"])
                if o.get("snap"): snap[o["id"]] = o["snap"]
            if new_id not in ids: snap.pop(new_id, None)
            c["updated"] = now
        sets = {s["id"]: s for s in d["sets"]}
        for sid, olds in (rec.get("sets") or {}).items():
            s = sets.get(sid); olds = list(olds)
            if s and new_id in (s.get("ids") or []):
                s["ids"] = [olds.pop(0) if (i == new_id and olds) else i for i in s["ids"]]
        _save(d)

def crate_order(ids):
    """Reorder crates to match ids (the drag order on /crates). Unknown ids are ignored; crates not listed keep their place at the end."""
    with LOCK:   # the whole read-modify-write, so a concurrent membership edit isn't overwritten
        d = _load(); pos = {c: i for i, c in enumerate(ids or [])}
        d["crates"].sort(key=lambda c: pos.get(c["id"], len(pos)))   # stable: unlisted crates keep their relative order
        _save(d); return [c["id"] for c in d["crates"]]

def crate_reorder(hist, cid, ids):
    """Put a crate's tracks in the order of ids (drag to reorder). The listed tracks swap among the slots they already hold, so a
    partial list (only the rows on screen) leaves every other track exactly where it was. Returns the crate's ids, or None if unknown."""
    with LOCK:
        d = _load(); c = next((x for x in d["crates"] if x["id"] == cid), None)
        if not c: return None
        disp = {i: i for i in c["ids"]}   # the page shows a track under its live copy's id when that differs from the stored one
        for i, e in _resolve(hist, c["ids"], c.get("snap") or {}):
            if e and setbuild.exists(e.get("file")): disp[e["id"]] = i
        want = [i for i in dict.fromkeys(disp.get(x) for x in (ids or [])) if i]
        slots = [k for k, i in enumerate(c["ids"]) if i in set(want)]
        for k, i in zip(slots, want): c["ids"][k] = i
        _save(d); return list(c["ids"])

def crate_ids(cid):
    c = next((x for x in _load()["crates"] if x["id"] == cid), None)
    return c and c["ids"]

def set_save(hist, name, slot, ids, params=None, replace=None):
    """New saved set, or overwrite `replace` (the set you reopened and edited, kept under the same name)."""
    with LOCK:
        d = _load(); ids = [i for i in dict.fromkeys(ids or ()) if i]
        s = {"id": uuid.uuid4().hex[:8], "name": _name(name, "My set"), "slot": slot if slot in SLOTS else "peak",
             "date": time.time(), "ids": ids, "snap": _snap(hist, ids), "params": params or {}}
        old = next((x for x in d["sets"] if replace and x["id"] == replace), None)
        if old: s["id"] = old["id"]; d["sets"][d["sets"].index(old)] = s
        else: d["sets"].insert(0, s)
        _save(d); return {k: s[k] for k in ("id", "name", "slot")}

def set_rename(sid, name):
    with LOCK:
        d = _load(); x = next((s for s in d["sets"] if s["id"] == sid), None)
        if not x: return None
        x["name"] = _name(name, x["name"]); _save(d); return {"id": x["id"], "name": x["name"], "slot": x["slot"]}

def set_delete(sid):
    with LOCK:
        d = _load(); n = len(d["sets"]); d["sets"] = [s for s in d["sets"] if s["id"] != sid]
        if len(d["sets"]) != n: _save(d)
        return len(d["sets"]) != n

def set_open(hist, sid):
    """A saved set in its saved order. Tracks that can't play right now (stick out / not analysed) come back in `missing`."""
    s = next((x for x in _load()["sets"] if x["id"] == sid), None)
    if not s: return None
    ana = {t["id"]: t for t in setbuild.tracks(hist)}; order, missing, slots = [], [], []
    for i, e in _resolve(hist, s["ids"], s.get("snap", {})):
        t = e and ana.get(e["id"])
        if t and setbuild.exists(e["file"]): order.append(t); slots.append({"orig": i, "live": t["id"]})
        else: missing.append({**(s.get("snap", {}).get(i) or {"title": "Unknown track"}), "id": i}); slots.append({"orig": i, "live": None})
    res = setbuild.describe(order)
    res.update({"saved": {"id": s["id"], "name": s["name"], "slot": s["slot"]}, "missing": missing, "slots": slots})   # slots = saved order incl. unplayable
    return res

import soundstyles


def library_all(hist):
    """The Library table on /crates: EVERY track (downloads, Rekordbox-linked, scanned USB files), one call.
    Analysis (BPM/key/energy) falls back to the analysed copy of the same song; styles are listing tags only."""
    ana = {t["id"]: t for t in setbuild.tracks(hist)}
    by_song = {setbuild.song_key(t): t for t in ana.values()}
    try:
        import libindex
        idx = libindex.index()
    except Exception: idx = {}
    try:
        import cdjexport; was_exported = cdjexport.exported_checker()
    except Exception: was_exported = lambda p: False
    out, seen = [], set()
    for e in hist:
        f = e.get("file")
        if not f or e["id"] in seen: continue
        seen.add(e["id"])
        here = setbuild.exists(f)
        t = ana.get(e["id"]) or by_song.get(setbuild.song_key(e))
        src = "usb" if e.get("lf") else "rekordbox" if e.get("rb") else "download"
        a = (t or {}).get("artist") or e.get("artist") or ""
        ti = (t or {}).get("title") or e.get("rbtitle") or ""
        if not ti:
            st = Path(f).stem; fa, _, ft = st.partition(" - ")
            a, ti = (a or (fa.strip() if ft else "")), (ft or fa).strip()
        r = idx.get(setbuild.nfc(f)) or idx.get(f) or {}
        out.append({"id": e["id"], "title": ti, "artist": a, "bpm": t and t["bpm"], "bpm_confidence": t and t.get('bpm_confidence'), "key": t and t["cam"],
                    "key_sure": bool(t and (t["ksrc"] == "rekordbox" or t["kconf"] >= .9)), "energy": t and (None if t.get("energy_unknown") else t["energy"]),
                    "styles": genres.styles(e), "style_source": genres.source(e), "est_styles": [] if genres.styles(e) else soundstyles.estimate(e["id"]), "sound": bool(here and soundindex.cached(e)),
                    "dur": e.get("duration") or (t and t.get("dur")) or r.get("dur"), "added": float(e.get("date") or 0), "here": here,
                    "src": src, "ext": (e.get("ext") or Path(f).suffix.lstrip(".")).lower(), "kbps": r.get("br"),
                    "channel": e.get("channel") or "", "url": e.get("url") or "", "analysed": bool(t), "bpm_flag": t and t.get("bpm_flag"), "bpm_manual": bool(t and t.get("bpm_manual")), "art": artwork.name_for(e), "exp": bool(here and was_exported(f))})
    import trackedit
    return trackedit.apply(out)


def library_rows(hist):
    """Every song in the library (one per song, on the stick or not analysed yet) for the add-tracks list."""
    ana = {t["id"]: t for t in setbuild.tracks(hist)}; out = []
    for e in setbuild.library(hist):
        t = ana.get(e["id"])
        artist, _, title = Path(e["file"]).stem.partition(" - ")
        out.append({"id": e["id"], "artist": t["artist"] if t else (artist.strip() if title else ""), "title": t["title"] if t else (title or artist).strip(),
                    "bpm": t and t["bpm"], "bpm_confidence": t and t.get('bpm_confidence'), "key": t and t["cam"], "key_sure": bool(t and (t["ksrc"] == "rekordbox" or t["kconf"] >= .9)), "energy": t and (None if t.get("energy_unknown") else t["energy"]), "styles": genres.styles(e), "style_source": genres.source(e), "sound": bool(soundindex.cached(e)), "added": float(e.get("date") or 0)})
    return out


# ---------- export a crate / set to the stick as a Rekordbox playlist ----------
# Writes <out>/Playlists/<name>.xml (Rekordbox XML: tracks with BPM, key and grid, plus one playlist) and <name>.m3u8.
# Rekordbox: File > Import Collection (the XML) then the playlist shows under "rekordbox xml"; drag it into Playlists
# and it exports to the CDJ stick like any other. Files stay where they are; nothing is copied or moved.
_CAM_TO_KEY = {**{v: NOTE + "m" for k, v in setbuild.CAM_MIN.items() for NOTE in [setbuild.NOTES[k]]},
               **{v: setbuild.NOTES[k] for k, v in setbuild.CAM_MAJ.items()}}
_KIND = {"mp3": "MP3 File", "wav": "WAV File", "flac": "FLAC File", "aiff": "AIFF File", "aif": "AIFF File", "m4a": "M4A File"}

def _safe_name(name, fallback):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", name or "")).strip()[:80] or fallback

def export_ids(hist, ids, snap, name, out_dir):
    """Ordered ids (crate or set) -> Rekordbox XML + M3U8 in <out_dir>/Playlists. Tracks that aren't playable now are skipped and counted."""
    name = _safe_name(name, "Waxfinder playlist")
    ana = {t["id"]: t for t in setbuild.tracks(hist)}; by_song = {setbuild.song_key(t): t for t in ana.values()}
    rows, seen, skipped = [], set(), 0
    for i, e in _resolve(hist, ids, snap or {}):
        if not (e and e.get("file")): skipped += 1; continue   # no known path at all
        if e["id"] in seen: continue
        seen.add(e["id"]); t = ana.get(e["id"]) or by_song.get(setbuild.song_key(e))   # file may be offline (stick out): path + snapshot are still exported
        s = _snap(hist, [e["id"]]).get(e["id"], {})
        rows.append((e, t, s))
    if not rows: raise ValueError("This crate has no tracks to export")
    d = Path(out_dir) / "Playlists"; d.mkdir(parents=True, exist_ok=True)
    root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
    ET.SubElement(root, "PRODUCT", Name="rekordbox", Version="6.0.0", Company="Pioneer DJ")
    col = ET.SubElement(root, "COLLECTION", Entries=str(len(rows)))
    lines = ["#EXTM3U"]; off = 0
    for n, (e, t, s) in enumerate(rows, 1):
        f = setbuild.posix(e["file"]); ext = f.rsplit(".", 1)[-1].lower()
        artist = (t or {}).get("artist", s.get("artist", "")); title = (t or {}).get("title") or s.get("title") or Path(f).stem
        dur = int(round((t or {}).get("dur") or e.get("duration") or 0))
        a = {"TrackID": str(n), "Name": title, "Artist": artist, "Kind": _KIND.get(ext, ext.upper() + " File"), "TotalTime": str(dur),
             "Location": "file://localhost" + urllib.parse.quote(f)}
        if t:
            a["AverageBpm"] = f"{t['bpm']:.2f}"
            if _CAM_TO_KEY.get(t.get("cam")): a["Tonality"] = _CAM_TO_KEY[t["cam"]]
        tr = ET.SubElement(col, "TRACK", a)
        g = (t or {}).get("grid")
        if g and g.get("first_beat") is not None and g.get("grid_bpm"):   # only Rekordbox's own grid ever reaches here; ours is not written
            ET.SubElement(tr, "TEMPO", Inizio=f"{g['first_beat']:.3f}", Bpm=f"{g['grid_bpm']:.2f}", Metro="4/4", Battito="1")
        lines += [f"#EXTINF:{dur},{artist + ' - ' if artist else ''}{title}", f]
        if not setbuild.exists(e["file"]): off += 1
    pls = ET.SubElement(root, "PLAYLISTS"); top = ET.SubElement(pls, "NODE", Type="0", Name="ROOT", Count="1")
    node = ET.SubElement(top, "NODE", Name=name, Type="1", KeyType="0", Entries=str(len(rows)))
    for n in range(1, len(rows) + 1): ET.SubElement(node, "TRACK", Key=str(n))
    ET.indent(root)
    xf, mf = d / f"{name}.xml", d / f"{name}.m3u8"
    xf.write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8"))
    mf.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"xml": setbuild.posix(xf), "m3u8": setbuild.posix(mf), "count": len(rows), "skipped": skipped, "offline": off,
            "usb": setbuild.posix(xf).startswith("/Volumes/")}

def export_crate(hist, cid, out_dir):
    c = next((x for x in _load()["crates"] if x["id"] == cid), None)
    if not c: raise ValueError("That crate no longer exists")
    return export_ids(hist, c["ids"], c.get("snap", {}), c["name"], out_dir)
