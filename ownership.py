"""Version-aware owned-song filter. Reads metadata only; no audio analysis/network/writes."""
import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import taste
from names import CODE_RE, display_name

_NOISE = re.compile(r"^(?:full length|vinyl(?: rip)?|\d{3,4}p|320\s*(?:kbps)?|mp3|wav|flac|\d{4}|.*ezmp3\.cc.*)$", re.I)


def _clean(s):
    s = "".join(c for c in unicodedata.normalize("NFKD", str(s or "")) if not unicodedata.combining(c))
    s = re.sub(r"^[0-9a-f]{8}-", "", s)
    s = re.sub(r"^\d{1,3}\s*[-.]\s+", "", s)
    def bracket(m):
        value = m[1].strip()
        return " " if _NOISE.fullmatch(value) or CODE_RE.fullmatch(value) else "(" + value + ")"
    return re.sub(r"[\[(]([^\])]+)[\])]", bracket, s)


def song_key(item):
    artist = _clean(item.get("artist"))
    title = _clean(item.get("rbtitle") or item.get("track") or item.get("title"))
    if not title and item.get("file"):
        title = _clean(Path(item["file"]).stem)
    title = re.sub(r"\s+\|\s+.*$", "", title)
    title = re.split(r"\s+[•·]\s+", title)[0]
    title = re.sub(r"\s+[-–—]\s+official (?:audio|video)\s*$", "", title, flags=re.I)
    if artist:
        while True:
            _, parsed, track = display_name(title)
            if not parsed or _artist_key(parsed) != _artist_key(artist):
                break
            title = track   # stored names sometimes repeat Artist - inside the title tag
        _, _, title = display_name(artist + " - " + title)
    else:
        channel = item.get("channel") or ""
        topic = channel if channel.endswith(" - Topic") else ""
        _, artist, title = display_name(title, topic)
    return taste.own_key(artist, title) if artist else None


def _artist_key(artist):
    # Use the same main-artist splitting as the established owned-version key.
    return (taste.own_key(artist, "placeholder") or "").partition("|")[0]


def identities(item):
    keys = {"id:" + str(item["id"])} if item.get("id") else set()
    for field in ("seed_vid", "yt"):
        if item.get(field): keys.add("id:" + str(item[field]))
    for field in ("url", "page"):
        raw = item.get(field)
        if not raw or not raw.startswith(("https://", "http://")):
            continue
        u = urlsplit(raw); host = (u.hostname or "").lower()
        if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"):
            video = u.path.strip("/") if host == "youtu.be" else (parse_qs(u.query).get("v") or [""])[0]
            if re.fullmatch(r"[\w-]{11}", video): keys.add("id:" + video)
        elif host.removeprefix("www.") != "discogs.com":
            # Discogs release URLs identify multiple songs, not an individual track.
            keys.add("url:" + host.removeprefix("www.") + u.path.rstrip("/"))
    return keys


class Index:
    def __init__(self, entries=(), crate_data=None):
        self.songs = set()
        self.ids = set()
        self.references = set()
        for e in entries:
            self.add(e)
            # Filename may contain the full title when imported tags were cut short.
            if e.get("file"):
                self.add({"title": Path(e["file"]).stem})
        for group in ("crates", "sets"):
            for crate in (crate_data or {}).get(group, []):
                self.ids.update(str(i) for i in crate.get("ids", []))
                for snapshot in crate.get("snap", {}).values():
                    self.add(snapshot)

    def add(self, item):
        if item.get("id"): self.ids.add(str(item["id"]))
        self.references.update(identities(item))
        key = song_key(item)
        if key: self.songs.add(key)

    def contains(self, item):
        if item.get("id") and str(item["id"]) in self.ids:
            return True
        return bool(identities(item) & self.references) or (key := song_key(item)) is not None and key in self.songs
