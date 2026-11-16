"""M3U / M3U8 playlist file -> the ordered list of Library tracks it names.
Pure functions (no app imports): parse() reads the text, match() finds each entry in the Library by full path, then file name, then 'Artist - Title'."""
import os, re, unicodedata, urllib.parse
from pathlib import Path


def _nfc(s): return unicodedata.normalize("NFC", s)


def _key(s): return re.sub(r"[^a-z0-9]+", "", _nfc(s).lower())


def _clean_path(p):
    p = p.strip()
    if p.lower().startswith("file://"):
        p = urllib.parse.unquote(p[7:])
        if p.lower().startswith("localhost/"): p = p[9:]
    p = p.replace("\\", "/")
    return _nfc(p)


def parse(text):
    """[{path, label, artist, title}] in file order. Handles #EXTM3U/#EXTINF, file:// URLs, percent-encoding and Windows slashes."""
    out, info = [], None
    for raw in (text or "").lstrip("\ufeff").splitlines():
        ln = raw.strip()
        if not ln: continue
        if ln.startswith("#"):
            if ln.upper().startswith("#EXTINF:"):
                _, _, t = ln.partition(",")
                a, sep, ti = t.partition(" - ")
                info = {"artist": a.strip() if sep else "", "title": (ti if sep else t).strip()}
            continue
        p = _clean_path(ln)
        stem = Path(p).stem
        if info: artist, title = info["artist"], info["title"]
        else:
            a, sep, ti = stem.partition(" - "); artist, title = (a.strip() if sep else ""), (ti if sep else stem).strip()
        out.append({"path": p, "label": " - ".join(x for x in (artist, title) if x) or stem, "artist": artist, "title": title})
        info = None
    return out


def match(entries, hist, exists=os.path.exists):
    """-> (ids in playlist order, unmatched labels). hist = Library entries ({id, file, ...}). Existing files win over offline ones; each Library track is used once."""
    by_path, by_name, by_song = {}, {}, {}
    for e in sorted(hist, key=lambda e: -float(e.get("date") or 0)):
        f = e.get("file")
        if not f: continue
        live = bool(exists(f))
        for d, k in ((by_path, _nfc(str(f).replace("\\", "/")).lower()), (by_name, _nfc(Path(f).name).lower()),
                     (by_song, _key(Path(f).stem))):
            d.setdefault(k, []).append((not live, e))   # sort key: reachable files first (stable, newest first)
        if e.get("rb"): by_song.setdefault(_key((e.get("artist") or "") + (e.get("rbtitle") or "")), []).append((not live, e))
    best = lambda c: sorted(c, key=lambda x: x[0])[0][1] if c else None
    ids, miss, used = [], [], set()
    for x in entries:
        e = best(by_path.get(x["path"].lower()))
        if not e: e = best(by_name.get(_nfc(Path(x["path"]).name).lower()))   # same file name (moved or on another drive)
        if not e and (x["artist"] or x["title"]): e = best(by_song.get(_key(x["artist"] + x["title"])))   # same song by name
        if not e: miss.append(x["label"]); continue
        if e["id"] in used: continue
        used.add(e["id"]); ids.append(e["id"])
    return ids, miss
