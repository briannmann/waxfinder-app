"""Library genre lookup. genre_tags.json is permanent user data; never rebuild or wipe it.

Only published listing metadata is used. Exact artist/title/version matches get store genres;
unmatched songs stay untagged. Audio model estimates never count as genre tags.
"""
import hashlib
import json
import queue
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path
from paths import safe_replace
from concurrent.futures import ThreadPoolExecutor

import setbuild
import traxsource
import discogs_api
from stylecleanup import published
from names import display_name, split_artists

FILE = Path(__file__).parent / "genre_tags.json"
LOCK = threading.RLock()
MIN_INTERVAL = 0.0  # No fixed delay between successful Traxsource requests.
RETRY_SECONDS = 30
MAX_RETRY_SECONDS = 15 * 60
HIST_LOADER = None
_last_request = 0.0
SOURCES = ("Traxsource", "Discogs (release styles)")
GENERIC = {"House", "Techno", "Electro", "Trance", "Downtempo"}


def _load():
    try:
        d = json.loads(FILE.read_text())
    except FileNotFoundError:
        d = {}
    # A damaged store must never be silently replaced with an empty one.
    if not isinstance(d, dict):
        raise ValueError("Invalid genre_tags.json; existing tags were preserved")
    d.setdefault("tracks", {})
    d.setdefault("searches", {})
    d.setdefault("discogs", {})
    d.setdefault("source_errors", {})
    d.setdefault("job", {"state": "idle", "done": 0, "total": 0})
    # Migrate the old Traxsource-only cooldown without blocking the new backup.
    if d["job"].get("state") == "paused" and not d["source_errors"] and d["job"].get("retry_at"):
        d["source_errors"]["traxsource"] = {"error": d["job"].get("error", "Traxsource paused"),
                                             "retry_at": d["job"]["retry_at"]}
    return d


DB = _load()
JOB = DB["job"]
_running = False
_retry_timer = None


def _save():
    tmp = FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(DB, ensure_ascii=False, indent=1))
    safe_replace(tmp, FILE)


def identity(e):
    if e.get("rb"):
        artist, title = str(e.get("artist") or "").strip(), str(e.get("rbtitle") or "").strip()
        if not artist:
            _, artist, title = display_name(title)
        return artist, title
    stem = re.sub(r"^[0-9a-f]{8}-", "", Path(e["file"]).stem)
    stem = re.sub(r" \(\d+\)$", "", stem)
    _, artist, title = display_name(stem)
    return artist, title


def norm(s):
    s = unicodedata.normalize("NFKD", s).casefold()
    return "".join(c for c in s if c.isalnum() and not unicodedata.combining(c))


def clean_title(s):
    s = re.sub(r"\s*[\[(](?:\d{4}|full length|official audio|official video|hd|hq|320(?:kbps)?)[\])]", "", s, flags=re.I)
    s = re.sub(r"\s+\d{4}$", "", s)
    return re.sub(r"\s*[\[(]original(?: mix| version)?[\])]\s*$", "", s, flags=re.I).strip()


def key(e):
    # Copies share tags, but differently named remixes remain separate.
    a, t = identity(e)
    return identity_key(a, t)


def identity_key(artist, title):
    return hashlib.sha256((norm(artist) + "\0" + norm(clean_title(title))).encode()).hexdigest()[:24]


def stored(e):
    return DB["tracks"].get(key(e), {})


def styles(e):
    rec = stored(e)
    return rec.get("styles", [])[:2] if published(rec) else []


def source(e):
    return stored(e).get("source", "") if styles(e) else ""


def needs_lookup(e):
    rec = stored(e)
    if styles(e):
        return False
    return rec.get("status") != "not_found" or not {"traxsource", "discogs"}.issubset(rec.get("checked_sources", []))


def _http(url):
    global _last_request
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https" and parsed.hostname == "api.discogs.com":
        return discogs_api.read(parsed.path + ("?" + parsed.query if parsed.query else ""))
    time.sleep(max(0, MIN_INTERVAL - (time.monotonic() - _last_request)))
    _last_request = time.monotonic()
    headers = {"User-Agent": "Waxfinder/1.0 (personal music library)"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def match(artist, title, rows):
    wanted = norm((split_artists(artist) or [""])[0])
    title_key = norm(clean_title(title))
    if not wanted or not title_key:
        return None
    hits = []
    for r in rows:
        main = {norm(a[2]) for a in r.get("artist", []) if isinstance(a, list) and len(a) >= 3 and a[1] == 1}
        if wanted not in main or norm(clean_title(r.get("title") or "")) != title_key:
            continue
        tid, genre = str(r.get("track_id") or ""), r.get("genre")
        if not tid.isdigit() or not isinstance(genre, str) or not genre.strip():
            continue
        if not (r.get("track_url") or "").startswith("/track/" + tid + "/"):
            continue
        hits.append(r)
    # Multiple releases with conflicting genres remain unconfirmed.
    return hits[0] if hits and len({r["genre"].casefold() for r in hits}) == 1 else None


def lookup(artist, title):
    # A track may already be in another artist/title search's saved store results.
    # Exact version matching still applies; a cache hit never needs a new request.
    hit = cached_traxsource(artist, title)
    if hit:
        return hit
    # Title in the query avoids taking only the first page of a prolific artist's songs.
    base = re.sub(r"\s*[\[(].*", "", clean_title(title)).strip()
    query = (split_artists(artist) or [artist])[0] + " " + base
    qkey = norm(query)
    if qkey not in DB["searches"]:
        html = traxsource.search_html(query, _http)
        ids = traxsource.track_ids(html)[:40]
        # Empty challenge/error pages must not become permanent 'not found' results.
        if not ids and not traxsource.is_search_page(html):
            # Verification/transport failures are raised by the adapter. Other
            # unconfirmed result pages remain pending for this track only.
            raise traxsource.QueryRejected("Traxsource could not confirm a results page for this track")
        rows = []
        for i in range(0, len(ids), 20):
            rows.extend(traxsource.player_rows(_http(traxsource.PLAYER + "?" + urllib.parse.urlencode({"tracks": ",".join(ids[i:i + 20])}))))
        with LOCK:
            DB["searches"][qkey] = rows
            _save()
    return match(artist, title, DB["searches"][qkey])


def cached_traxsource(artist, title):
    with LOCK:
        rows = [row for results in DB["searches"].values() for row in results]
    return match(artist, title, rows)


def pending(hist):
    return [e for e in setbuild.library(hist) if needs_lookup(e)]


def _discogs(path):
    cache = DB.setdefault("discogs", {})
    if path not in cache:
        data = json.loads(_http("https://api.discogs.com" + path))
        if path.startswith("/database/search?"):
            if not isinstance(data.get("results"), list):
                raise RuntimeError("Discogs returned an unrecognised search response")
            data = {"results": [{k: r.get(k) for k in ("id", "title", "type")} for r in data["results"]]}
        else:
            if not isinstance(data.get("tracklist"), list):
                raise RuntimeError("Discogs returned no release tracklist")
            data = {k: data.get(k) for k in ("id", "title", "artists", "tracklist", "styles", "formats")}
        with LOCK:
            cache[path] = data
            _save()
    return cache[path]


def _discogs_artist(s):
    return norm(re.sub(r"\s*\(\d+\)$", "", s or ""))


def discogs_match(artist, title, release):
    wanted = _discogs_artist((split_artists(artist) or [""])[0])
    main = {_discogs_artist(a.get("name")) for a in release.get("artists") or []}
    if not wanted or wanted not in main:
        return None
    if any("Compilation" in f.get("descriptions", []) for f in release.get("formats") or []):
        return None
    styles = [s.strip() for s in release.get("styles") or [] if isinstance(s, str) and s.strip()]
    if not styles:
        return None
    for t in release.get("tracklist") or []:
        artists = {_discogs_artist(a.get("name")) for a in t.get("artists") or release.get("artists") or []}
        if t.get("type_", "track") != "track" or wanted not in artists:
            continue
        if norm(clean_title(t.get("title") or "")) == norm(clean_title(title)):
            # Retain all release styles; the table displays the first two.
            specific = [s for s in styles if s not in GENERIC]
            return {"styles": specific + [s for s in styles if s in GENERIC],
                    "source": "Discogs (release styles)", "url": "https://www.discogs.com/release/" + str(release["id"]),
                    "release_id": release["id"], "matched_title": t["title"], "release_title": release.get("title")}
    return None


def lookup_discogs(artist, title):
    main = (split_artists(artist) or [artist])[0]
    base = re.sub(r"\s*[\[(].*", "", clean_title(title)).strip()
    query = urllib.parse.urlencode({"q": main + " " + base, "type": "release", "per_page": 20})
    hits = _discogs("/database/search?" + query)["results"]
    tried = 0
    for r in hits:
        # Skip compilation hits before fetching their full tracklists.
        credit = (r.get("title") or "").partition(" - ")[0]
        if _discogs_artist(main) not in {_discogs_artist(a) for a in split_artists(credit)}:
            continue
        if r.get("type") != "release" or not str(r.get("id") or "").isdigit():
            continue
        release = _discogs("/releases/" + str(r["id"]))
        found = discogs_match(artist, title, release)
        if found:
            return found
        tried += 1
        if tried >= 3:
            break
    return None


def _lookup_sources(artist, title, previous, source_names=("traxsource", "discogs")):
    checked = list(previous.get("checked_sources") or (["traxsource"] if previous.get("status") == "not_found" else []))
    if not artist or not title:
        return None, ["traxsource", "discogs"]
    failures = DB.setdefault("source_errors", {})
    for name, fn in (("traxsource", lookup), ("discogs", lookup_discogs)):
        if name not in source_names:
            continue
        with LOCK:
            paused = time.time() < failures.get(name, {}).get("retry_at", 0)
        if name in checked:
            continue
        cached = cached_traxsource(artist, title) if name == "traxsource" else None
        query_error = DB.get('query_errors', {}).get(identity_key(artist, title), {}) if name == 'traxsource' else {}
        if time.time() < query_error.get('retry_at', 0) and not cached:
            continue
        if paused and not cached:
            continue
        try:
            row = cached or fn(artist, title)
            checked.append(name)
            if not cached:
                with LOCK:
                    failures.pop(name, None)
            if name == 'traxsource':
                with LOCK:
                    DB.get('query_errors', {}).pop(identity_key(artist, title), None)
            if row and name == "traxsource":
                row = {"styles": [row["genre"].strip()], "source": "Traxsource",
                       "url": traxsource.BASE + row["track_url"], "track_id": str(row["track_id"]),
                       "matched_title": row["title"]}
            if row:
                return row, checked
        except traxsource.QueryRejected as exc:
            with LOCK:
                DB.setdefault('query_errors', {})[identity_key(artist, title)] = {
                    'error': str(exc), 'retry_at': time.time() + exc.retry_after}
        except Exception as exc:
            with LOCK:
                attempts = failures.get(name, {}).get('attempts', 0) + 1
                if isinstance(exc, traxsource.SearchUnavailable) or not hasattr(exc, 'retry_after'):
                    wait = max(getattr(exc, 'retry_after', 0), min(MAX_RETRY_SECONDS, RETRY_SECONDS * 2 ** min(attempts - 1, 5)))
                else:
                    wait = exc.retry_after  # Honour the server's own Retry-After.
                failures[name] = {"error": str(exc)[:200], "retry_at": time.time() + wait, 'attempts': attempts}
                if name == 'traxsource':
                    failures[name]['browser_transport'] = traxsource.BROWSER_TRANSPORT
    return None, checked


def _schedule_retry(todo):
    """One daemon timer resumes incomplete work, even when no browser tab is open.

    Call under LOCK. Deadlines come from source failures, so manual retries cannot
    extend a source's cooldown or reset a server-requested wait.
    """
    global _retry_timer
    if _retry_timer:
        _retry_timer.cancel()
        _retry_timer = None
    if not todo or not HIST_LOADER:
        return

    def resume_later():
        global _retry_timer
        with LOCK:
            if _retry_timer is not timer:
                return
            _retry_timer = None
        try:
            with LOCK:
                failure = DB.get('source_errors', {}).get('traxsource', {})
                waiting_for_user = 'its search window' in failure.get('error', '')
                still_cooling = time.time() < JOB.get('retry_at', 0)
            if waiting_for_user and still_cooling:
                # Read the already-open page, without another website request.
                if not traxsource.browser_ready():
                    with LOCK:
                        _schedule_retry(todo)
                    return
                with LOCK:
                    if DB.get('source_errors', {}).get('traxsource') is failure:
                        DB['source_errors'].pop('traxsource', None)
            start(HIST_LOADER())
        except Exception:
            with LOCK:
                JOB.update(state="paused", error="Could not reload library for genre retry",
                           retry_at=time.time() + RETRY_SECONDS)
                _schedule_retry(todo)
                _save()

    delay = max(1, JOB["retry_at"] - time.time())
    if 'its search window' in DB.get('source_errors', {}).get('traxsource', {}).get('error', ''):
        delay = min(delay, 1)  # Passive page check, not another search request.
    timer = threading.Timer(delay, resume_later)
    timer.daemon = True
    _retry_timer = timer
    timer.start()


def start(hist):
    global _running, _retry_timer
    with LOCK:
        if _running:
            return dict(JOB)
        if _retry_timer:
            _retry_timer.cancel()
            _retry_timer = None
        todo = list({key(e): e for e in pending(hist)}.values())
        JOB.update(state="working" if todo else "done", done=0, total=len(todo), matched=0,
                   not_found=0, pending=len(todo), current="", error="", retry_at=0, started=time.time())
        _running = bool(todo)
        _save()
        if todo:
            threading.Thread(target=_run, args=(todo,), daemon=True).start()
    return dict(JOB)


def resume(hist):
    with LOCK:
        old = DB.get('source_errors', {}).get('traxsource', {})
        if old and old.get('browser_transport') != traxsource.BROWSER_TRANSPORT and re.search('browser|verification|unrecognised search page', old.get('error', ''), re.I):
            # One controlled attempt with the new browser, instead of inheriting
            # the old hidden browser's local verification cooldown. Server rate
            # limits and the new browser's own cooldown are never cleared here.
            DB['source_errors'].pop('traxsource', None)
            _save()
    if JOB.get("state") in ("queued", "working", "paused", "done"):
        return start(hist)


def _run(todo):
    """Traxsource searches the next song while Discogs checks earlier misses.

One worker per store; Discogs still uses the shared authenticated request limiter.
Traxsource matches finish immediately, so they never incur a Discogs request.
"""
    global _running
    waiting = queue.Queue()
    stop = threading.Event()
    with LOCK:
        JOB["parallel"] = True
        JOB["lanes"] = {s: {"state": "waiting", "done": 0, "current": ""} for s in ("traxsource", "discogs")}

    def lane(name, state, e=None):
        with LOCK:
            current = " - ".join(identity(e)).strip(" -") if e else ""
            JOB["lanes"][name].update(state=state, current=current)
            if current:
                JOB["current"] = current

    def commit(e, row, checked, finished, name):
        artist, title = identity(e)
        with LOCK:
            previous = stored(e)
            old_checked = previous.get("checked_sources") or (["traxsource"] if previous.get("status") == "not_found" else [])
            # A skipped source is not a completed lookup. Don't rewrite every
            # deferred record, or label a blocked attempt 'not found'.
            if not row and checked == old_checked and previous:
                return
            rec = {**stored(e), "artist": artist, "title": title, "checked": time.time(),
                   "checked_sources": checked, "status": "not_found" if len(checked) == 2 else "retry", "styles": []}
            if row:
                rec.update(row, status="matched")
            DB["tracks"][key(e)] = rec
            if row or checked != old_checked:
                JOB["lanes"][name]["done"] += 1
            if finished:
                JOB["done"] += 1
                JOB["matched" if row else "not_found"] += 1
            failures = DB.get("source_errors", {})
            JOB["error"] = "; ".join(s + ": " + x["error"] for s, x in failures.items())
            if all(time.time() < failures.get(s, {}).get("retry_at", 0) for s in ("traxsource", "discogs")):
                stop.set()
            _save()

    def traxsource_worker():
        try:
            for e in todo:
                if stop.is_set():
                    break
                if not needs_lookup(e):
                    with LOCK:
                        JOB["done"] += 1
                    continue
                lane("traxsource", "working", e)
                artist, title = identity(e)
                row, checked = _lookup_sources(artist, title, stored(e), ("traxsource",))
                finished = bool(row) or {"traxsource", "discogs"}.issubset(checked)
                commit(e, row, checked, finished, "traxsource")
                if not finished and "discogs" not in checked:
                    waiting.put(e)
        except Exception:
            stop.set()
            raise
        finally:
            waiting.put(None)
            lane("traxsource", "done")

    def discogs_worker():
        try:
            while True:
                lane("discogs", "waiting")
                e = waiting.get()
                if e is None:
                    break
                if stop.is_set():
                    continue
                lane("discogs", "working", e)
                artist, title = identity(e)
                row, checked = _lookup_sources(artist, title, stored(e), ("discogs",))
                finished = bool(row) or {"traxsource", "discogs"}.issubset(checked)
                commit(e, row, checked, finished, "discogs")
        except Exception:
            stop.set()
            raise
        finally:
            lane("discogs", "done")

    try:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="wax-genres") as pool:
            workers = [pool.submit(traxsource_worker), pool.submit(discogs_worker)]
            for worker in workers:
                worker.result()
        with LOCK:
            if stop.is_set():
                JOB.update(state="paused", retry_at=min(x["retry_at"] for x in DB["source_errors"].values()))
            else:
                JOB.update(state="done", current="", finished=time.time())
    except Exception as exc:
        with LOCK:
            JOB.update(state="paused", error=str(exc)[:240], retry_at=time.time() + RETRY_SECONDS)
    finally:
        with LOCK:
            _running = False
            remaining = [e for e in todo if needs_lookup(e)]
            JOB["pending"] = len(remaining)
            JOB["current"] = ""
            if remaining:
                needed = set()
                for e in remaining:
                    rec = stored(e)
                    checked = rec.get("checked_sources") or (["traxsource"] if rec.get("status") == "not_found" else [])
                    needed.update({"traxsource", "discogs"} - set(checked))
                failures = {s: x for s, x in DB.get("source_errors", {}).items() if s in needed}
                deadlines = [x["retry_at"] for x in failures.values() if x.get("retry_at")]
                rejected = [DB.get('query_errors', {}).get(key(e), {}) for e in remaining]
                deadlines.extend(x['retry_at'] for x in rejected if x.get('retry_at', 0) > time.time())
                JOB['query_rejected'] = sum(bool(x) for x in rejected)
                retry_at = min(deadlines) if deadlines else JOB.get("retry_at") or time.time() + RETRY_SECONDS
                error = "; ".join(s + ": " + x["error"] for s, x in failures.items()) or JOB.get("error", "")
                JOB.update(state="paused", retry_at=max(time.time() + 1, retry_at), error=error)
                for name, failure in failures.items():
                    JOB.get("lanes", {}).get(name, {}).update(state="paused", retry_at=failure.get("retry_at", 0))
                _schedule_retry(remaining)
            else:
                JOB.update(state="done", pending=0, query_rejected=0, retry_at=0, error="", finished=time.time())
            _save()
