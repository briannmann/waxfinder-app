"""Connected sources: paste a public YouTube / SoundCloud / Discogs link, no login and no keys (like digdeeper.fm).
What comes in (the tracks and records someone already likes) seeds Picks, so a new install has picks before any download.
Bandcamp is left out: from Windows its pages answer with a bot check instead of the page."""
import json, re, threading, time
from pathlib import Path
from paths import atomic_write, note
from names import akey, credits

FILE = Path(__file__).parent / "connections.json"
SERVICES = {"youtube": "YouTube", "soundcloud": "SoundCloud", "discogs": "Discogs"}
MAX_ITEMS = 600
_LOCK = threading.Lock()
WORKING = set()
ON_SYNC = None   # set by app.py: rebuild Picks after a source is connected
try: DB = json.loads(FILE.read_text(encoding="utf-8"))
except Exception: DB = {}


def _save():
    with _LOCK: atomic_write(FILE, json.dumps(DB))


def status():
    out = {}
    for s, label in SERVICES.items():
        d = DB.get(s) or {}
        out[s] = {"label": label, "link": d.get("link", ""), "name": d.get("name", ""), "count": len(d.get("items") or []),
                  "ts": d.get("ts", 0), "error": d.get("error", ""), "working": s in WORKING}
    return {"services": out, "connected": connected()}


def connected(): return any((DB.get(s) or {}).get("items") for s in SERVICES)


def items():
    return [dict(i, svc=s) for s in SERVICES for i in (DB.get(s) or {}).get("items") or []]


# ---------------- reading a link ----------------
def _clean_link(service, raw):
    raw = (raw or "").strip()
    if not raw: raise ValueError("Paste a link first")
    if service == "discogs":
        m = re.search(r"discogs\.com/(?:[a-z]{2}/)?user/([^/?#]+)", raw, re.I)
        user = m.group(1) if m else raw.strip("/@ ")
        if not re.fullmatch(r"[\w.\-]{1,64}", user): raise ValueError("That doesn't look like a Discogs username")
        return user
    if service == "youtube":
        if raw.startswith("@"): raw = "https://www.youtube.com/" + raw
        if not re.match(r"https?://(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/", raw, re.I):
            raise ValueError("Paste a YouTube channel or playlist link")
        return raw.split("#")[0]
    if service == "soundcloud":
        if not raw.startswith("http"): raw = "https://soundcloud.com/" + raw.strip("/@ ")
        if not re.match(r"https?://(www\.|m\.)?soundcloud\.com/[^/?#]+", raw, re.I): raise ValueError("Paste a SoundCloud profile link")
        return raw.split("?")[0].rstrip("/")
    raise ValueError("Unknown source")


def _yt_artist(title, channel):
    c = credits(title or "")
    if c and " - " in (title or ""): return c[0]
    return re.sub(r"\s*-\s*Topic$", "", channel or "").strip()


def _youtube(link):
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, "playlistend": 300}
    with yt_dlp.YoutubeDL(opts) as y:
        if "list=" in link: lists, name = [link], ""
        else:   # a channel: its public playlists
            base = re.sub(r"/(featured|videos|playlists|shorts|streams|about)/?$", "", link.split("?")[0].rstrip("/"))
            info = y.extract_info(base + "/playlists", download=False)
            name = re.sub(r"\s*-\s*Playlists$", "", info.get("title") or "")
            lists = [e["url"] for e in info.get("entries") or [] if e.get("url") and "list=" in e["url"]][:25]
            if not lists: raise ValueError("No public playlists on that channel. Make one public, or paste a playlist link")
        out, seen = [], set()
        for u in lists:
            try: p = y.extract_info(u, download=False)
            except Exception as ex: note("connections: youtube playlist", ex); continue
            name = name or p.get("uploader") or p.get("title") or ""
            for e in p.get("entries") or []:
                vid, title = e.get("id"), e.get("title") or ""
                if not vid or vid in seen or title in ("[Private video]", "[Deleted video]"): continue
                seen.add(vid)
                out.append({"artist": _yt_artist(title, e.get("channel") or e.get("uploader")), "title": title, "yt": vid})
            if len(out) >= MAX_ITEMS: break
    return name, out


def _soundcloud(link):
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as y:
        ie = y.get_info_extractor("Soundcloud"); ie.initialize()   # yt-dlp's own SoundCloud client: no key of ours needed
        api = lambda path, q=None: ie._call_api(ie._API_V2_BASE + path, path, query=q or {}, headers=ie._HEADERS)
        try: u = api("resolve", {"url": link})
        except Exception: raise ValueError("SoundCloud couldn't find that profile")
        out, seen = [], set()
        def add(t):
            if not t or not t.get("title") or t.get("id") in seen: return
            seen.add(t.get("id"))
            artist = (t.get("publisher_metadata") or {}).get("artist") or (credits(t["title"]) or [""])[0] or (t.get("user") or {}).get("username") or ""
            out.append({"artist": artist, "title": t["title"], "url": t.get("permalink_url") or ""})
        if u.get("kind") == "playlist":
            for t in u.get("tracks") or []: add(t)
            return u.get("title") or "", out
        if u.get("kind") != "user": raise ValueError("Paste a SoundCloud profile or playlist link")
        lk = api(f"users/{u['id']}/track_likes", {"limit": 200})
        for c in lk.get("collection") or []: add(c.get("track"))
        pl = api(f"users/{u['id']}/playlists", {"limit": 25})
        for p in pl.get("collection") or []:
            for t in p.get("tracks") or []: add(t)   # long playlists only carry full details for their first tracks: those are enough
        if not out: raise ValueError("That profile has no public likes or playlists yet")
        return u.get("username") or "", out[:MAX_ITEMS]


def _discogs(user):
    import discogs_api
    out, errors = [], 0
    for path, key in ((f"/users/{user}/collection/folders/0/releases?per_page=100&sort=added&sort_order=desc", "releases"),
                      (f"/users/{user}/wants?per_page=100", "wants")):
        try: rows = discogs_api.get(path).get(key) or []
        except Exception as ex: errors += 1; note("connections: discogs", ex); continue
        for r in rows:
            b = r.get("basic_information") or {}
            artist = re.sub(r"\s*\(\d+\)$", "", ((b.get("artists") or [{}])[0].get("name") or ""))   # "Name (2)" is Discogs' duplicate marker
            if b.get("title") and artist and artist != "Various": out.append({"artist": artist, "title": b["title"]})
    if errors == 2: raise ValueError("Couldn't read that Discogs user. Check the name, and that the collection is public")
    if not out: raise ValueError("That Discogs collection and wantlist are empty or private")
    return user, out[:MAX_ITEMS]


READERS = {"youtube": _youtube, "soundcloud": _soundcloud, "discogs": _discogs}


def connect(service, raw):
    """Check the link now (bad input answers at once), then read it in the background."""
    if service not in SERVICES: raise ValueError("Unknown source")
    link = _clean_link(service, raw)
    with _LOCK:
        if service in WORKING: return status()
        WORKING.add(service)
    def run():
        try:
            name, got = READERS[service](link)
            old = {(i.get("yt"), i.get("title")): i for i in (DB.get(service) or {}).get("items") or []}
            for i in got:   # keep YouTube lookups already made for these
                o = old.get((i.get("yt"), i.get("title")))
                if o and o.get("seed_vid"): i["seed_vid"] = o["seed_vid"]
            DB[service] = {"link": raw.strip(), "name": name, "items": got, "ts": time.time(), "error": ""}
        except ValueError as ex:
            DB[service] = {**(DB.get(service) or {}), "link": raw.strip(), "error": str(ex)}
        except Exception as ex:
            note("connections: " + service, ex)
            DB[service] = {**(DB.get(service) or {}), "link": raw.strip(), "error": f"{SERVICES[service]} didn't answer. Try again in a minute"}
        finally:
            WORKING.discard(service)
            try: _save()
            except Exception as ex: note("connections: save", ex)
        if not DB[service].get("error") and ON_SYNC:
            try: ON_SYNC()
            except Exception as ex: note("connections: rebuild picks", ex)
    threading.Thread(target=run, daemon=True).start()
    return status()


def remove(service):
    if service not in SERVICES: raise ValueError("Unknown source")
    DB.pop(service, None); _save()
    return status()


# ---------------- what Picks uses ----------------
def artists(n=150):
    """Artists across everything connected, most frequent first."""
    count, name = {}, {}
    for i in items():
        k = akey(i.get("artist") or "")
        if len(k) < 2: continue
        count[k] = count.get(k, 0) + 1; name.setdefault(k, i["artist"])
    return [(k, name[k]) for k in sorted(count, key=count.get, reverse=True)[:n]]


def owned_vids(): return {i.get("yt") or i.get("seed_vid") for i in items()} - {None}


def seeds(rot, k, lookup):
    """k connected tracks to start YouTube mixes from, rotating through the list each refresh. lookup(query) -> video id
    finds a YouTube video for SoundCloud / Discogs entries (at most 2 new lookups per refresh, remembered after)."""
    pool = items()
    if not pool: return []
    o = (rot * k) % len(pool); pool = pool[o:] + pool[:o]
    out, looked, changed = [], 0, False
    for i in pool:
        v = i.get("yt") or i.get("seed_vid")
        if not v and looked < 2:
            looked += 1
            try: v = lookup(f"{i['artist']} {i['title']}")
            except Exception as ex: note("connections: seed lookup", ex); v = None
            if v:
                for x in (DB.get(i["svc"]) or {}).get("items") or []:
                    if x.get("title") == i["title"] and x.get("artist") == i["artist"]: x["seed_vid"] = v; changed = True
        if v: out.append((v, i["title"], i["svc"]))
        if len(out) >= k: break
    if changed:
        try: _save()
        except Exception as ex: note("connections: save", ex)
    return out
