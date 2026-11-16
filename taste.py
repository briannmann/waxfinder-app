"""Your DJ taste from Rekordbox: artists you play, BPM range, tracks you already own.

Two ways in, same summary out (taste.json):
  * scan_local()  - this Mac's Rekordbox library, read from a COPY of master.db (never the original).
                    Needs the optional `pyrekordbox` package; silently does nothing without it.
  * from_xml(fp)  - a Rekordbox XML export (File > Export Collection in xml format). Works on any machine.
Only a derived summary is kept: no file paths, no raw library.
"""
import json, re, shutil, time, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from names import parse_title, split_artists, akey, credits

TASTE_FILE = Path(__file__).parent / "taste.json"
RB_DB = Path.home() / "Library/Pioneer/rekordbox/master.db"           # macOS
RB_DB_WIN = Path.home() / "AppData/Roaming/Pioneer/rekordbox/master.db"  # Windows
SKIP_ARTISTS = re.compile(r"unknown|^rekordbox$|loopmasters|^various|^va$|sample|^demo track", re.I)
_GENERIC_VER = re.compile(r"\b(original|extended|radio|club|album|single|main|vocal|instrumental|mix|edit|version|remix|dub|rework|refix|remaster(?:ed)?|\d{4})\b", re.I)

def clean_title(t):
    t = re.sub(r"(?:www\.|my-free-mp3)\S*", " ", t or "", flags=re.I)
    t = re.sub(r"^[^\w(\[]+", "", t)            # leading emoji / symbols
    t = re.sub(r"\s+", " ", t).strip(" -_")
    if " - " not in t:                          # "Artist-Title" with no spaces round the dash
        m = re.match(r"^([^-]{2,40}?)-(\S.*)$", t)
        if m and len(m.group(1).split()) <= 4: t = m.group(1).strip() + " - " + m.group(2).strip()
    return t

def own_key(artist, title):
    """artist|track|version. Original / Extended / bare all count as the same version; a named remix does not."""
    if not artist: artist, title = parse_title(clean_title(title))
    if not artist: return None
    main = akey((split_artists(artist) or [artist])[0])
    vers = re.findall(r"[\(\[]([^\)\]]*)[\)\]]", title or "")
    base = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", title or "")
    base = akey(re.split(r"\s+(?:feat\.?|ft\.?)\s+", base, flags=re.I)[0])
    ver = "".join(akey(_GENERIC_VER.sub(" ", v)) for v in vers if not re.match(r"\s*(?:feat|ft)\b", v, re.I))
    return f"{main}|{base}|{ver}" if main and base else None

def summarise(tracks, source):
    """tracks: dicts with artist, title, bpm, rating (0-5), plays (playlist count / play count), label, genre."""
    artists, labels, genres, bpms, owned = {}, {}, {}, [], set()
    for t in tracks:
        title = clean_title(t.get("title"))
        a = t.get("artist") or parse_title(title)[0]
        if a and SKIP_ARTISTS.search(a): continue
        k = own_key(a, title if t.get("artist") else title.split(" - ", 1)[-1] if " - " in title else title)
        if k: owned.add(k)
        w = 1 + min(t.get("plays") or 0, 4) + (t.get("rating") or 0)
        names = (split_artists(a) if a else []) + [n for n in credits((a + " - " if a else "") + title)]
        for n in dict.fromkeys(names):
            if len(n) < 2 or SKIP_ARTISTS.search(n): continue
            e = artists.setdefault(akey(n), [n, 0]); e[1] += w
        if t.get("label") and not SKIP_ARTISTS.search(t["label"]): e = labels.setdefault(akey(t["label"]), [t["label"], 0]); e[1] += w
        if t.get("genre"): genres[t["genre"]] = genres.get(t["genre"], 0) + 1
        if t.get("bpm") and 60 <= t["bpm"] <= 200: bpms.extend([t["bpm"]] * (1 + min(t.get("plays") or 0, 2)))
    bpms.sort()
    pct = (lambda p: round(bpms[min(len(bpms) - 1, int(len(bpms) * p))], 1)) if bpms else None
    out = {"source": source, "ts": time.time(), "tracks": len(tracks),
           "artists": sorted(artists.values(), key=lambda x: -x[1])[:400],
           "labels": sorted(labels.values(), key=lambda x: -x[1])[:100],
           "genres": sorted(genres, key=lambda g: -genres[g])[:10],
           "bpm": {f"p{int(p*100)}": pct(p) for p in (.1, .25, .5, .75, .9)} if bpms else None,
           "owned": sorted(owned)}
    TASTE_FILE.write_text(json.dumps(out))
    return out

def load():
    try: return json.loads(TASTE_FILE.read_text())
    except Exception: return None

def clear():
    """Forget the summary and stop auto-scanning until you scan or upload again."""
    TASTE_FILE.write_text(json.dumps({"source": "off", "ts": time.time()}))

def status():
    t = load() or {}
    on = t.get("source") not in (None, "off")
    return {"on": on, "source": t.get("source"), "tracks": t.get("tracks", 0) if on else 0, "artists": len(t.get("artists", [])) if on else 0,
            "bpm": t.get("bpm") if on else None, "ts": t.get("ts"), "local": bool(local_db())}

def local_db():
    for p in (RB_DB, RB_DB_WIN):
        if p.exists(): return p
    return None

def scan_local(force=False):
    """Re-read this machine's Rekordbox library when it changed since the last scan. Never touches the original."""
    db = local_db()
    if not db: return None
    cur = load()
    if cur and not force and cur.get("source") in ("off", "rekordbox-xml"): return cur   # you turned it off / chose an XML
    if cur and not force and cur.get("source") == "rekordbox" and cur["ts"] > db.stat().st_mtime: return cur
    try: from pyrekordbox.masterdb import MasterDatabase
    except Exception: return cur
    with tempfile.TemporaryDirectory() as d:
        copy = Path(d) / "master.db"; shutil.copy2(db, copy)
        import logging; logging.getLogger("pyrekordbox").setLevel(logging.ERROR)
        m = MasterDatabase(path=str(copy))
        plays = {}
        for s in m.get_playlist_songs().all(): plays[s.ContentID] = plays.get(s.ContentID, 0) + 1
        tracks = [{"artist": c.ArtistName, "title": c.Title, "bpm": (c.BPM or 0) / 100 or None, "rating": c.Rating or 0,
                   "plays": plays.get(c.ID, 0) + (c.DJPlayCount or 0), "label": c.LabelName, "genre": c.GenreName}
                  for c in m.get_content().all() if c.Title]
        m.close()
    return summarise(tracks, "rekordbox")

def from_xml(fp):
    """Stream-parse a Rekordbox XML export; elements are cleared as we go so big collections stay cheap."""
    tracks, plays, in_pl = {}, {}, False
    for ev, el in ET.iterparse(fp, events=("start", "end")):
        if ev == "start":
            if el.tag == "PLAYLISTS": in_pl = True
            continue
        if el.tag == "TRACK":
            a = el.attrib
            if in_pl and "Key" in a: plays[a["Key"]] = plays.get(a["Key"], 0) + 1
            elif "TrackID" in a and "Name" in a:
                try: bpm = float(a.get("AverageBpm") or 0) or None
                except ValueError: bpm = None
                try: rating = round(int(a.get("Rating") or 0) / 51)
                except ValueError: rating = 0
                try: pc = int(a.get("PlayCount") or 0)
                except ValueError: pc = 0
                tracks[a["TrackID"]] = {"artist": a.get("Artist"), "title": a.get("Name"), "bpm": bpm, "rating": rating,
                                        "plays": pc, "label": a.get("Label"), "genre": a.get("Genre")}
            el.clear()
        elif el.tag in ("NODE", "COLLECTION"): el.clear()
    for k, n in plays.items():
        if k in tracks: tracks[k]["plays"] += n
    if not tracks: raise ValueError("no tracks found - is this a Rekordbox XML export?")
    return summarise(list(tracks.values()), "rekordbox-xml")
