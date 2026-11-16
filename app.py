"""Local YouTube -> MP3 converter. Personal test use only. Accessible on the local network."""
import sys
if sys.platform == "win32" and not sys.flags.utf8_mode:   # data files are UTF-8; Windows' default cp1252 would garble them on save
    sys.exit("Start Waxfinder with start.cmd (it turns on Python's UTF-8 mode).")
FROZEN = getattr(sys, "frozen", False)   # True in the Windows installer build (PyInstaller)
if FROZEN:
    # No console in the installed app: send output to server.log, and stop helper programs (ffmpeg...) flashing console windows.
    import os as _os, subprocess as _sp
    _log = open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "server.log"), "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr = _log
    _Popen = _sp.Popen
    class _QuietPopen(_Popen):
        def __init__(self, *a, **k):
            k["creationflags"] = k.get("creationflags", 0) | 0x08000000   # CREATE_NO_WINDOW
            if "stdin" not in k: k["stdin"] = _sp.DEVNULL   # a windowed app has no stdin; an unset one raises "invalid handle"
            super().__init__(*a, **k)
    _sp.Popen = _QuietPopen
import json, hashlib, threading, uuid, re, time, urllib.request, urllib.error, subprocess, os, shutil, unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote
import yt_dlp, imageio_ffmpeg
from labels import extract_label
from names import parse_title, akey, display_name, safe_filename, credits
import smartcrates, library_setting, taste, lastfm, profile, popularity, bpm as tempo, setbuild, crates, soundindex, discover, rblink, libindex, genres, cdjexport, libremove, artistlookup, artwork
import stylecleanup, discogs_api, energy
import ownership
import manualowned, saved, trackedit
from pickrules import excluded_pick
from paths import posix, safe_replace, note, atomic_write
from concurrent.futures import ThreadPoolExecutor, wait

LOCAL_OUT = (Path.home() / "Music" / "Waxfinder") if FROZEN else (Path(__file__).parent / "downloads")   # fallback only, when no library folder is chosen / the stick isn't plugged in
LOCAL_OUT.mkdir(parents=True, exist_ok=True)
USB = Path("/Volumes/MUSIC")   # the 128 GB SanDisk: songs live here, not on the laptop
class LibraryOffline(OSError):
    """The folder chosen as the library is not reachable. Nothing is redirected elsewhere: the caller must say so."""

OFFLINE_MSG = "Your chosen library folder isn't available. Plug the drive back in, or pick another folder in Files."

def out_dir():
    """Where songs go right now: the chosen library folder, else the stick if it's mounted (never create /Volumes/MUSIC ourselves), else the laptop.
    A chosen folder that is unreachable raises LibraryOffline instead of quietly saving somewhere else."""
    if library_setting.configured() and not library_setting.get(): raise LibraryOffline(OFFLINE_MSG)
    lib = library_setting.get()   # the folder this person chose; wins over the old MUSIC-stick default
    if lib: return lib
    if libindex.is_mount(USB):
        try: d = USB / "Waxfinder"; d.mkdir(exist_ok=True); return d
        except OSError: pass
    return LOCAL_OUT
def nfc(x): return unicodedata.normalize("NFC", posix(x))   # FAT32/APFS hand back accents decomposed; history stores composed
AUDIO_EXT = {"mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "aiff": "audio/aiff", "aif": "audio/aiff", "m4a": "audio/mp4"}
def is_audio(f): return f.suffix[1:].lower() in AUDIO_EXT and not f.name.startswith(("._", "."))   # ._ = macOS sidecars on FAT32; . = imports in progress
def mime(ext): return AUDIO_EXT.get((ext or "").lower(), "application/octet-stream")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
JOBS = {}  # id -> {status, pct, file, error}
GENRE_CLEANUP = {}
HIST_FILE = Path(__file__).parent / "history.json"
RECS_FILE = Path(__file__).parent / "recs.json"
DISM_FILE = Path(__file__).parent / "dismissed.json"
VOTES_FILE = Path(__file__).parent / "votes.json"
META_FILE = Path(__file__).parent / "meta.json"   # video id -> views, channel followers, upload date (for the popularity check)
try: META = json.loads(META_FILE.read_text())
except Exception: META = {}
BPM_FILE = Path(__file__).parent / "bpm.json"   # video id -> BPM (0 = could not read); kept for good
try: BPMS = json.loads(BPM_FILE.read_text())
except Exception: BPMS = {}
MIX_FILE = Path(__file__).parent / "mixes.json"   # YouTube Mix / search results, kept a day so restarts don't refetch
try: MIXES = json.loads(MIX_FILE.read_text())   # key -> [fetched at, slim entries]
except Exception: MIXES = {}
COOL = {"until": 0.0}   # YouTube said "too many requests" / bot check: stop extra lookups for a while
def yt_cool(): return time.time() < COOL["until"]
def yt_trip(ex):
    m = str(ex)
    if "429" in m or "not a bot" in m or "Too Many Requests" in m: COOL["until"] = time.time() + 7200

def tkey(title):
    """Loose title key so re-uploads of the same track match: drop [..]/{..} tags and punctuation."""
    t = re.sub(r"\[[^\]]*\]|\{[^}]*\}", " ", (title or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", t).strip()

JUNK_RE = re.compile(r"\b(lyrics?|lyric video|type beat|reaction|reacts? to|slowed|sped[ -]?up|nightcore|8d audio|ai cover|"
                     r"karaoke|tutorial|how to make|full album|bass boosted|(?:\d+|one|two|ten) hours? (?:long|mix|loop|version|of)|ringtone)\b|#shorts", re.I)
TASTE_TAGS = {"house", "deep house", "chicago house", "soulful house", "afro house", "tech house", "garage", "uk garage", "speed garage",
              "disco", "nu disco", "boogie", "funk", "soul", "jazz", "acid jazz", "jazz-funk", "jazz funk", "nu jazz", "broken beat",
              "techno", "detroit techno", "minimal", "electronic", "electronica", "dance", "downtempo", "lo-fi house", "lofi house",
              "electro", "breaks", "dub", "r&b", "neo-soul", "neo soul", "hip-hop", "hip hop", "acid house", "italo disco"}
def junk(title): return bool(JUNK_RE.search(title or ""))

def source_weights(votes, dismissed, hist):
    """Learn which recommendation sources work for you: likes + downloads from picks vs passes + X's, smoothed."""
    pos, neg = {}, {}
    for x in votes.values():
        s = x["item"].get("src") or (x["item"].get("kind") if x["item"].get("kind") != "artist" else None)
        if s: (pos if x["v"] == 1 else neg)[s] = (pos if x["v"] == 1 else neg).get(s, 0) + 1
    for d in dismissed.values():
        s = d.get("src") or (d.get("kind") if d.get("kind") != "artist" else None)
        if s: neg[s] = neg.get(s, 0) + .5   # an X is often "already have it", so it only half counts
    for e in hist:
        if e.get("src"): pos[e["src"]] = pos.get(e["src"], 0) + 2   # downloading a pick is the strongest yes
    g = (sum(pos.values()) + 1) / (sum(neg.values()) + 1)   # your overall hit rate; each source is judged against it
    return {s: round(max(.6, min(1.8, (pos.get(s, 0) + 2 * g) / (neg.get(s, 0) + 2) / g)), 2) for s in set(pos) | set(neg)}

def track_key(title, channel=""):
    """Same song = same key, whatever the upload calls it: drops (Official Video), '| Sofar London', etc.
    Bare titles on YouTube's auto-made 'Artist - Topic' channels get that artist (never a label channel's name)."""
    shown = display_name(re.split(r"\s+[•·]\s+", title or "")[0])[0]
    if not parse_title(shown)[0] and (channel or "").endswith(" - Topic"): shown = channel[:-8].strip() + " - " + shown
    return taste.own_key(None, shown) or tkey(shown)

def pick_diverse(order, info, n=24, per_seed=3, per_chan=2, out=None):
    """Greedy: best first, at most per_seed picks from one seed and per_chan from one channel; relax only to back-fill."""
    out = list(out or []); chosen = set(out); songs = {track_key(info[c]["title"], info[c]["channel"]) for c in out}
    for ps, pc in ((per_seed, per_chan), (per_seed + 2, per_chan + 1), (99, 99)):
        bs, bc = {}, {}
        for c in out: sk = info[c].get("seed") or info[c]["because"]; bs[sk] = bs.get(sk, 0) + 1; bc[info[c]["channel"]] = bc.get(info[c]["channel"], 0) + 1
        for c in order:
            if len(out) >= n or (pc == 99 and len(out) >= min(n, 20)): break
            if c in chosen: continue
            i = info[c]
            sk = track_key(i["title"], i["channel"])
            if sk in songs: continue   # two uploads of one song: keep the better-ranked one
            seedk = i.get("seed") or i["because"]
            if bs.get(seedk, 0) >= ps or bc.get(i["channel"], 0) >= pc: continue
            out.append(c); chosen.add(c); songs.add(sk); bs[seedk] = bs.get(seedk, 0) + 1; bc[i["channel"]] = bc.get(i["channel"], 0) + 1
        if len(out) >= min(n, 20): break
    return out

def enrich(item):
    if item.get("src") in discover.SRC_NAME:
        i = dict(item)
        i["track"] = discover.clean_title(i.get("artist"), i.get("track") or i.get("title"))
        return i
    i = dict(item); a, tr = parse_title(i.get("title"))
    ch = i.get("channel") or ""
    if not a and ch.endswith(" - Topic"): a = ch[:-8].strip()  # YouTube's auto-made artist channels
    i["artist"], i["track"] = a or "", tr
    return i

# Only a missing file starts empty. A damaged one stops the app instead: starting empty would save over your votes.
try: DISMISSED = json.loads(DISM_FILE.read_text())  # video id -> recommendation item (with "tk")
except FileNotFoundError: DISMISSED = {}
try: VOTES = json.loads(VOTES_FILE.read_text())  # video id -> {"v": 1 | -1, "ts", "item"}
except FileNotFoundError: VOTES = {}
LOCK = threading.Lock()

def load_hist():
    try: return json.loads(HIST_FILE.read_text())
    except FileNotFoundError: return []   # a damaged file raises: [] here let the next save (seed_hist runs at every start) wipe history.json

def save_hist(h):
    tmp = HIST_FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps(h, indent=1)); safe_replace(tmp, HIST_FILE)   # atomic

def load_all():
    """History + tracks linked from Rekordbox playlists (in memory only; history.json is never given them)."""
    return rblink.load_all(load_hist())


def owned_library():
    """Downloads, all scanned/linked USB files and every crate/set snapshot; no analysis required."""
    return ownership.Index([*load_all(), *manualowned.items()], crates._load())

def _same_bytes(a, b):
    """True only when two files hold identical bytes (size first, then a streamed compare)."""
    try:
        if a.stat().st_size != b.stat().st_size: return False
        with open(a, "rb") as x, open(b, "rb") as y:
            while True:
                p, q = x.read(1 << 20), y.read(1 << 20)
                if p != q: return False
                if not p: return True
    except OSError: return False

def to_usb():
    """Move songs saved on the laptop while the stick was out onto the stick, and repoint history at them.
    Never overwrites and never duplicates: a name already on the drive is treated as the same song and the laptop file is left alone. Each file is copied to a temp name,
    verified, recorded in history (saved to disk), and only then removed from the laptop, so a crash loses nothing."""
    try: d = out_dir()
    except LibraryOffline: return
    if d == LOCAL_OUT: return
    with LOCK:
        h = load_hist()
        for f in sorted(LOCAL_OUT.iterdir()):
            if not is_audio(f): continue
            try:
                dst = d / f.name
                if dst.exists() and not _same_bytes(f, dst):
                    # Same name = same song: don't add a second copy to the library. The laptop file is left exactly where it is
                    # (nothing is deleted or overwritten) and history keeps pointing at it.
                    note("app: to_usb name already on the drive, left on the laptop", f.name); continue
                if not dst.exists():
                    tmp = d / f".moving-{uuid.uuid4().hex[:8]}{f.suffix}"
                    try:
                        shutil.copyfile(f, tmp)
                        if not _same_bytes(f, tmp): tmp.unlink(missing_ok=True); continue
                        os.replace(tmp, dst)
                    except OSError: tmp.unlink(missing_ok=True); continue
                for e in h:
                    if nfc(e["file"]) == nfc(f): e["file"] = posix(dst)
                save_hist(h)       # the reference is on disk before the only other copy goes
                f.unlink()
            except OSError: continue

def seed_hist():
    """Adopt files already in the song folder that have no history entry (channel unknown)."""
    h = load_hist(); known = {nfc(e["file"]) for e in h}
    try: import relocate; known |= relocate.targets()   # a reconnected download at its new place is not a new song
    except Exception as ex: note("app: seed_hist moved files", ex)
    try: od = out_dir()
    except LibraryOffline: return
    for f in sorted(od.iterdir()):
        if is_audio(f) and nfc(f) not in known:
            m = re.match(r"^([0-9a-f]{8})-(.+)$", f.stem)
            h.append({"id": m.group(1) if m else uuid.uuid4().hex[:8], "title": m.group(2) if m else f.stem, "ext": f.suffix[1:],
                      "file": posix(f), "url": "", "channel": "Unknown channel", "channel_url": "", "date": f.stat().st_mtime})
    save_hist(h)
to_usb(); seed_hist()

PLAY_DIR = Path(__file__).parent / "play_cache"   # browser-playable copies (AIFF -> WAV); disposable, rebuilt on demand
def play_copy(e):
    PLAY_DIR.mkdir(exist_ok=True); src = Path(e["file"]); st = src.stat()
    dst = PLAY_DIR / f"{e['id']}-{st.st_size}-{int(st.st_mtime)}.wav"
    if not dst.exists():
        tmp = PLAY_DIR / f".{uuid.uuid4().hex[:8]}.part.wav"   # unique: two requests may convert at once; last replace wins
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-map", "0:a", "-c:a", "pcm_s16le", str(tmp)], check=True, timeout=300)
        os.replace(tmp, dst)
    return dst

# ---------- importing your own files (Library "Add files" / "Add folder" / drag-drop) ----------
IMPORT_MAX = 1024 ** 3   # 1 GB per file
def file_tags(path):
    """artist/title from the file's own tags (ffmpeg reads ID3, Vorbis, AIFF, MP4)."""
    try:
        out = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-f", "ffmetadata", "-"], capture_output=True, text=True, timeout=30).stdout
        tags = {}
        for line in out.splitlines():
            k, sep, v = line.partition("=")
            if sep and k.lower() in ("artist", "title", "album_artist") and v.strip(): tags.setdefault(k.lower(), v.strip())
        return tags.get("artist") or tags.get("album_artist"), tags.get("title")
    except Exception: return None, None

def _on_unplugged_drive(f):
    """A /Volumes/<name>/... file whose drive is not mounted right now (the track is still part of the library, just out of reach)."""
    parts = Path(f).parts
    return len(parts) > 2 and parts[1] == "Volumes" and not os.path.isdir("/".join(parts[:3]))

def find_duplicate(lib, key, dur):
    """The library track an incoming file is the same song as, else None. Looks at EVERYTHING in the library (downloads, Rekordbox links,
    scanned USB files), not just downloads. A copy on an unplugged drive still counts. A file whose length differs by more than 3 s is a
    different edit/mix, so it is added rather than dropped as a duplicate."""
    for e in lib:
        f = e.get("file")
        if not f or setbuild.song_key(e) != key: continue
        if not (os.path.exists(f) or _on_unplugged_drive(f)): continue   # a deleted file does not block re-adding it
        d0 = e.get("duration")
        if dur and d0 and abs(float(d0) - dur) > 3: continue
        return e
    return None

def import_file(tmp, name):
    """A finished upload on disk -> named library file + history entry. Returns what the page shows."""
    ext = Path(name).suffix[1:].lower()
    stem = re.sub(r"^\s*\d{1,3}\s*[-._)]\s*", "", Path(name).stem)   # "01 - Artist - Title" / "03. Title"
    artist, title = file_tags(str(tmp))
    if not (artist and title):
        a2, t2 = parse_title(stem)
        artist, title = artist or a2, title or t2 or stem
    shown = re.sub(r"[<>&\"]", "", f"{artist} - {title}" if artist else title).strip() or "track"
    key = re.sub(r"[^a-z0-9]+", "", shown.lower())
    dur = file_duration(str(tmp))
    with LOCK:
        h = load_hist()
        dup = find_duplicate(load_all(), key, dur)
        if dup:
            Path(tmp).unlink(missing_ok=True)
            return {"status": "duplicate", "id": dup["id"], "title": dup.get("title") or dup.get("rbtitle") or Path(dup.get("file", "")).stem, "where": posix(Path(dup["file"]).parent) if dup.get("file") else ""}
        d = Path(tmp).parent; dst = d / f"{safe_filename(shown)}.{ext}"; n = 2
        while dst.exists(): dst = d / f"{safe_filename(shown)} ({n}).{ext}"; n += 1
        os.replace(tmp, dst)
        e = {"id": uuid.uuid4().hex[:8], "title": shown, "ext": ext, "file": posix(dst), "url": "", "channel": "Your files", "channel_url": "",
             "date": time.time(), "duration": dur, "src": "upload"}
        h.append(e); save_hist(h)
    setbuild.start_analysis(load_hist()); soundindex.start(load_hist()); warm_waves()
    return {"status": "added", "id": e["id"], "title": shown, "duration": e["duration"]}

PICKWAVE_FILE = Path(__file__).parent / "pick_waves.json"   # waveforms for Picks (YouTube streams); a disposable cache
try: PICKWAVES = json.loads(PICKWAVE_FILE.read_text())
except Exception: PICKWAVES = {}
# Pick waveforms are made by ONE background worker, never in bursts: 12 parallel YouTube lookups tripped the
# "too many requests" cool-down on 2026-11-02. A new lookup waits 8 s; a stream already resolved (e.g. previewed) goes straight through.
_PW_Q, _PW_SEEN, _PW_EV = [], set(), threading.Event()
def pick_wave_request(v):
    if v in PICKWAVES: return PICKWAVES[v]
    with LOCK:
        if v not in _PW_SEEN: _PW_SEEN.add(v); _PW_Q.append(v); _PW_EV.set()
    return None
def _pick_wave_worker():
    while True:
        _PW_EV.wait()
        with LOCK:
            v = _PW_Q.pop(0) if _PW_Q else None
            if not _PW_Q: _PW_EV.clear()
        if not v or v in PICKWAVES: continue
        if yt_cool():
            with LOCK: _PW_SEEN.discard(v)   # ask again after the cool-down
            continue
        warm = bool(STREAMS.get(v)) and STREAMS[v][2] > time.time()
        if not warm: time.sleep(8)
        pick_wave(v)
        with LOCK: _PW_SEEN.discard(v)
threading.Thread(target=_pick_wave_worker, daemon=True).start()
def pick_wave(v):
    """Overview waveform of a YouTube pick: pull the whole stream once at 4 kHz mono, 200 columns (peaks + low end)."""
    if v in PICKWAVES: return PICKWAVES[v]
    if yt_cool(): return None
    if True:
        try:
            import numpy as np
            url, hdrs, _ = resolve_stream(v)
            cmd = [FFMPEG, "-v", "error", "-nostdin"] + (["-headers", "".join(f"{k}: {x}\r\n" for k, x in hdrs.items())] if hdrs else []) + \
                  ["-i", url, "-ac", "1", "-ar", "4000", "-f", "f32le", "-"]
            x = np.frombuffer(subprocess.run(cmd, capture_output=True, timeout=120).stdout, dtype=np.float32)
            if len(x) < 4000 * 20: return None
            dur, bins = len(x) / 4000, 200
            low = np.convolve(x, np.ones(27, dtype=np.float32) / 27, mode="same")   # ~150 Hz box low-pass: the kick/bass body
            n = len(x) - len(x) % bins
            rms = lambda a: np.sqrt((a[:n].reshape(bins, -1) ** 2).mean(axis=1))
            pk, bs = rms(x), rms(low); top = max(float(pk.max()), 1e-6)
            res = {"duration": dur, "peaks": [round(float(q) / top, 2) for q in pk], "bass": [round(min(1.0, float(q) / top * 1.6), 2) for q in bs]}
            with LOCK:
                PICKWAVES[v] = res; tmp = PICKWAVE_FILE.with_suffix(".tmp"); tmp.write_text(json.dumps(PICKWAVES)); safe_replace(tmp, PICKWAVE_FILE)
            return res
        except Exception as ex:
            yt_trip(ex); return None

_HI = {"busy": False}
def warm_hi(ts, by):
    """Kick-position waveforms for tracks without a Rekordbox grid, a few at a time in the background (the Set page used to make them all before answering)."""
    todo = [(by[t["id"]], t["bpm"]) for t in ts if not t["grid"] and t["id"] in by and not setbuild.hi_made(by[t["id"]])]
    if _HI["busy"] or not todo: return
    _HI["busy"] = True
    def go():
        try:
            from concurrent.futures import ThreadPoolExecutor
            def one(x):
                try: setbuild.wave_hi(x[0], bpm=x[1])
                except Exception: pass
            with ThreadPoolExecutor(4) as ex: list(ex.map(one, todo))
        finally: _HI["busy"] = False
    threading.Thread(target=go, daemon=True).start()

_WARM = {"busy": False, "done": 0, "total": 0}
def warm_waves():
    """Make the overview waveform for any library track that lacks one (library + crate mini waveforms), five at a time, in the background."""
    if _WARM["busy"]: return
    _WARM["busy"] = True
    def go():
        try:
            todo = [e for e in setbuild.library(load_hist()) if not setbuild.wave_cached(e)]
            _WARM.update(done=0, total=len(todo))
            def one(e):
                try: setbuild.wave(e)
                except Exception: pass
                _WARM["done"] += 1
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(5) as ex: list(ex.map(one, todo))   # 5 at a time (ffmpeg + numpy release the GIL)
        finally: _WARM["busy"] = False
    threading.Thread(target=go, daemon=True).start()

def retag(f, job_id, shown, artist, track, fmt):
    """Rename to 'Artist - Title.ext' (no codes; ' (2)' if that name is taken) and write the same artist/title into the tags."""
    dst = f.with_name(f"{safe_filename(shown)}.{fmt}"); n = 2
    while dst.exists() and dst != f: dst = f.with_name(f"{safe_filename(shown)} ({n}).{fmt}"); n += 1
    tmp = f.with_name(f"{job_id}-tagging.{fmt}")
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", str(f), "-map", "0:a", "-c", "copy", "-map_metadata", "-1"]
    if artist: cmd += ["-metadata", f"artist={artist}"]
    cmd += ["-metadata", f"title={track}"]
    cmd += ["-id3v2_version", "3"] if fmt == "mp3" else ["-write_id3v2", "1"]
    try:
        subprocess.run(cmd + [str(tmp)], check=True, capture_output=True, timeout=120)
        tmp.replace(dst)
        if f != dst: f.unlink(missing_ok=True)   # same name already: the tagged file IS the download, keep it
        return dst
    except Exception:
        tmp.unlink(missing_ok=True)
        try: f.replace(dst); return dst   # tagging failed: still give it the right name
        except Exception: return f

def file_duration(path):
    try:
        err = subprocess.run([FFMPEG, "-i", path], capture_output=True, text=True, timeout=30).stderr
        m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", err)
        return round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])) if m else None
    except Exception: return None

def backfill_durations():
    h = load_hist(); changed = False
    for e in h:
        if not e.get("duration") and Path(e["file"]).exists():
            e["duration"] = file_duration(e["file"]); changed = changed or bool(e["duration"])
    if changed: save_hist(h)
backfill_durations()
try: RECS = json.loads(RECS_FILE.read_text())
except Exception: RECS = {"state": "idle", "items": [], "ts": 0, "error": ""}
if RECS["state"] == "working": RECS["state"] = "idle"

# Which sources Picks may use. "youtube" = everything build_recs makes (mixes, artists, labels, Rekordbox seeds).
# Off = hidden AND no new YouTube work (throttle or just a break). Discogs previews come from YouTube, so it rests with it.
PICK_SRC_FILE = Path(__file__).parent / "pick_sources.json"
PICK_SOURCES = ("youtube", "soundcloud", "bandcamp", "discogs", "traxsource")
try: PICK_OFF = set(json.loads(PICK_SRC_FILE.read_text()).get("off", [])) & set(PICK_SOURCES)
except Exception: PICK_OFF = set()
def pick_source(i): return i.get("src") if i.get("src") in discover.SRC_NAME else "youtube"
def disc_sources(off=None):
    off = PICK_OFF if off is None else off
    return [s for s in discover.SRC_NAME if s not in off and not (s == "discogs" and "youtube" in off)]
def discover_bg(hist):
    """Background discovery run limited to the allowed sources (none allowed = no run)."""
    src = disc_sources()
    if src: discover.start(hist, source_names=src)

STREAMS = {}  # video id -> (direct audio url, headers, expiry)

def resolve_stream(v, fresh=False):
    hit = STREAMS.get(v)
    if hit and not fresh and hit[2] > time.time(): return hit
    opts = {"quiet": True, "noplaylist": True, "skip_download": True, "ffmpeg_location": FFMPEG,
            "format": "bestaudio[ext=m4a]/bestaudio"}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(f"https://www.youtube.com/watch?v={v}", download=False)
    hit = (info["url"], info.get("http_headers", {}), time.time() + 1500)
    STREAMS[v] = hit
    META[v] = {"views": info.get("view_count"), "followers": info.get("channel_follower_count"), "up": info.get("upload_date"), "ts": time.time()}
    return hit

def vid_of(url):
    m = re.search(r"(?:v=|youtu\.be/)([\w-]{11})", url or "")
    return m.group(1) if m else None


def discovery_items(items, hist, owned=None):
    """Show cached sound matches immediately, interspersed with the existing YouTube picks."""
    owned = owned if owned is not None else owned_library()
    with LOCK:
        skip = set(VOTES) | set(DISMISSED) | {vid_of(e.get("url")) for e in hist}
        votes = dict(VOTES)
        sw = source_weights(votes, dict(DISMISSED), hist)
    skip |= owned.ids
    base = [i for i in items if i.get("src") not in discover.SRC_NAME and i["id"] not in skip and not excluded_pick(i) and not owned.contains(i)]
    slots = max(2, min(6, round(4 * sum(sw.get(k, 1.0) for k in discover.SRC_NAME) / len(discover.SRC_NAME))))
    if "youtube" in PICK_OFF: slots = 30   # discovery finds are the whole list now, not a few slots between YouTube picks
    target, like_rows = discover.like_picks(skip, hist, owned=owned, votes=votes, sources=disc_sources())
    found = discover.picks(slots, skip | {i["id"] for i in base} | {i["id"] for i in like_rows}, hist, votes=votes, owned=owned, sources=disc_sources())
    songs = {track_key(i["title"], i.get("channel", "")) for i in base}
    top = []   # "Find similar" results lead the list, best match first
    for i in like_rows:
        key = track_key(i["title"], i.get("channel", ""))
        if key in songs: base = [x for x in base if track_key(x["title"], x.get("channel", "")) != key]
        top.append(i); songs.add(key)
    for i in found:
        key = track_key(i["title"], i.get("channel", ""))
        if key not in songs:
            base.insert(min(len(base), 2 + 3 * sum(x.get("src") in discover.SRC_NAME for x in base)), i)
            songs.add(key)
    return top + base


def like_status():
    """What the Picks 'Sounds like' bar shows: the active target + the search's progress."""
    rec = discover.DB["targets"].get(discover.DB.get("like_active") or "")
    st = dict(discover.LIKE); st.pop("key", None)
    return {**st, "active": bool(rec), "target": {"artist": rec["artist"], "title": rec["title"]} if rec else None}


def like_resolver(url):
    """Pasted link -> callable giving (audio url, headers, duration, {artist, title}) for the sound model. Runs in the
    background search thread (network). Spotify audio is DRM-locked: its YouTube match is used, Spotify's names kept."""
    def run():
        u, meta = url, {}
        if "spotify" in url or "spoti.fi" in url:
            discover.LIKE["step"] = "finding the Spotify track on YouTube"
            sp = spotify_track(url); u = youtube_match(sp); meta = {"artist": sp["artist"], "title": sp["title"]}
        v = vid_of(u)
        if not v and re.search(r"soundcloud\.com|bandcamp\.com", u):   # same audio path the catalogue uses (SoundCloud needs a local preview)
            c = {"id": "lk:" + hashlib.md5(u.encode()).hexdigest()[:12], "src": "soundcloud" if "soundcloud" in u else "bandcamp", "page": u}
            got = discover.fingerprint_audio(c)
            if not got: raise ValueError("Couldn't get the audio from that link")
            a_url, hdrs, dur, info = got; info = info or {}
            if info.get("_type") == "playlist" or info.get("entries"): raise ValueError("Paste a single track, not an album or playlist")
            _, artist, track = display_name(info.get("track") and info.get("artist") and f"{info['artist']} - {info['track']}" or info.get("title") or "",
                                            info.get("channel") or "", info.get("uploader") or "")
            return a_url, hdrs, dur, {"artist": artist, "title": track}
        if v:
            if yt_cool(): raise ValueError("YouTube is cooling down, try again in a few minutes")
            with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True, "skip_download": True, "ffmpeg_location": FFMPEG,
                                   "format": "bestaudio[ext=m4a]/bestaudio"}) as y:
                info = y.extract_info(f"https://www.youtube.com/watch?v={v}", download=False)
            a_url, hdrs = info["url"], info.get("http_headers", {})
        else:
            with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True, "skip_download": True, "no_warnings": True}) as y:
                info = y.extract_info(u, download=False)
            if info.get("_type") == "playlist" or info.get("entries"): raise ValueError("Paste a single track, not an album or playlist")
            fm = info if info.get("url") else next((f for f in reversed(info.get("formats") or []) if f.get("url")
                                                     and not f.get("has_drm") and f.get("vcodec") in (None, "none")), {})
            a_url, hdrs = fm.get("url"), {**(info.get("http_headers") or {}), **(fm.get("http_headers") or {})}
            if not a_url: raise ValueError("Couldn't find audio at that link")
        if not meta:
            shown, artist, track = display_name(info.get("track") and info.get("artist") and f"{info['artist']} - {info['track']}" or info.get("title") or "",
                                                info.get("channel") or "", info.get("uploader") or "")
            meta = {"artist": artist, "title": track}
        return a_url, hdrs, info.get("duration"), meta
    return run


def recs_payload(build=True):
    """What /recs sends: the cached picks filtered to the allowed sources. Filtering is view-only, so YouTube picks
    come straight back when YouTube is switched on again. With YouTube off nothing here starts a YouTube rebuild."""
    yt_on = "youtube" not in PICK_OFF
    stale = not RECS["items"] or len(RECS["items"]) < 8 or time.time() - RECS["ts"] > 86400
    # A failed build used to leave state "error" forever (even across restarts) until someone pressed Refresh: retry on its own after 5 min.
    can_build = RECS["state"] not in ("working", "error") or (RECS["state"] == "error" and time.time() - RECS.get("err_ts", 0) > 300)
    if build and yt_on and can_build and stale:
        RECS["state"] = "working"; threading.Thread(target=build_recs, daemon=True).start()
    owned = owned_library()   # also filter cached/working/error responses after a new import/download
    if RECS["state"] in ("done", "error") or not yt_on:   # a failed YouTube build must not hide the SoundCloud/Bandcamp/etc. picks
        try: RECS["items"] = discovery_items(RECS["items"], load_hist(), owned=owned)
        except Exception as _e: note("app: discovery picks merge (cached recs)", _e)
    items = [enrich(i) for i in RECS["items"] if not owned.contains(i) and pick_source(i) not in PICK_OFF]
    return {**RECS, **({} if yt_on else {"state": "done", "error": ""}), "items": items,
            "owned_versions": len(owned.songs), "votes": {k: x["v"] for k, x in VOTES.items()},
            "sources": [s for s in PICK_SOURCES if s not in PICK_OFF], "digging": discover.STATE.get("state") == "working",
            "like": like_status()}


def meta_and_bpm(v, want_bpm):
    """One YouTube lookup gives both the popularity numbers (stored in META) and, if wanted, 30 s for the tempo."""
    if yt_cool(): return None
    try:
        url, headers, _ = resolve_stream(v) if (v not in META or not STREAMS.get(v)) else STREAMS[v]
        if want_bpm and v not in BPMS: return tempo.estimate(FFMPEG, url, headers=headers) or 0
    except Exception as ex: yt_trip(ex)
    return None

def stream_bpm(v):
    """Tempo of a YouTube video from 30 s of its audio stream. 0 = tried and failed (so we don't retry forever)."""
    try:
        url, headers, _ = resolve_stream(v)
        return tempo.estimate(FFMPEG, url, headers=headers) or 0
    except Exception: return None

def bpm_band(tst, hist):
    """Your BPM sweet spot: Rekordbox's middle 80%, else measured from the files you've downloaded here."""
    b = (tst or {}).get("bpm")
    if b and b.get("p10"): return (b["p10"], b["p90"])
    changed = False
    for e in hist:
        if "bpm" not in e and Path(e["file"]).exists():
            e["bpm"] = tempo.estimate(FFMPEG, e["file"]) or 0; changed = True
    if changed:
        with LOCK:
            cur = {x["id"]: x for x in load_hist()}
            for e in hist:
                if "bpm" in e and e["id"] in cur: cur[e["id"]]["bpm"] = e["bpm"]
            save_hist(list(cur.values()))
    v = sorted(e["bpm"] for e in hist if e.get("bpm"))
    return (v[len(v) // 10], v[len(v) * 9 // 10]) if len(v) >= 8 else None

def build_recs():
    """Recommend from YouTube's own Mix (radio) playlist for each recent download."""
    flat = {"quiet": True, "extract_flat": True, "skip_download": True, "playlistend": 40, "noplaylist": False}
    try:
        with LOCK: hist = load_hist()
        hist.sort(key=lambda e: -e["date"])
        seeds, changed = [], False
        with yt_dlp.YoutubeDL(flat) as y:
            for e in hist[:8]:
                v = vid_of(e["url"]) or e.get("seed_vid")
                if not v:  # older download with no URL saved: find the video by title
                    r = y.extract_info("ytsearch1:" + e["title"], download=False)
                    v = (r.get("entries") or [{}])[0].get("id"); e["seed_vid"] = v; changed = True
                if v: seeds.append((v, e["title"], 3.0, "downloaded"))
            if changed:
                with LOCK:
                    cur = {x["id"]: x for x in load_hist()}
                    for e in hist:
                        if e.get("seed_vid") and e["id"] in cur: cur[e["id"]]["seed_vid"] = e["seed_vid"]
                    save_hist(list(cur.values()))
            with LOCK: votes = dict(VOTES)
            ranked = sorted(votes.items(), key=lambda kv: -kv[1]["ts"])
            # likes and "Not for me" no longer pull in YouTube's radio for that song (a pop like dragged in pop radio);
            # they shape the taste profile below. Downloads still seed, but a seed whose picks keep missing gets muted.
            dl_titles = {e["title"] for e in hist}
            def seed_of(it):
                return it.get("seed") or (it.get("because") if it.get("because") in dl_titles else None)
            seed_pos, seed_neg = {}, {}
            for x in votes.values():
                sd = seed_of(x["item"])
                if sd: (seed_pos if x["v"] == 1 else seed_neg)[sd] = (seed_pos if x["v"] == 1 else seed_neg).get(sd, 0) + 1
            for d in DISMISSED.values():
                sd = seed_of(d)
                if sd: seed_neg[sd] = seed_neg.get(sd, 0) + .5
            for e in hist:
                if e.get("seed"): seed_pos[e["seed"]] = seed_pos.get(e["seed"], 0) + 2
            muted = {sd for sd in seed_neg if seed_neg[sd] >= 4 and not seed_pos.get(sd)}
            seed_w = {sd: max(.25, min(1.0, (seed_pos.get(sd, 0) + 1) / (seed_neg[sd] + 1))) for sd in seed_neg}
            seeds = [(v, t, w * seed_w.get(t, 1.0), k) for v, t, w, k in seeds if t not in muted]
            have = ({vid_of(e["url"]) for e in hist} | {e.get("seed_vid") for e in hist} | {sd[0] for sd in seeds}
                    | set(DISMISSED) | set(votes))
            dismissed_t = ({d["tk"] for d in DISMISSED.values()}
                           | {tkey(x["item"]["title"]) for x in votes.values() if x["v"] == -1})  # re-uploads stay gone
            score, neg, info = {}, {}, {}
            for v, title, w, kind in seeds:
                hit = MIXES.get(v)
                if hit and time.time() - hit[0] < 86400: entries = hit[1]
                else:
                    if yt_cool(): continue
                    try: mix = y.extract_info(f"https://www.youtube.com/watch?v={v}&list=RD{v}", download=False)
                    except Exception as ex: yt_trip(ex); continue
                    entries = [{k: c.get(k) for k in ("id", "title", "duration", "channel", "uploader", "channel_url", "uploader_url")}
                               for c in (mix.get("entries") or [])]
                    MIXES[v] = (time.time(), entries)
                for pos, c in enumerate(entries):
                    cid, dur = c.get("id"), c.get("duration") or 0
                    if not cid or cid in have or not (90 <= dur <= 900): continue
                    if tkey(c.get("title")) in dismissed_t or junk(c.get("title")) or excluded_pick(c): continue
                    if w < 0: neg[cid] = neg.get(cid, 0) - w; continue
                    score[cid] = score.get(cid, 0) + w + (40 - pos) / 40 * (w / 3)
                    info.setdefault(cid, {"id": cid, "title": c.get("title", ""), "url": f"https://www.youtube.com/watch?v={cid}",
                        "channel": c.get("channel") or c.get("uploader") or "", "channel_url": c.get("channel_url") or c.get("uploader_url") or "",
                        "because": title, "kind": kind, "src": kind, "seed": title, "duration": dur})
            # --- label / publisher awareness: read labels from your downloads' descriptions (cached in history) ---
            fetched, got = 0, False
            with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "noplaylist": True}) as full:
                for e in hist[:12]:
                    if e.get("label") is None and vid_of(e["url"]) and fetched < 4 and not yt_cool():
                        fetched += 1
                        try: e["label"] = extract_label(full.extract_info(e["url"], download=False).get("description")); got = True
                        except Exception as ex: yt_trip(ex)
            if got:
                with LOCK:
                    cur = {x["id"]: x for x in load_hist()}
                    for e in hist:
                        if e.get("label") is not None and e["id"] in cur: cur[e["id"]]["label"] = e["label"]
                    save_hist(list(cur.values()))
            pubs = {}  # key -> display; labels from descriptions first, then the channels you download from
            for _, x in [kv for kv in ranked if kv[1]["v"] == 1][:20]:   # labels / channels of tracks you liked
                ch = x["item"].get("channel") or ""
                if ch and not ch.endswith(" - Topic") and akey(ch) not in {akey(a) for a in credits(x["item"]["title"])}: pubs.setdefault(akey(ch), ch)
            for e in hist[:30]:
                if e.get("label"): pubs.setdefault(akey(e["label"]), e["label"])
            for e in hist[:30]:
                ch = e.get("channel") or ""
                if ch and ch != "Unknown channel" and not ch.endswith(" - Topic"): pubs.setdefault(akey(ch), ch)
            # --- artist awareness: also recommend more from the artists you download and like ---
            known = {}  # artist key -> display name, most recent first
            for t in [e["title"] for e in hist[:30]] + [x["item"]["title"] for _, x in ranked if x["v"] == 1]:
                for nm in credits(t): known.setdefault(akey(nm), nm)   # main artists, remixers/editors, featured names
            slim = ("id", "title", "duration", "channel", "uploader", "channel_url", "uploader_url", "view_count")
            rot = RECS.get("rot", 0)
            def rotate(lst, fixed, extra):  # the newest few every time, plus a rotating slice of the rest
                rest = lst[fixed:]
                if not rest: return lst[:fixed]
                o = (rot * extra) % len(rest)
                return lst[:fixed] + (rest[o:] + rest[:o])[:extra]
            try: tst = taste.scan_local() or taste.load()   # your Rekordbox: this Mac's library, or an uploaded XML
            except Exception: tst = taste.load()
            if tst and tst.get("source") == "off": tst = None
            rb = {akey(n): (n, w) for n, w in (tst or {}).get("artists", [])}
            rb_top = [(k, rb[k][0]) for k in list(rb)[:150] if k not in known]
            asks = [(k, nm, "artist", 2.5) for k, nm in rotate(list(known.items()), 2, 2)]
            asks += [(k, nm, "rekordbox", 2.5) for k, nm in rotate(rb_top, 0, 3)]
            sim, simw = {}, {}   # Last.fm: artists like the ones you play that you don't have yet
            for k, nm in rotate([kv for kv in list(known.items()) + rb_top[:60] if len(kv[0]) >= 4], 0, 5):
                for n, m in lastfm.similar(nm, 30):
                    sk = akey(n)
                    if m < .2 or sk in known or sk in rb or len(sk) < 3: continue
                    simw[sk] = simw.get(sk, 0) + m    # liked by several of your artists = stronger
                    sim.setdefault(sk, (n, nm))
            vibe = TASTE_TAGS | {g.lower() for g in (tst or {}).get("genres", [])}
            ok_sim = []
            for sk in sorted(simw, key=simw.get, reverse=True)[:10]:   # must actually sound like your music
                if vibe & set(lastfm.tags(sim[sk][0])): ok_sim.append(sk)
                if len(ok_sim) == 3: break
            asks += [(k, sim[k][0], "similar", 2.2) for k in ok_sim]
            sim_from = {k: src for k, (_, src) in sim.items()}
            for k, nm, src_kind, base_w in asks:
                hit = MIXES.get("a:" + k)
                if hit and time.time() - hit[0] < 86400: entries = hit[1]
                else:
                    if yt_cool(): continue
                    try: res = y.extract_info(f"ytsearch12:{nm}", download=False)
                    except Exception as ex: yt_trip(ex); continue
                    entries = [{f: c.get(f) for f in slim} for c in (res.get("entries") or [])]
                    MIXES["a:" + k] = (time.time(), entries)
                for pos, c in enumerate(entries):
                    cid, dur = c.get("id"), c.get("duration") or 0
                    if not cid or cid in have or not (90 <= dur <= 900) or tkey(c.get("title")) in dismissed_t or junk(c.get("title")) or excluded_pick(c): continue
                    if k not in {akey(a) for a in credits(c.get("title"))}: continue
                    score[cid] = score.get(cid, 0) + base_w + (12 - pos) / 12
                    info.setdefault(cid, {"id": cid, "title": c.get("title", ""), "url": f"https://www.youtube.com/watch?v={cid}",
                        "channel": c.get("channel") or c.get("uploader") or "", "channel_url": c.get("channel_url") or c.get("uploader_url") or "",
                        "because": sim_from.get(k, nm), "kind": "similar" if src_kind == "similar" else "artist", "src": src_kind, "seed": "a:" + nm, "duration": dur})
            for k, nm in rotate(list(pubs.items()), 1, 2):  # more from the labels / publishers you keep coming back to
                hit = MIXES.get("p:" + k)
                if hit and time.time() - hit[0] < 86400: entries = hit[1]
                else:
                    if yt_cool(): continue
                    try: res = y.extract_info(f"ytsearch12:{nm}", download=False)
                    except Exception as ex: yt_trip(ex); continue
                    entries = [{f: c.get(f) for f in slim} for c in (res.get("entries") or [])]
                    MIXES["p:" + k] = (time.time(), entries)
                for pos, c in enumerate(entries):
                    cid, dur = c.get("id"), c.get("duration") or 0
                    if not cid or cid in have or not (90 <= dur <= 900) or tkey(c.get("title")) in dismissed_t or junk(c.get("title")) or excluded_pick(c): continue
                    if k not in akey(c.get("channel") or c.get("uploader")) and k not in akey(c.get("title")): continue
                    score[cid] = score.get(cid, 0) + 2.0 + (12 - pos) / 12
                    info.setdefault(cid, {"id": cid, "title": c.get("title", ""), "url": f"https://www.youtube.com/watch?v={cid}",
                        "channel": c.get("channel") or c.get("uploader") or "", "channel_url": c.get("channel_url") or c.get("uploader_url") or "",
                        "because": nm, "kind": "label", "src": "label", "seed": "p:" + nm, "duration": dur})
            for cid, i in info.items():  # anything from a publisher you already use gets a small nudge
                if akey(i["channel"]) in pubs: score[cid] += 1.0
            for cid, i in info.items():  # a mix pick by an artist you know gets a nudge and an honest label
                ks = {akey(a) for a in credits(i["title"])}
                match = [known[k] for k in known if k in ks]
                if match and i["kind"] != "artist": score[cid] += 1.5; i["kind"] = "artist"; i["because"] = match[0]
                elif rb and i["kind"] != "artist":   # an artist from your Rekordbox crate: smaller nudge, label stays honest
                    hits = [rb[k] for k in ks if k in rb]
                    if hits: score[cid] += 0.8; i["crate"] = hits[0][0]
            owned = set((tst or {}).get("owned", []))   # never recommend a version you already own
            owned_full = owned_library()
            keys = {c: track_key(info[c]["title"], info[c]["channel"]) for c in score}
            gone = [c for c in score if keys[c] in owned or owned_full.contains(info[c])]
            for cid in gone: del score[cid]
            owned_stats = {"candidates": len(keys), "checkable": sum("|" in k for k in keys.values()), "removed": len(gone)}
        sw = source_weights(votes, dict(DISMISSED), hist)
        final = {c: score[c] * sw.get(info[c]["src"], 1.0) - neg.get(c, 0) for c in score}
        order = sorted(final, key=final.get, reverse=True)
        for key, hit in MIXES.items():   # searches hand us view counts for free; use them when nothing better is cached
            if key[:2] in ("a:", "p:"):
                for e in hit[1]:
                    if e.get("view_count") and e.get("id") in info and e["id"] not in META:
                        META[e["id"]] = {"views": e["view_count"], "followers": None, "up": None, "lite": True}
        # --- taste profile: genre tags, artists and channels from your likes / downloads / Rekordbox vs your "Not for me"s ---
        sigs = [{"artists": profile.item_artists(x["item"]["title"], x["item"].get("channel", "")), "channel": x["item"].get("channel", ""),
                 "weight": 1.0, "side": "yes" if x["v"] == 1 else "no", "ts": x["ts"]} for x in votes.values()]
        sigs += [{"artists": profile.item_artists(e["title"], e.get("channel", "")), "channel": e.get("channel", ""), "weight": 1.0,
                  "side": "yes", "ts": e["date"]} for e in hist]
        rbl = (tst or {}).get("artists", [])[:60]; rbt = sum(w for _, w in rbl) or 1
        n_yes = sum(1 for x in sigs if x["side"] == "yes")
        sigs += [{"artists": [n], "weight": 0.5 * n_yes * w / rbt, "side": "yes"} for n, w in rbl]   # Rekordbox: a quieter yes
        t0 = time.time()
        prof = profile.Profile(sigs)
        explore_ids = [c for c in order if info[c]["src"] in ("artist", "rekordbox", "similar", "label")][:20]
        for c in dict.fromkeys(order[:80] + explore_ids):
            lastfm.OFFLINE = time.time() - t0 > 25          # tag lookups get 25 s; after that only what's cached counts
            adj, fit = prof.score(info[c]["title"], info[c]["channel"])
            final[c] += adj
            if fit is not None: info[c]["fit"] = round(fit, 2)
        lastfm.OFFLINE = False; lastfm.save_tags()
        # Audio feedback supplements the existing artist/tag score when a fingerprint is already cached.
        preference = discover.preferences(hist, votes)
        for c in final: final[c] += .25 * preference.audio_adjustment(info[c])
        order = sorted(final, key=final.get, reverse=True)
        band = bpm_band(tst, hist)
        # --- popularity: fresh mega-hits (views piling up fast, giant channels) sink; steady classics and small labels don't ---
        explore_top = [c for c in order if info[c]["src"] in ("artist", "rekordbox", "similar", "label")][:12]
        need = [] if yt_cool() else [c for c in dict.fromkeys(order[:40] + explore_top) if c not in META or META[c].get("lite") or (band and c not in BPMS)][:16]
        if need:   # at most 16 new YouTube lookups per refresh, two at a time: stay well clear of rate limits
            pool = ThreadPoolExecutor(2); futs = {pool.submit(meta_and_bpm, c, bool(band)): c for c in need}
            done, _ = wait(futs, timeout=60); pool.shutdown(wait=False, cancel_futures=True)
            for f in done:
                if f.result() is not None: BPMS[futs[f]] = f.result()
            atomic_write(BPM_FILE, json.dumps(BPMS)); atomic_write(META_FILE, json.dumps(META))
        for c in final:
            pen = popularity.penalty(META.get(c))
            if pen: final[c] -= pen; info[c]["pop"] = round(pen, 2)
        order = sorted(final, key=final.get, reverse=True)
        if band:   # gently push down far-off BPMs (tempos read above, cached forever)
            for c in final:
                b = BPMS.get(c)
                if b: info[c]["bpm"] = b; final[c] -= min(2.5, tempo.near(b, *band) / 5)
            order = sorted(final, key=final.get, reverse=True)
        explore = [c for c in order if info[c]["src"] in ("artist", "rekordbox", "similar", "label") and final[c] > 0
                   and (info[c].get("fit") is None or info[c]["fit"] >= -0.15)]
        items = [info[c] for c in pick_diverse(order, info, out=pick_diverse(explore, info, n=6, per_seed=2))]   # up to 6 discovery slots
        try: MIX_FILE.write_text(json.dumps({k: list(v) for k, v in MIXES.items() if time.time() - v[0] < 86400}))
        except Exception: pass
        pool = {}
        for c in final: pool[info[c]["src"]] = pool.get(info[c]["src"], 0) + 1
        with LOCK:   # you may have voted, X'd or downloaded while this was building: respect that, not the snapshot
            gone_now = set(VOTES) | set(DISMISSED) | {vid_of(e["url"]) for e in load_hist()}
            items = [i for i in items if i["id"] not in gone_now]
        try:   # best-sounding finds from SoundCloud / Bandcamp / Discogs (discover.py, built in the background), a few slots
            items = discovery_items(items, hist)
        except Exception as _e: note("app: discovery picks merge (build)", _e)
        RECS.update(state="done", items=items, ts=time.time(), error="", rot=rot + 1, weights=sw, band=band, pool=pool, owned=owned_stats,
                    muted=sorted(muted), profile_tags=sorted(prof.tag.items(), key=lambda kv: kv[1])[:6] + sorted(prof.tag.items(), key=lambda kv: -kv[1])[:6],
                    asked=[f"{s}:{n}" for _, n, s, _ in asks])
    except Exception as ex:
        note("app: build picks", ex)   # str(ex) alone was just a file path; the log keeps the real reason
        RECS.update(state="error", error="Picks hit a snag and will retry shortly", err_ts=time.time())
    atomic_write(RECS_FILE, json.dumps(RECS))
    try: discover_bg(load_hist())   # find more for next time (background; never blocks Picks)
    except Exception as _e: note("app: background discovery start", _e)

PAGE_FILE = Path(__file__).parent / "page.html"

SPOTIFY_RE = re.compile(r"(?:open\.spotify\.com/(?:intl-[\w-]+/)?|spotify:)(track|album|playlist|episode|show|artist)[/:](\w+)")

def spotify_track(url):
    """Artist, title and length of a Spotify track, read from its public page (Spotify audio itself is DRM-locked)."""
    import html, urllib.request
    if "spotify.link" in url or "spoti.fi" in url:   # share short-links redirect to open.spotify.com
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=15) as r:
            url = r.geturl() + " " + r.read(400000).decode("utf-8", "ignore")
    m = SPOTIFY_RE.search(url)
    if not m: raise Exception("That doesn't look like a Spotify track link")
    if m.group(1) != "track": raise Exception("Only single Spotify tracks for now, not albums or playlists")
    req = urllib.request.Request(f"https://open.spotify.com/track/{m.group(2)}", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r: page = r.read().decode("utf-8", "ignore")
    meta = lambda k: [html.unescape(v) for v in re.findall(r'<meta (?:name|property)="' + k + r'" content="([^"]*)"', page)]
    title = (meta("og:title") or [""])[0]
    artists = meta("music:musician_description") or [(meta("og:description") or [""])[0].split(" · ")[0]]
    dur = (meta("music:duration") or ["0"])[0]
    if not title or not artists[0]: raise Exception("Couldn't read that Spotify track")
    return {"title": title, "artist": ", ".join(artists), "duration": int(dur) if dur.isdigit() else 0}

def youtube_match(sp):
    """Best YouTube upload of a Spotify track: right length, title words present, official audio preferred."""
    core = lambda t: re.sub(r"[^\w ]", " ", t.lower()).split()
    want = core(re.split(r" - | \(", sp["title"])[0]); first = core(sp["artist"].split(",")[0])
    extra = {w for w in ("remix", "live", "edit", "extended", "mix", "acoustic", "instrumental") if w in core(sp["title"])}
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True}) as y:
        res = y.extract_info(f"ytsearch8:{sp['artist'].split(',')[0]} - {sp['title']}", download=False)
    best, top = None, 1e9
    for i, e in enumerate(x for x in (res.get("entries") or []) if x and x.get("id")):
        t, ch = e.get("title") or "", e.get("channel") or e.get("uploader") or ""
        words = set(core(t + " " + ch)); d = e.get("duration")
        s = i * 2 + (min(abs(d - sp["duration"]), 90) if d and sp["duration"] else 30)
        s += 40 * (not all(w in words for w in want)) + 15 * ("".join(first) not in re.sub(r"\W", "", (t + ch).lower()))
        s += 25 * len({"remix", "live", "edit", "extended", "acoustic", "instrumental"} & words - extra)
        s += 50 * junk(t) - 12 * ch.endswith(" - Topic") + 8 * ("video" in words) - 8 * ("audio" in words)
        if s < top: best, top = e, s
    if not best: raise Exception("Couldn't find that Spotify track on YouTube")
    return f"https://www.youtube.com/watch?v={best['id']}"

def already_have(url):
    """The library track that was downloaded from this exact YouTube video, else None (a deleted file does not count)."""
    v = vid_of(url)
    if not v: return None
    for e in load_all():
        f = e.get("file")
        if f and vid_of(e.get("url")) == v and (os.path.exists(f) or _on_unplugged_drive(f)): return e
    return None

def run(job_id, url, fmt):
    job = JOBS[job_id]
    to_usb()
    try: OUT = out_dir()
    except LibraryOffline as ex: job.update(status="error", error=str(ex)); return
    pick = next((i for i in RECS["items"] if i["id"] == vid_of(url) or i.get("url") == url), None)
    src = pick and (pick.get("src") or pick.get("kind")); seed = pick and pick.get("seed")
    def hook(d):
        if d["status"] == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if tot: job["pct"] = int(d["downloaded_bytes"] * 100 / tot)
        elif d["status"] == "finished":
            job["status"], job["pct"] = "converting", 100
    opts = {
        "format": "bestaudio/best", "noplaylist": True, "quiet": True,
        "ffmpeg_location": FFMPEG, "progress_hooks": [hook],
        "outtmpl": str(OUT / f"{job_id}-%(title)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": fmt,
                            **({"preferredquality": "320"} if fmt == "mp3" else {})},
                           {"key": "FFmpegMetadata"}],
        **({"postprocessor_args": {"extractaudio": ["-ar", "48000", "-acodec", "pcm_s16le"]}} if fmt == "wav" else {}),
    }
    try:
        sp = None
        if "spotify" in url or "spoti.fi" in url:   # find the same track on YouTube, keep Spotify's clean artist/title
            job["status"] = "finding"; sp = spotify_track(url); url = youtube_match(sp); job["status"] = "downloading"
        with yt_dlp.YoutubeDL(opts) as y:
            info = y.extract_info(url, download=True)
        f = next(OUT.glob(f"{job_id}-*.{fmt}"))
        if sp: shown, artist, track = f"{sp['artist']} - {sp['title']}", sp["artist"], sp["title"]
        else: shown, artist, track = display_name(info.get("title", "audio"), info.get("channel") or "", info.get("uploader") or "")
        f = retag(f, job_id, shown, artist, track, fmt)
        title = re.sub(r"[<>&\"]", "", shown)
        with LOCK:
            h = load_hist()
            h.append({"id": job_id, "title": title, "ext": fmt, "file": posix(f), "url": info.get("webpage_url", url),
                      "channel": info.get("channel") or info.get("uploader") or "Unknown channel",
                      "channel_url": info.get("channel_url") or info.get("uploader_url") or "", "date": time.time(),
                      "duration": info.get("duration") or file_duration(str(f)),
                      "label": extract_label(info.get("description")), **({"src": src} if src else {}), **({"seed": seed} if seed else {})})
            save_hist(h)
            rid = info.get("id")  # a track you now own stops being a recommendation
            if any(i["id"] == rid for i in RECS["items"]):
                RECS["items"] = [i for i in RECS["items"] if i["id"] != rid]; atomic_write(RECS_FILE, json.dumps(RECS))
        job.update(status="done", file=posix(f), ext=fmt, title=title)  # only after the file is in the library
        soundindex.start(load_hist()); warm_waves()   # fingerprint it for Find similar / styles; make its waveform
    except Exception as e:
        job.update(status="error", error=re.sub(r"\x1b\[[0-9;]*m", "", str(e))[:200])

def upgrade(job_id, old, url):
    """Low-bitrate fix: download a better copy (MP3 320), put it in every crate/set that held the old file, then move the old
    file to the drive's trash folder (logged; Undo on the Clean up page brings the file back)."""
    run(job_id, url, "mp3"); job = JOBS[job_id]
    if job.get("status") != "done": return
    try:
        d_new, d_old = file_duration(job.get("file") or ""), file_duration(old)
        if d_new is None: raise RuntimeError("The new file could not be read, so nothing was replaced. Your old file is untouched.")
        if d_old and abs(d_new - d_old) > 3:   # a different length means a different edit/mix or a cut: keep both, swap nothing
            mm = lambda x: f"{x // 60}:{x % 60:02d}"
            job.update(status="error", error=f"That version is {mm(d_new)} but yours is {mm(d_old)}, so it is a different edit. Both are kept; nothing was replaced.")
            return
        rec = {"new": job_id, "old": old}
        job["replaced"] = crates.swap_file(load_all(), old, job_id, rec)   # run() files the download under the job id
        t = libindex.trash([old]); job["trashed"] = t.get("moved", 0)
        if t.get("batch") and t.get("moved"): libindex.annotate(t["batch"], swap=rec)   # Undo on the Clean-up page puts the crates back too
    except Exception as e: job.update(status="error", error=str(e)[:200])
    job["upgraded"] = True

def follow_renames():
    """Anything still pointing at a file by the name it had before Clean up renamed it is reconnected to the new name (relocate.auto)."""
    try: import relocate; return relocate.auto(load_all())
    except Exception as ex: note("app: follow renames", ex); return {"moved": 0}

def fix_and_remap(paths):
    """Clean-up renames/tags, then point the history entries of renamed files at their new path (and record that on the batch for Undo)."""
    r = libindex.apply_fixes(paths)
    if r.get("moves"):
        libindex.annotate(r["batch"], hist_moves=r["moves"]); libremove.remap_history(r["moves"], load_hist, save_hist)   # on record first: a crash between the two still undoes cleanly
        follow_renames()
    return r

DEV_PAGES = {"art-test.html", "decks-test.html", "matchtest.html"}   # internal test screens: served to this computer only

class H(BaseHTTPRequestHandler):
    def _local(self):
        return str(self.client_address[0]) in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
    def send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        path, _, q = self.path.partition("?"); qs = dict(p.split("=", 1) for p in q.split("&") if "=" in p)
        if path in ("/", "/set", "/crates", "/clean") and self.headers.get("Sec-Fetch-Dest") == "document" and "bare" not in qs:
            # a top-level visit gets the shell: it keeps one player playing while the pages change inside its frame (static/player.js)
            return self.send(200, (Path(__file__).parent / "shell.html").read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store", "Vary": "Sec-Fetch-Dest"})
        # --- set builder: local files only, never YouTube ---
        if path == "/set": return self.send(200, (Path(__file__).parent / "set.html").read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if path == "/set/wave":   # waveform + sections for a deck's scrubber, from the local file
            e = next((x for x in load_all() if x["id"] == qs.get("id")), None)
            if not e or not Path(e["file"]).exists(): return self.send(404, "{}")
            try:
                if qs.get("hi"):
                    t = next((t for t in setbuild.tracks(load_all()) if t["id"] == e["id"]), None)
                    return self.send(200, json.dumps(setbuild.wave_hi(e, bpm=t and ((t["grid"] or {}).get("grid_bpm") or t["bpm"]))), extra={"Cache-Control": "max-age=86400"})
                w = setbuild.wave(e)
                if qs.get("mini"):   # row-sized: 200 columns (max of each 4), 2 decimals; ~2.5 KB
                    k = max(1, len(w["peaks"]) // 200)
                    sq = lambda a: [round(max(a[i:i + k]), 2) for i in range(0, len(a), k)]
                    w = {"duration": w["duration"], "peaks": sq(w["peaks"]), "bass": sq(w["bass"])}
                return self.send(200, json.dumps(w), extra={"Cache-Control": "max-age=86400"})
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:120]}))
        if path == "/clean": return self.send(200, (Path(__file__).parent / "clean.html").read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if path.startswith("/art/") and path.endswith(".jpg"):   # cached cover (300px JPEG named by content hash, so it never changes: cache for good)
            f = artwork.path_for(path[5:-4])
            if not f: return self.send(404, "{}")
            return self.send(200, f.read_bytes(), "image/jpeg", {"Cache-Control": "public, max-age=31536000, immutable"})
        if path == "/art/status": return self.send(200, json.dumps(artwork.status(load_all())))
        if path == "/lib/status": return self.send(200, json.dumps({"job": libindex.JOB, "log": libindex.history(), "roots": libindex.roots()}))
        if path == "/lib/missing": import relocate; return self.send(200, json.dumps(relocate.summary(load_all())))
        if path == "/lib/health": return self.send(200, json.dumps(libindex.health()))
        if path == "/lib/fixes": return self.send(200, json.dumps(libindex.propose_fixes()))
        if path == "/lib/artists": return self.send(200, json.dumps(artistlookup.suggestions()))
        if path == "/energy": return self.send(200, (Path(__file__).parent / "static/energy.html").read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if path == "/energy/status": return self.send(200, json.dumps(energy.summary()))
        if path == "/energy/queue": return self.send(200, json.dumps(energy.queue(setbuild.tracks(load_all()), mids=qs.get("mids") == "1", retag=qs.get("retag") == "1")))
        if path == "/crates": return self.send(200, (Path(__file__).parent / "crates.html").read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if path == "/cdj/info":
            ok = cdjexport.available()
            if ok: cdjexport.warm(load_all())   # opening the export dialog starts the background listening
            return self.send(200, json.dumps({"available": ok, "sticks": cdjexport.sticks() if ok else []}))
        if path == "/dev/refresh": return self.send(200, json.dumps({k: libindex.JOB.get(k) for k in ("state", "done", "total")}))
        if path == "/dev/list": return self.send(200, json.dumps({"volumes": cdjexport.devices() if cdjexport.available() else [], "places": cdjexport.places(), "library": {"path": str(library_setting.configured() or out_dir()), "chosen": bool(library_setting.configured()), "offline": bool(library_setting.configured() and not library_setting.get())}}))
        if path == "/dev/playlist-match": return self.send(200, json.dumps(cdjexport.playlist_match(load_all(), unquote(qs.get("stick", "")), unquote(qs.get("name", "")))))
        if path == "/dev/playlists": return self.send(200, json.dumps(cdjexport.playlists(__import__("urllib.parse").parse.unquote(qs.get("path", "")))))
        if path == "/dev/ls": return self.send(200, json.dumps(cdjexport.listdir(__import__("urllib.parse").parse.unquote(qs.get("path", "")))))
        if path == "/cdj/preview":
            g = lambda k: (qs.get(k) or [""])[0] if isinstance(qs.get(k), list) else qs.get(k, "")
            return self.send(200, json.dumps(cdjexport.preview(load_all(), [x for x in g("crates").split(",") if x], unquote(g("volume")))))   # the dialog sends encodeURIComponent(name): "NO NAME" arrived as NO%20NAME and matched no stick
        if path == "/cdj/active": return self.send(200, json.dumps({"job": cdjexport.active()}))
        if path == "/cdj/job":
            j = cdjexport.status(qs.get("id", [""])[0] if isinstance(qs.get("id"), list) else qs.get("id", ""))
            return self.send(200 if j else 404, json.dumps(j or {"error": "unknown job"}))
        if path == "/crates/data": return self.send(200, json.dumps(crates.listing(load_all())))
        if path == "/rb/playlists":   # Rekordbox playlists you can turn into crates (read-only copy of master.db)
            try: return self.send(200, json.dumps(rblink.playlists()))
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
        if path == "/crates/library": return self.send(200, json.dumps(crates.library_rows(load_hist())))
        if path == "/smart/data": return self.send(200, json.dumps(smartcrates.listing()))
        if path == "/lib/bpm/info":   # right-click > Check BPM: every reading we have for one track (cached ones + a fresh quick check)
            t = next((t for t in setbuild.tracks(load_all()) if t["id"] == qs.get("id")), None)
            if not t: return self.send(404, json.dumps({"error": "Track not found."}))
            import bpmedit
            quick = tempo.estimate(FFMPEG, t["file"]) if t.get("here") and qs.get("quick") else None
            import rtbpm; fast = rtbpm.estimate(FFMPEG, t["file"]) if t.get("here") and qs.get("quick") else None
            return self.send(200, json.dumps({"id": t["id"], "bpm": t["bpm"], "manual": bool(t.get("bpm_manual")), "was": (bpmedit._all().get(t["id"]) or {}).get("was"),
                "readings": [{"name": "Waxfinder", "bpm": t.get("bpm_ana")}, {"name": "Rekordbox", "bpm": t.get("bpm_rb")}, {"name": "Quick check", "bpm": quick}, {"name": "Fast check", "bpm": fast}], "flag": t.get("bpm_flag")}))
        if path == "/lib/styles/scan": import soundstyles; return self.send(200, json.dumps({**soundstyles.JOB, "saved": len(soundstyles._all())}))
        if path == "/lib/keys/scan": import rbxkeys; return self.send(200, json.dumps({**rbxkeys.JOB, "saved": len(rbxkeys._all())}))
        if path == "/lib/bpm/scan": import bpmsecond; return self.send(200, json.dumps(bpmsecond.JOB))
        if path == "/library/rows": return self.send(200, json.dumps(crates.library_all(load_all())))   # Library table on /crates: every track
        if path == "/set/library":
            h = load_all(); lib = setbuild.library(h); ts = setbuild.tracks(h)   # linked Rekordbox tracks join once analysed
            by = {x["id"]: x for x in h}
            for t in ts:   # no Rekordbox grid: start from the kick position found in the bass (cached after the first time)
                if not t["grid"] and t["id"] in by:
                    t["grid"] = None; t["kick"] = setbuild.hi_kick(by[t["id"]])   # never computed here: warm_hi() fills these in the background
            warm_hi(ts, by); setbuild.save_kicks()
            deck = [{"id": t["id"], "artist": t["artist"], "title": t["title"], "key": t["cam"], "energy": t["energy"],
                     "bpm": (t["grid"] or {}).get("grid_bpm") or t["bpm"], "first_beat": (t["grid"] or {}).get("first_beat", t.get("kick") or 0.0),
                     "grid": "rekordbox" if t["grid"] else "estimated", "beat_len": (t["grid"] or {}).get("beat_len"), "level_db": t.get("level_db"), "url": "/play?id=" + t["id"],
                     "dur": t["dur"], "key_sure": t["ksrc"] == "rekordbox" or t["kconf"] >= .9, "feel": t.get("feel"), "mix_in": t.get("mix_in"), "mix_out": t.get("mix_out")} for t in ts]
            return self.send(200, json.dumps({"songs": len(lib), "analysed": len(ts), "job": setbuild.JOB,
                "music_s": sum(t["play"] for t in ts), "bpms": sorted(t["bpm"] for t in ts), "tracks": deck}))
        if path == "/": return self.send(200, PAGE_FILE.read_text(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        if path.startswith("/static/") and path[8:] in DEV_PAGES and not self._local():   # test pages: this computer only, never over Wi-Fi
            return self.send(404, "{}")
        if path.startswith("/static/"):
            root = (Path(__file__).parent / "static").resolve(); f = (root / path[8:]).resolve()
            if root not in f.parents or not f.is_file(): return self.send(404, "{}")
            ctype = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
                     ".png": "image/png", ".woff2": "font/woff2", ".html": "text/html; charset=utf-8"}.get(f.suffix, "application/octet-stream")
            return self.send(200, f.read_bytes(), ctype, {"Cache-Control": "no-store"})
        if path == "/stream":
            v = qs.get("v", "")
            if not re.fullmatch(r"[\w-]{11}", v): return self.send(400, "{}")
            for attempt in (0, 1):
                try:
                    url, hdrs, _ = resolve_stream(v, fresh=bool(attempt))
                    h = dict(hdrs)
                    if self.headers.get("Range"): h["Range"] = self.headers["Range"]
                    up = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=20)
                    break
                except urllib.error.HTTPError as e:
                    if attempt == 0 and e.code in (403, 410): continue
                    return self.send(502, "{}")
                except Exception:
                    return self.send(502, "{}")
            self.send_response(up.status)
            for k in ("Content-Type", "Content-Length", "Content-Range"):
                if up.headers.get(k): self.send_header(k, up.headers[k])
            self.send_header("Accept-Ranges", "bytes"); self.end_headers()
            try:
                while chunk := up.read(65536): self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError): pass
            finally: up.close()
            return
        if path == "/recs": return self.send(200, json.dumps(recs_payload()))
        if path == "/saved":   # saved Picks; once downloaded or marked owned they drop off on their own
            try:
                owned = owned_library()
                return self.send(200, json.dumps({"items": [i for i in saved.items() if not owned.contains(i)]}))
            except ValueError as exc:
                return self.send(500, json.dumps({"error": str(exc)}))
        if path == "/taste":
            return self.send(200, json.dumps({**taste.status(), "lastfm": bool(lastfm.api_key())}))
        if path == "/votes":
            rows = [{"id": k, "v": x["v"], "ts": x["ts"], "duration": x["item"].get("duration"), "artist": enrich(x["item"])["artist"], **{f: x["item"].get(f, "") for f in ("title", "url", "channel", "channel_url", "src", "src_url")}}
                    for k, x in VOTES.items()]
            return self.send(200, json.dumps(sorted(rows, key=lambda r: -r["ts"])))
        if path == "/history":
            groups = {}
            for e in sorted(load_hist(), key=lambda e: -e["date"]):
                g = groups.setdefault(e["channel"], {"channel": e["channel"], "channel_url": e["channel_url"], "tracks": []})
                g["tracks"].append({**{k: e[k] for k in ("id", "title", "ext", "url")}, "duration": e.get("duration"), "date": e.get("date"), "here": Path(e["file"]).exists()})
            return self.send(200, json.dumps(list(groups.values())))
        if path == "/similar":   # tracks that sound like ?id=, best first, % on this library's scale
            if not soundindex.available(): return self.send(200, json.dumps({"available": False}))
            h = load_hist(); items = soundindex.similar(h, qs.get("id", ""))
            return self.send(200, json.dumps({"available": True, "ready": items is not None, "items": items or [], "job": soundindex.JOB}))
        if path == "/recs/wave":   # waveform for a pick row (whole stream pulled once, cached)
            v = qs.get("v", "")
            if not re.fullmatch(r"[\w-]{11}", v): return self.send(400, "{}")
            w = pick_wave_request(v)   # cached -> data; otherwise queued for the background worker
            return self.send(200, json.dumps(w), extra={"Cache-Control": "max-age=86400"}) if w else self.send(202, json.dumps({"pending": True}))
        if path == "/library/pending":   # Crates page "Analyse" button: what's still to do, and progress if running
            h = load_hist(); lib = setbuild.library(h)
            lib_all = setbuild.library(load_all())   # linked Rekordbox tracks need analysis + fingerprints too (energy model uses them); not waveforms
            genre_todo = genres.pending(lib_all)
            need = {"analysis": sum(1 for e in lib_all if setbuild.needs_analysis(e)),
                    "sound": sum(1 for e in lib_all if soundindex.available() and soundindex.cached(e) is None and setbuild.nfc(e["file"]) not in soundindex._FAILED),
                    "waves": sum(1 for e in lib if not setbuild.wave_cached(e)), "genres": len(genre_todo)}
            need["artists"], review = artistlookup.counts()
            busy = setbuild.JOB.get("state") == "working" or soundindex.JOB.get("state") == "working" or _WARM["busy"] or genres.JOB.get("state") == "working" or artistlookup.JOB.get("state") == "running"
            return self.send(200, json.dumps({"review": review, "tracks": len({e["id"] for e in genre_todo} | {e["id"] for e in lib_all if setbuild.needs_analysis(e)} | {e["id"] for e in lib if not setbuild.wave_cached(e)
                                                             or (soundindex.available() and soundindex.cached(e) is None)}),
                                              "need": need, "busy": busy,
                                              "jobs": {"analysis": setbuild.JOB, "sound": soundindex.JOB, "genres": dict(genres.JOB), "artists": artistlookup.JOB, "waves": {k: _WARM[k] for k in ("busy", "done", "total")}}}))
        if path == "/library/genres":
            lib = setbuild.library(load_all())
            pending = len(genres.pending(lib)); tagged = sum(bool(genres.styles(e)) for e in lib)
            return self.send(200, json.dumps({"job": dict(genres.JOB), "total": len(lib),
                "tagged": tagged, "pending": pending, "not_found": len(lib) - tagged - pending,
                "mode": "listings_only", "cleanup": GENRE_CLEANUP, "discogs": discogs_api.status(),
                "sources": {s: sum(genres.source(e) == s for e in lib) for s in genres.SOURCES}}))
        if path in ("/dstream", "/dwave"):   # SoundCloud/Bandcamp picks: a cached MP3 preview (and its waveform)
            c = discover.get(unquote(qs.get("id", "")))
            if not c: return self.send(404, "{}")
            try: f = discover.preview_file(c)
            except Exception: f = None
            if not f: return self.send(503, "{}")
            if path == "/dwave":
                w = setbuild.wave({"id": re.sub(r"[^\w]", "_", c["id"]), "file": str(f)})
                k = max(1, len(w["peaks"]) // 200); sq = lambda a: [round(max(a[i:i + k]), 2) for i in range(0, len(a), k)]
                return self.send(200, json.dumps({"duration": w["duration"], "peaks": sq(w["peaks"]), "bass": sq(w["bass"])}), extra={"Cache-Control": "max-age=86400"})
            size = f.stat().st_size; start, end = 0, size - 1
            m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
            if m:
                a0, b0 = m.groups()
                if a0: start = int(a0); end = min(int(b0), size - 1) if b0 else end
                elif b0: start = max(0, size - int(b0))
                if start > end: return self.send(416, "{}", extra={"Content-Range": f"bytes */{size}"})
            self.send_response(206 if m else 200); self.send_header("Content-Type", "audio/mpeg"); self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if m: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with open(f, "rb") as fh:
                    fh.seek(start); left = end - start + 1
                    while left > 0 and (chunk := fh.read(min(65536, left))): self.wfile.write(chunk); left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError): pass
            return
        if path == "/discover/like": return self.send(200, json.dumps(like_status()))
        if path == "/discover/status": return self.send(200, json.dumps({**discover.STATE, "catalogue": len(discover.DB["cands"])}))
        if path == "/sound/status": return self.send(200, json.dumps({"available": soundindex.available(), "job": soundindex.JOB}))
        if path == "/import/status":   # analysis progress for imported tracks
            ids = set((qs.get("ids") or "").split(",")) - {""}
            idle = setbuild.JOB.get("state") != "working"; ready, failed = [], {}
            for e in load_hist():
                if e["id"] not in ids: continue
                if setbuild.cached(e) is not None: ready.append(e["id"])
                elif nfc(e["file"]) in setbuild.FAILED or idle: failed[e["id"]] = setbuild.FAILED.get(nfc(e["file"]), "it did not finish")   # analysis stopped without a result
            return self.send(200, json.dumps({"job": setbuild.JOB, "ready": ready, "failed": failed}))
        if path == "/dest":   # where the next added track will be saved (shown in the + panel)
            lib = library_setting.configured()
            try: d, off = out_dir(), False
            except LibraryOffline: d, off = lib, True
            kind = "chosen" if lib else "stick" if str(d).startswith(str(USB)) else "laptop"
            return self.send(200, json.dumps({"path": str(d), "kind": kind, "offline": off}))
        if path == "/play":  # inline, range-capable, so the page can preview and seek library files
            e = next((e for e in load_all() if e["id"] == qs.get("id")), None)
            if not e or not Path(e["file"]).exists(): return self.send(404, "{}")
            f = Path(e["file"]); ctype = mime(e["ext"])
            if e["ext"].lower() in ("aif", "aiff"):
                try: f, ctype = play_copy(e), "audio/wav"
                except Exception: return self.send(500, "{}")
            size = f.stat().st_size; start, end = 0, size - 1
            m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
            if m:
                a0, b0 = m.groups()
                if a0: start = int(a0); end = min(int(b0), size - 1) if b0 else end
                elif b0: start = max(0, size - int(b0))
                if start > end: return self.send(416, "{}", extra={"Content-Range": f"bytes */{size}"})
            self.send_response(206 if m else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Length", str(end - start + 1))
            if m: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with open(f, "rb") as fh:
                    fh.seek(start); left = end - start + 1
                    while left > 0 and (chunk := fh.read(min(65536, left))):
                        self.wfile.write(chunk); left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError): pass
            return
        if path == "/file":
            e = next((e for e in load_hist() if e["id"] == qs.get("id")), None)
            if not e or not Path(e["file"]).exists(): return self.send(404, "{}")
            f = Path(e["file"]); name = re.sub(r"^[0-9a-f]{8}-", "", f.name)   # older files carry an id prefix
            return self.send(200, f.read_bytes(), mime(e["ext"]),
                             {"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name)})
        job = JOBS.get(qs.get("id", ""))
        if path == "/status" and job: return self.send(200, json.dumps(job))
        if path == "/status":   # jobs live in memory: after a restart the page would wait forever, so tell it plainly
            return self.send(200, json.dumps({"status": "error", "pct": 0, "error": "Waxfinder restarted before this finished. Check your library, then add it again if it isn't there."}))
        self.send(404, "{}")
    def _same_site(self):
        """Writes only from this app's own pages: a web page on another site (or a DNS-rebinding hostname) must not drive the library.
        Host must be localhost, an IP address, a .local name or this machine's name; an Origin header, when sent, must match Host."""
        import socket, ipaddress
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        try: ipaddress.ip_address(host); ok = True
        except ValueError: ok = host in ("localhost", socket.gethostname().lower(), socket.gethostname().split(".")[0].lower()) or host.endswith(".local")
        o = self.headers.get("Origin")
        if ok and o and o != "null":
            from urllib.parse import urlparse
            ok = (urlparse(o).netloc or "").lower() == (self.headers.get("Host") or "").lower()
        elif ok and o == "null": ok = False
        return ok

    def do_POST(self):
        if not self._same_site(): return self.send(403, json.dumps({"error": "Blocked: this request did not come from the Waxfinder page."}))
        setbuild.forget_stats()   # anything posted may add, move or retag files: re-check the stick from here on
        if self.path == "/import":   # raw file body (no multipart), name in X-Filename; streamed straight onto the stick
            name = unquote(self.headers.get("X-Filename") or "")
            n = int(self.headers.get("Content-Length") or 0)
            ext = Path(name).suffix[1:].lower()
            if ext not in AUDIO_EXT or not n:
                if n: self.rfile.read(n)
                return self.send(415, json.dumps({"status": "skipped", "error": "Not an audio file"}))
            if n > IMPORT_MAX:
                left = n
                while left > 0 and (c := self.rfile.read(min(1 << 20, left))): left -= len(c)
                return self.send(413, json.dumps({"status": "error", "error": "Over 1 GB"}))
            to_usb()
            try: tmp = out_dir() / f".importing-{uuid.uuid4().hex[:8]}.{ext}"
            except LibraryOffline as ex: return self.send(200, json.dumps({"status": "error", "error": str(ex)}))
            try:
                with open(tmp, "wb") as fh:
                    left = n
                    while left > 0 and (c := self.rfile.read(min(1 << 20, left))): fh.write(c); left -= len(c)
                if left: raise OSError("upload cut short")
                return self.send(200, json.dumps(import_file(tmp, name)))
            except Exception as ex:
                tmp.unlink(missing_ok=True)
                return self.send(500, json.dumps({"status": "error", "error": str(ex)[:160]}))
        if self.path == "/dev/import":   # a file picked in the Files browser -> the library, same route as an upload (copied, tagged, named)
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            src = cdjexport._inside(body.get("path") or ""); ext = src.suffix[1:].lower() if src else ""
            if not src or not src.is_file() or ext not in AUDIO_EXT: return self.send(200, json.dumps({"status": "skipped", "error": "Not an audio file"}))
            if src.stat().st_size > IMPORT_MAX: return self.send(200, json.dumps({"status": "error", "error": "Over 1 GB"}))
            to_usb()
            try: tmp = out_dir() / f".importing-{uuid.uuid4().hex[:8]}.{ext}"
            except LibraryOffline as ex: return self.send(200, json.dumps({"status": "error", "error": str(ex)}))
            try:
                shutil.copyfile(src, tmp)
                res = import_file(tmp, src.name); libindex.scan()   # new file is part of the library index at once
                return self.send(200, json.dumps(res))
            except Exception as ex:
                tmp.unlink(missing_ok=True); return self.send(200, json.dumps({"status": "error", "error": str(ex)[:160]}))
        if self.path.startswith("/dev/") and self.command == "POST" and self.path != "/dev/import":   # Files browser actions
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            P = self.path
            try:
                if P == "/dev/pick":   # the system's own folder picker (Finder / Explorer): works for any location, any drive name
                    p = cdjexport.pick_folder(body.get("prompt") or "Choose a folder")
                    if not p: return self.send(200, json.dumps({"cancelled": True}))
                    cdjexport.allow(p)
                    if body.get("as_library"): library_setting.set_dir(p)
                    return self.send(200, json.dumps({"path": p, "library": bool(body.get("as_library"))}))
                if P == "/dev/refresh": libindex.scan(); return self.send(200, json.dumps({"state": "working"}))
                if P == "/dev/library":
                    real = cdjexport._inside(body.get("path") or "")
                    if not real or not real.is_dir(): return self.send(200, json.dumps({"error": "That folder can't be used"}))
                    if body.get("sub"): real = real / re.sub(r"[^\w .-]", "", body["sub"]); real.mkdir(exist_ok=True)
                    library_setting.set_dir(real); return self.send(200, json.dumps({"ok": True, "path": str(real)}))
                if P in ("/dev/reveal", "/dev/eject"):
                    return self.send(200, json.dumps((cdjexport.reveal if P == "/dev/reveal" else cdjexport.eject)(body.get("path") or "")))
            except Exception as ex: return self.send(200, json.dumps({"error": str(ex)[:160]}))
            return self.send(404, "{}")
        if self.path == "/library/analyse":   # analyse everything outstanding, or ONE section: body {"only": "analysis|sound|waves|genres|artists"}
            h = load_hist(); all_h = load_all()
            try: only = (json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}") or {}).get("only")
            except Exception: only = None
            if only == "art": artwork.start(all_h)
            elif only == "artists": artistlookup.run()
            elif only == "genres": genres.start(all_h)
            elif only == "analysis": setbuild.start_analysis(all_h); energy.start(all_h)
            elif only == "sound": soundindex.start(all_h)
            elif only == "waves": warm_waves()
            else: genres.start(all_h); setbuild.start_analysis(all_h); soundindex.start(all_h); energy.start(all_h); warm_waves(); artwork.start(all_h)
            return self.send(200, "{}")
        if self.path == "/art/pause": return self.send(200, json.dumps(artwork.pause()))      # stop the album-art scan (touches the stick); survives restarts
        if self.path == "/art/resume": return self.send(200, json.dumps(artwork.resume_scan(load_all())))
        if self.path == "/art/set":   # set ONE track's cover from a Discogs release link or an image link: {id, url}
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            e = next((x for x in load_all() if x["id"] == body.get("id")), None)
            if not e: return self.send(404, json.dumps({"error": "unknown track"}))
            try: return self.send(200, json.dumps({"ok": True, "art": artwork.set_from_url(e, body.get("url"))}))
            except Exception as ex: return self.send(400, json.dumps({"error": str(ex)[:160]}))
        if self.path == "/library/genres":
            return self.send(200, json.dumps(genres.start(load_all())))
        if self.path == "/sound/all": return self.send(200, json.dumps(soundindex.start(load_all())))   # fingerprint linked Rekordbox tracks too
        if self.path in ("/energy/tag", "/energy/train", "/energy/analyse"):   # Mixed In Key style energy: tags -> model
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path == "/energy/analyse": energy.start(load_all()); return self.send(200, json.dumps(energy.summary()))
            ts = setbuild.tracks(load_all())
            if self.path == "/energy/train": return self.send(200, json.dumps(energy.train(ts)))
            t = next((t for t in ts if t["id"] == body.get("id")), None)
            if not t: return self.send(404, "{}")
            energy.tag(t["id"], body.get("v"), t); return self.send(200, json.dumps(energy.summary()))
        if self.path == "/matchtest/vote" and not self._local(): return self.send(404, "{}")
        if self.path == "/matchtest/vote":   # blind sound-model listening test (static/matchtest.html) -> ~/Tools/SoundMatch/out/votes.json
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            vf = Path.home() / "Tools/SoundMatch/out/votes.json"
            with LOCK:
                try: vs = json.loads(vf.read_text())
                except Exception: vs = {}
                vs[f"{body.get('ref')}|{body.get('col')}|{body.get('id')}"] = body.get("v", 0)
                if vf.parent.exists(): vf.write_text(json.dumps(vs, indent=1))
            return self.send(200, "{}")
        if self.path in ("/recs/owned", "/recs/owned/undo"):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 16384:
                    return self.send(400, json.dumps({"error": "Choose a valid Pick"}))
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Choose a valid Pick")
                if self.path.endswith("/undo"):
                    return self.send(200, json.dumps({"ok": True, "removed": manualowned.undo(body.get("key"))}))
                key = manualowned.mark(body.get("item"))
                return self.send(200, json.dumps({"ok": True, "key": key}))
            except ValueError as exc:
                return self.send(400, json.dumps({"error": str(exc)}))
            except OSError:
                return self.send(500, json.dumps({"error": "Could not save your already-owned mark"}))
        if self.path in ("/recs/save", "/recs/unsave"):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 16384:
                    return self.send(400, json.dumps({"error": "Choose a valid Pick"}))
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Choose a valid Pick")
                if self.path.endswith("/unsave"):
                    return self.send(200, json.dumps({"ok": True, "removed": saved.remove(body.get("id"))}))
                return self.send(200, json.dumps({"ok": True, "id": saved.add(body.get("item"))}))
            except ValueError as exc:
                return self.send(400, json.dumps({"error": str(exc)}))
            except OSError:
                return self.send(500, json.dumps({"error": "Could not save that track"}))
        if self.path == "/recs/vote":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            vid, v = body.get("id", ""), body.get("v", 0)
            if v not in (-1, 0, 1): return self.send(400, "{}")
            with LOCK:
                cur = VOTES.get(vid)
                item = next((i for i in RECS["items"] if i["id"] == vid), None) or (cur and cur["item"])
                if v == 0:
                    if cur:
                        del VOTES[vid]
                        if cur["v"] == -1 and not any(i["id"] == vid for i in RECS["items"]): RECS["items"].insert(0, cur["item"])
                elif item:
                    VOTES[vid] = {"v": v, "ts": time.time(), "item": item}
                    if v == -1: RECS["items"] = [i for i in RECS["items"] if i["id"] != vid]
                atomic_write(VOTES_FILE, json.dumps(VOTES, indent=1)); atomic_write(RECS_FILE, json.dumps(RECS))
            return self.send(200, json.dumps({"ok": True}))
        if self.path in ("/recs/dismiss", "/recs/restore"):
            vid = json.loads(self.rfile.read(int(self.headers["Content-Length"]))).get("id", "")
            with LOCK:
                if self.path.endswith("dismiss"):
                    item = next((i for i in RECS["items"] if i["id"] == vid), None)
                    if item:
                        DISMISSED[vid] = {**item, "tk": tkey(item["title"])}
                        RECS["items"] = [i for i in RECS["items"] if i["id"] != vid]
                else:
                    item = DISMISSED.pop(vid, None)
                    if item: RECS["items"].insert(0, {k: v for k, v in item.items() if k != "tk"})
                atomic_write(DISM_FILE, json.dumps(DISMISSED, indent=1)); atomic_write(RECS_FILE, json.dumps(RECS))
            return self.send(200, json.dumps({"ok": True}))
        if self.path.startswith("/taste/"):
            n = int(self.headers.get("Content-Length") or 0)
            if self.path == "/taste/xml":   # a Rekordbox XML export; only a summary is kept
                if not 0 < n <= 150 * 2**20: return self.send(413, json.dumps({"error": "File too big (150 MB max)"}))
                import io
                try: taste.from_xml(io.BytesIO(self.rfile.read(n)))
                except Exception as ex: return self.send(400, json.dumps({"error": "Couldn't read that file: " + str(ex)[:120]}))
            else:
                if n: self.rfile.read(n)
                if self.path == "/taste/scan":
                    try:
                        if not taste.scan_local(force=True): return self.send(404, json.dumps({"error": "No Rekordbox library on this computer"}))
                    except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
                elif self.path == "/taste/off": taste.clear()
                else: return self.send(404, "{}")
            return self.send(200, json.dumps(taste.status()))
        if self.path.startswith("/lib/"):   # library clean-up: scan, move to trash, fix names/tags, undo (all logged)
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            try:
                if self.path == "/lib/remove":   # {ids, mode: forget|trash}: library tracks out of Waxfinder (and optionally off the drive, into its trash folder)
                    r = libremove.remove(load_all(), body.get("ids") or [], body.get("mode")); return self.send(400 if r.get("error") else 200, json.dumps(r))
                if self.path == "/lib/remove/undo": return self.send(200, json.dumps(libremove.undo(body.get("batch"), body.get("paths"), body.get("memb"), load_hist, save_hist)))
                if self.path == "/lib/scan": return self.send(200, json.dumps(libindex.scan()))
                if self.path == "/lib/relocate/find":   # {pick: true} asks for a folder first; otherwise the library's own folders are searched. Read-only.
                    import relocate; folder = None
                    if body.get("pick"):
                        folder = cdjexport.pick_folder("Where is your music now?")
                        if not folder: return self.send(200, json.dumps({"cancelled": True}))
                    return self.send(200, json.dumps(relocate.find(load_all(), folder)))
                if self.path == "/lib/relocate/apply": import relocate; return self.send(200, json.dumps(relocate.reconnect(body.get("olds") or [])))
                if self.path == "/lib/trash": return self.send(200, json.dumps(libindex.trash(body.get("paths") or [])))
                if self.path == "/lib/artists/run": artistlookup.run(); return self.send(200, json.dumps({"ok": True}))
                if self.path == "/lib/rename": r = trackedit.rename(load_all(), body.get("id"), body.get("artist"), body.get("title"), body.get("was")); return self.send(400 if r.get("error") else 200, json.dumps(r))
                if self.path == "/lib/bpm/override":
                    import bpmedit; t = next((t for t in setbuild.tracks(load_all()) if t["id"] == body.get("id")), None)
                    r = bpmedit.set_(body.get("id"), body.get("bpm"), was=t and t.get("bpm")) if t else {"error": "Track not found."}; return self.send(400 if r.get("error") else 200, json.dumps(r))
                if self.path == "/lib/bpm/reset": import bpmedit; r = bpmedit.reset(body.get("id")); return self.send(400 if r.get("error") else 200, json.dumps(r))
                if self.path == "/lib/rename/reset": r = trackedit.reset(load_all(), body.get("id")); return self.send(400 if r.get("error") else 200, json.dumps(r))
                if self.path == "/lib/artists/apply": return self.send(200, json.dumps(artistlookup.apply(body.get("items") or [])))
                if self.path == "/lib/ids":   # Clean up previews: the player/waveform id for each file path
                    ids = {setbuild.nfc(e["file"]): e["id"] for e in load_all()}
                    return self.send(200, json.dumps({p: ids.get(setbuild.nfc(p)) for p in (body.get("paths") or [])}))
                if self.path == "/lib/fix": return self.send(200, json.dumps(fix_and_remap(body.get("paths") or [])))
                if self.path == "/lib/upgrade":   # {path, url}: better copy in, crates point at it, old file to trash; poll /status?id=
                    url, old = body.get("url") or "", body.get("path") or ""
                    if not url.startswith(("http://", "https://")) or not os.path.isfile(old): return self.send(400, json.dumps({"error": "bad link or file"}))
                    jid = uuid.uuid4().hex[:8]; JOBS[jid] = {"status": "downloading", "pct": 0}
                    threading.Thread(target=upgrade, args=(jid, old, url), daemon=True).start()
                    return self.send(200, json.dumps({"id": jid}))
                if self.path == "/lib/undo": return self.send(200, json.dumps(libremove.undo(body.get("batch") or "", None, None, load_hist, save_hist)))
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
            return self.send(404, "{}")
        if self.path == "/rb/import":   # ticked Rekordbox playlists -> crates; files stay where they are
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            try: return self.send(200, json.dumps(rblink.import_playlists(body.get("ids"), load_hist())))
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
        if self.path == "/import/retry":   # a track whose analysis failed: try again
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            e = next((x for x in load_hist() if x["id"] == body.get("id")), None)
            if not e: return self.send(404, json.dumps({"error": "unknown track"}))
            setbuild.FAILED.pop(nfc(e["file"]), None); setbuild.start_analysis(load_hist()); return self.send(200, json.dumps({"ok": True}))
        if self.path in ("/smart/save", "/smart/delete"):   # smart crates = saved Library filters (no tracks stored)
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            try:
                if self.path == "/smart/save": return self.send(200, json.dumps(smartcrates.save(body.get("name"), body.get("f"))))
                return self.send(200, json.dumps({"ok": smartcrates.delete(body.get("id"))}))
            except ValueError as ex: return self.send(400, json.dumps({"error": str(ex)}))
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
        if self.path == "/crates/import_m3u":   # a .m3u/.m3u8 file -> a NEW crate in the same order; nothing else is touched (Undo = delete that crate)
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            try:
                import m3uimport
                ent = m3uimport.parse(body.get("text") or ""); ids, miss = m3uimport.match(ent, load_all(), setbuild.exists)
                if not ids: return self.send(200, json.dumps({"error": "None of the tracks in that file are in your Library", "total": len(ent), "missing": miss[:50]}))
                c = crates.crate_new(load_all(), body.get("name") or "Imported playlist", ids)
                return self.send(200, json.dumps({"id": c["id"], "name": c["name"], "total": len(ent), "matched": len(ids), "missing": miss[:50]}))
            except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
        if self.path.startswith("/crates/") or self.path.startswith("/sets/"):
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            h = load_all(); P = self.path
            if P == "/crates/new": return self.send(200, json.dumps(crates.crate_new(h, body.get("name"), [body["id"]] if body.get("id") else body.get("ids") or [])))
            if P == "/crates/edit":
                ok = crates.crate_edit(h, body.get("crate"), add=body.get("add"), remove=body.get("remove"), name=body.get("name"), colour=body.get("colour"), delete=bool(body.get("delete")))
                return self.send(200 if ok else 404, json.dumps({"ok": bool(ok)}))
            if P == "/crates/move":
                r = crates.crate_move(h, body.get("from"), body.get("to"), body.get("ids") or [], copy=bool(body.get("copy")))
                return self.send(200 if r is not None else 404, json.dumps(r or {"moved": []}))
            if P == "/crates/cdj/cancel": return self.send(200, json.dumps(cdjexport.cancel(body.get("id") or "")))
            if P == "/crates/cdj":   # picked crates -> a CDJ-ready stick (export.pdb + ANLZ), no Rekordbox; background job, poll /cdj/job
                r = cdjexport.start(h, body.get("crates") or [], body.get("volume") or "", rebuild=bool(body.get("rebuild")))
                return self.send(400 if r.get("error") else 200, json.dumps(r))
            if P == "/crates/export":   # crate -> Rekordbox XML + M3U8 on the stick (or the laptop if it's out)
                try: return self.send(200, json.dumps(crates.export_crate(h, body.get("crate"), out_dir())))
                except ValueError as ex: return self.send(400, json.dumps({"error": str(ex)}))
                except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
            if P == "/crates/reorder":   # drag to reorder the tracks inside one crate
                r = crates.crate_reorder(h, body.get("crate"), body.get("ids") or [])
                return self.send(200 if r is not None else 404, json.dumps({"ok": r is not None, "ids": r or []}))
            if P == "/crates/order": return self.send(200, json.dumps({"ids": crates.crate_order(body.get("ids") or [])}))
            if P == "/sets/save": return self.send(200, json.dumps(crates.set_save(h, body.get("name"), body.get("slot"), body.get("ids") or [], body.get("params"), body.get("replace"))))
            if P == "/sets/delete": return self.send(200, json.dumps({"ok": crates.set_delete(body.get("id"))}))
            if P == "/sets/rename":
                r = crates.set_rename(body.get("id"), body.get("name"))
                return self.send(200 if r else 404, json.dumps(r or {"error": "Set not found"}))
            if P == "/sets/open":
                r = crates.set_open(h, body.get("id"))
                return self.send(200 if r else 404, json.dumps(r or {"error": "Set not found"}))
            return self.send(404, "{}")
        if self.path.startswith("/set/"):
            n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            h = load_all()
            if self.path == "/set/analyse": return self.send(200, json.dumps(setbuild.start_analysis(h)))
            if self.path == "/set/build":
                p = {k: body.get(k) for k in ("hours", "slot", "shape", "bpm_start", "bpm_end", "bpm_mode", "keys", "must", "exclude", "seed", "start") if body.get(k) is not None}
                cids = body.get("crates") or ([body["crate"]] if body.get("crate") else [])
                if cids:   # build only from the picked crates' tracks (resolved to the copies on the stick)
                    only = []
                    for c in crates._load()["crates"]:
                        if c["id"] in cids: only += [e["id"] for _, e in crates._resolve(h, c["ids"], c.get("snap", {})) if e]
                    p["only"] = list(dict.fromkeys(only))
                return self.send(200, json.dumps(setbuild.build(h, **p)))
            if self.path == "/set/describe":   # a saved set after removing a track: same order, no reshuffle
                ts = {t["id"]: t for t in setbuild.tracks(h)}
                return self.send(200, json.dumps(setbuild.describe([ts[i] for i in body.get("ids") or [] if i in ts])))
            if self.path == "/set/export":
                try: f = setbuild.export(h, body.get("ids") or [], body.get("name") or "Waxfinder set", out_dir())
                except Exception as ex: return self.send(500, json.dumps({"error": str(ex)[:160]}))
                xml = None
                try: xml = crates.export_ids(h, body.get("ids") or [], {}, body.get("name") or "Waxfinder set", out_dir())["xml"]   # same set as a Rekordbox XML playlist
                except Exception as _e: note("app: set XML export", _e)
                return self.send(200, json.dumps({"file": f, "xml": xml, "usb": f.startswith("/Volumes/")}))
            return self.send(404, "{}")
        if self.path == "/lastfm":
            k = json.loads(self.rfile.read(int(self.headers["Content-Length"]))).get("key", "").strip()
            if k and not lastfm.check(k): return self.send(400, json.dumps({"error": "Last.fm didn't accept that key"}))
            lastfm.set_key(k); return self.send(200, json.dumps({"on": bool(k)}))
        if self.path in ("/discover/like", "/discover/like/clear"):   # Find similar: one track (library id or a pasted link) -> Picks
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or "{}")
            if self.path.endswith("/clear"):
                discover.like_clear(); return self.send(200, json.dumps(like_status()))
            h = load_all(); src = disc_sources()   # every library track (downloads, Rekordbox links, USB scan) can be the target
            if not src: return self.send(400, json.dumps({"error": "Switch on at least one of SoundCloud, Bandcamp, Discogs or Traxsource in Sources"}))
            try:
                if body.get("id"):
                    e = next((x for x in setbuild.library(h) if x["id"] == body["id"]), None)
                    fp = e and soundindex.cached(e)
                    if not fp: return self.send(400, json.dumps({"error": "That track hasn't been listened to yet. Run Analyse first"}))
                    t = next((x for x in setbuild.tracks(h) if x["id"] == e["id"]), {}) 
                    artist, title = t.get("artist") or "", t.get("title") or ""
                    if not artist: _, artist, title = display_name(e.get("title") or "", e.get("channel") or "")
                    state = discover.like_start(load_hist(), {"artist": artist, "title": title, "lib_id": e["id"], "v": fp["v"]}, src)   # scoring keeps the usual library scale
                else:
                    url = str(body.get("url") or "").strip()
                    if not re.match(r"https?://|spotify:", url): return self.send(400, json.dumps({"error": "Paste a track link first"}))
                    state = discover.like_start(load_hist(), {"resolve": like_resolver(url), "page": url}, src)
            except ValueError as exc: return self.send(400, json.dumps({"error": str(exc)}))
            return self.send(200, json.dumps({**like_status(), **{k: state[k] for k in ("queue",)}}))
        if self.path == "/discover/refresh":
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or "{}")
            try: state = discover.start(load_hist(), source_names=body.get("sources"))
            except ValueError as exc: return self.send(400, json.dumps({"error": str(exc)}))
            return self.send(200, json.dumps(state))
        if self.path == "/recs/refresh":
            if "youtube" in PICK_OFF:   # YouTube resting: dig the other sources instead of rebuilding the YouTube picks
                try: discover_bg(load_hist())
                except Exception as _e: note("app: background discovery (YouTube off)", _e)
                return self.send(200, json.dumps(recs_payload(build=False)))
            if RECS["state"] != "working":
                RECS["state"] = "working"; threading.Thread(target=build_recs, daemon=True).start()
            return self.send(200, json.dumps(RECS))
        if self.path == "/recs/sources":
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or "{}")
            off = body.get("off")
            if not isinstance(off, list) or any(s not in PICK_SOURCES for s in off): return self.send(400, json.dumps({"error": "Unknown source"}))
            off = set(off)
            if "youtube" in off and not disc_sources(off): return self.send(400, json.dumps({"error": "Keep at least one source on"}))
            tmp = PICK_SRC_FILE.with_suffix(".json.tmp"); tmp.write_text(json.dumps({"off": sorted(off)})); safe_replace(tmp, PICK_SRC_FILE)
            PICK_OFF.clear(); PICK_OFF.update(off)
            return self.send(200, json.dumps(recs_payload()))
        if self.path != "/start": return self.send(404, "{}")
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        url, fmt = body.get("url", ""), "mp3"   # always MP3 320: WAV from YouTube is lossy anyway and 10x the size
        if not url.startswith(("http://", "https://")): return self.send(400, "{}")
        jid = uuid.uuid4().hex[:8]
        have = None if body.get("again") else already_have(url)
        if have:   # same video already downloaded: say so instead of a second copy (the page shows this as a normal failed line)
            JOBS[jid] = {"status": "error", "pct": 0, "duplicate": have["id"], "error": "Already in your library: " + (have.get("title") or "this track")}
            return self.send(200, json.dumps({"id": jid}))
        JOBS[jid] = {"status": "downloading", "pct": 0}
        threading.Thread(target=run, args=(jid, url, fmt), daemon=True).start()
        self.send(200, json.dumps({"id": jid}))
    def log_message(self, *a): pass
    def handle_one_request(self):
        try: super().handle_one_request()
        except (ConnectionError, TimeoutError): self.close_connection = True   # the browser dropped a stream (seek, skip, next track): not an error

if __name__ == "__main__":
    print("http://127.0.0.1:8765")
    if FROZEN:
        import socket, webbrowser
        def _app_window():
            """The installed build shows Waxfinder in its own window (Edge WebView2, part of Windows 11), not a browser tab.
            Returns False if the window can't be made, so the caller falls back to the browser."""
            try:
                import webview
                webview.settings["ALLOW_DOWNLOADS"] = True   # crate exports (XML / M3U8) save like in a browser
                webview.create_window("Waxfinder", "http://127.0.0.1:8765", width=1440, height=900, min_size=(960, 600))
                store = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Waxfinder" / "webview"
                webview.start(private_mode=False, storage_path=str(store))   # keep the page's saved settings between runs
                return True
            except Exception as ex:
                import paths; paths.note("app window", ex); return False
        with socket.socket() as _s:
            _s.settimeout(1)
            if _s.connect_ex(("127.0.0.1", 8765)) == 0:   # already running: just open it again
                if not _app_window(): webbrowser.open("http://127.0.0.1:8765")
                sys.exit(0)
    # Run before any background writers. Only inferred genre fields are removed;
    # exact backups retain the original data, vectors and voting history.
    GENRE_CLEANUP = {
        "library": stylecleanup.purge(soundindex.FILE, soundindex.CACHE, soundindex.CACHE.values(), inferred=True),
        "discovery": stylecleanup.purge(discover.FILE, discover.DB, discover.DB.get("cands", {}).values(), inferred=True),
        "picks": stylecleanup.purge(RECS_FILE, RECS, RECS.get("items", [])),
        "votes": stylecleanup.purge(VOTES_FILE, VOTES, [v.get("item", {}) for v in VOTES.values()]),
        "genres": stylecleanup.purge(genres.FILE, genres.DB, genres.DB["tracks"].values()),
    }
    setbuild.HIST_LOADER = load_hist
    threading.Thread(target=follow_renames, daemon=True).start()
    soundindex.HIST_LOADER = load_hist; soundindex.start(load_hist())   # fingerprint anything new in the background
    genres.HIST_LOADER = load_all
    genres.resume(load_all())
    artwork.HIST_LOADER = load_all
    artwork.resume(load_all())   # embedded covers first, then Deezer / iTunes for the rest (background, resumable)
    warm_waves()
    import soundstyles; threading.Thread(target=lambda: soundstyles.scan([e for e in load_all() if not genres.styles(e)]), daemon=True).start()   # sound-based genre ESTIMATES for tracks with no listing genre (background, resumable)
    import rbxkeys; threading.Thread(target=lambda: rbxkeys.scan(setbuild.tracks(load_all()), {t['id'] for t in setbuild.tracks(load_all()) if t['ksrc'] == 'rekordbox'}), daemon=True).start()   # rbxport keys for tracks Rekordbox doesn't know (background, resumable)
    import bpmsecond; threading.Thread(target=lambda: bpmsecond.scan(setbuild.tracks(load_all()), FFMPEG), daemon=True).start()   # second-opinion BPMs, background, resumable
    discover.YT_RESOLVE = resolve_stream; discover.YT_COOL = yt_cool
    discover.OWNED_LOADER = owned_library
    if time.time() - discover.DB.get("ts", 0) > 6 * 3600: discover_bg(load_hist())
    ThreadingHTTPServer.request_queue_size = 128   # default backlog is 5: a burst of page requests got connections refused ("Failed to fetch")
    SERVER = ThreadingHTTPServer(("127.0.0.1" if FROZEN else "0.0.0.0", 8765), H)   # installed build: this PC only (no firewall prompt)
    if FROZEN:
        threading.Thread(target=SERVER.serve_forever, daemon=True).start()
        if _app_window(): os._exit(0)   # window closed: quit (the background scans are daemon threads)
        webbrowser.open("http://127.0.0.1:8765")   # no window possible: the old way, browser tab
        threading.Event().wait()                   # the server thread above keeps serving
    SERVER.serve_forever()
