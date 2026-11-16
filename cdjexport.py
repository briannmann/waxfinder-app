"""Crates -> a CDJ-ready Pioneer USB stick (export.pdb + exportLibrary.db + ANLZ analysis), without Rekordbox.

Engine: ~/Tools/rbx-cli (Waxfinder-patched build of github.com/lorenzobersano/rbx-cli, GPL-2.0, rbxport crates). Mac only;
`available()` is False where the binary is missing (the Windows PC), and the UI falls back to the Rekordbox XML export.
Each export STAGES the picked crates as a folder of symlinks (one sub-folder = one playlist) and runs `rbx-cli export --add`,
so earlier crates already on the stick stay. Tracks already on the destination stick are kept in place (not copied again);
tracks elsewhere are copied under Contents/. Beat grid, BPM, key and waveforms come from rbx-cli's own analysis (cached in rbx_cache/).
The export only ever adds. Replacing a stick's library is a separate, explicit rebuild (the old one is set aside and put back on failure)."""
import json, os, plistlib, re, shutil, subprocess, sys, tempfile, threading, time, unicodedata, uuid
from pathlib import Path
import crates, setbuild

HERE = Path(__file__).parent
import enginebin
BIN = enginebin.rbx_cli()
CACHE = HERE / "rbx_cache"
JOBS = {}
LOCK = threading.Lock()
LISTEN = threading.Lock()   # one export at a time runs the (cache-writing) listening step
WARM = {"thread": None, "at": 0}   # background pre-analysis (rbx-cli warm); an export waits for it so two writers never share the cache

def _ram_gb():
    try: return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout) / 2 ** 30
    except Exception: return 8
def _threads(background):
    """Analysis threads for the engine: ~0.5 GB RAM each. A foreground export may use most of the machine; the background
    listening stays gentle (a few threads) so the laptop stays usable."""
    cores, gb = os.cpu_count() or 2, _ram_gb()
    return max(1, min(cores // 2, int(gb // 4), 3)) if background else max(1, min(cores, int(gb // 2), 8))
def _env(background): return {**os.environ, "RBX_THREADS": str(_threads(background))}

def available(): return sys.platform == "darwin" and BIN.is_file()

def _root(vol):
    for n in ("PIONEER", ".PIONEER"):
        if (vol / n).is_dir(): return vol / n
    return None

def sticks():
    """Mounted external volumes the export could go to. The system disk and read-only/internal volumes are left out."""
    out = []
    try: names = sorted(os.listdir("/Volumes"))
    except OSError: return out
    for n in names:
        p = Path("/Volumes") / n
        if n.startswith(".") or p.is_symlink() or not os.path.ismount(p) or n in ("Recovery", "Macintosh HD"): continue
        try:
            info = plistlib.loads(subprocess.run(["diskutil", "info", "-plist", str(p)], capture_output=True, timeout=10).stdout)
        except Exception: info = {}
        if info.get("Internal") and not info.get("Ejectable") and not info.get("RemovableMedia") : continue
        if info.get("WritableVolume") is False or not os.access(p, os.W_OK): continue
        fs = {"msdos": "FAT32", "exfat": "exFAT", "hfs": "HFS+", "apfs": "APFS", "ntfs": "NTFS"}.get(info.get("FilesystemType"), info.get("FilesystemType") or "?")
        du = shutil.disk_usage(p); root = _root(p)
        out.append({"name": n, "path": str(p), "fs": fs, "free": du.free, "total": du.total,
                    "pioneer": bool(root), "ours": bool(root and (root / "rbxport" / "manifest.json").is_file()),
                    "rekordbox": bool(root and (root / "rekordbox" / "export.pdb").is_file())})
    return out

def _track_id(path):
    """The engine's id for a file (rbx-cli main.rs track_id): FNV-1a of the real, NFC path, 53 bits. Same file -> same id on every export."""
    import unicodedata
    h = 0xcbf29ce484222325
    for b in unicodedata.normalize("NFC", os.path.realpath(path)).encode():
        h = ((h ^ b) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return (h & ((1 << 53) - 1)) or 1

def _on_stick(dest):
    """Engine ids of every track our earlier exports put on the stick (from our manifest there)."""
    root = _root(dest)
    try: return {t.get("library_id") for t in json.loads((root / "rbxport" / "manifest.json").read_text())["tracks"]}
    except Exception: return set()

def _stick_names(dest):
    """Names of the playlists already on the stick (from our manifest there)."""
    try: return [p["name"] for p in json.loads((_root(dest) / "rbxport" / "manifest.json").read_text())["playlists"] if not p.get("folder")]
    except Exception: return []

NAMES = HERE / "cdj_names.json"   # {stick name: {playlist name (lower): crate id}} - which crate wrote each playlist, so a different crate with the same name never overwrites it
def _owners(stick):
    try: return json.loads(NAMES.read_text()).get(stick, {})
    except Exception: return {}

def _remember_names(stick, pairs):
    try: d = json.loads(NAMES.read_text())
    except Exception: d = {}
    d.setdefault(stick, {}).update({n.lower(): i for n, i in pairs})
    tmp = NAMES.with_suffix(".tmp"); tmp.write_text(json.dumps(d, ensure_ascii=False)); tmp.replace(NAMES)

ORDERS = HERE / "cdj_orders.json"   # {stick name: {playlist name (lower): [track paths in the order we last wrote them]}} - lets the next export say what changed

def _orders(stick):
    try: return json.loads(ORDERS.read_text()).get(stick, {})
    except Exception: return {}

def _changes(stick, plan, rebuilt=False):
    """Per playlist, what this export changed compared with the last one Waxfinder wrote to this stick: new tracks, tracks no longer in the crate,
    and whether the tracks that stayed were reordered. Also stores the new orders. Compared with OUR last export (the stick is not read)."""
    old = {} if rebuilt else _orders(stick); out = []; new_all = dict(old)
    for nm, files in plan:
        if not files: continue
        fs = [os.path.realpath(f) for f in files]; prev = old.get(nm.lower())
        if prev is None: out.append({"name": nm, "first": True, "count": len(fs)})
        else:
            ps, ns = set(prev), set(fs)
            out.append({"name": nm, "first": False, "count": len(fs), "added": len(ns - ps), "removed": len(ps - ns), "moved": [f for f in fs if f in ps] != [f for f in prev if f in ns]})
        new_all[nm.lower()] = fs
    try:
        d = json.loads(ORDERS.read_text()) if ORDERS.exists() else {}
        d[stick] = new_all; tmp = ORDERS.with_suffix(".tmp"); tmp.write_text(json.dumps(d, ensure_ascii=False)); tmp.replace(ORDERS)
    except Exception: pass
    return out

def exported_checker():
    """-> f(path) -> True when this track is on a stick we exported to: in our remembered playlist orders (any stick) or in the manifest of a stick plugged in now."""
    import unicodedata
    n = lambda x: unicodedata.normalize("NFC", x)
    seen = set()
    try:
        for pl in json.loads(ORDERS.read_text()).values():
            for files in pl.values(): seen.update(n(f) for f in files)
    except Exception: pass
    ids = set()
    try:
        for st in sticks(): ids |= {i for i in _on_stick(Path(st["path"])) if i}
    except Exception: pass
    def check(path):
        if not path: return False
        if n(os.path.realpath(path)) in seen: return True
        return bool(ids) and _track_id(path) in ids
    return check

def preview(hist, crate_ids, volume):
    """How many of the picked crates' tracks are new to the stick (so a re-export is quick): {"new": n, "already": n, "copy_mb": n}."""
    stick = next((s for s in sticks() if s["name"] == volume), None)
    if not stick: return {"new": 0, "already": 0, "copy_mb": 0}
    dest = Path(stick["path"]); have = _on_stick(dest); cs = {c["id"]: c for c in crates._load()["crates"]}
    idx = crates._index(hist); seen = set(); new = already = copy = 0
    for i in dict.fromkeys(crate_ids or ()):
        c = cs.get(i)
        if not c: continue
        for tid, e in crates._resolve(hist, c["ids"], c.get("snap", {}), idx):
            f = e and e.get("file")
            if not (f and setbuild.exists(f)) or f in seen: continue
            seen.add(f)
            try: sz = os.path.getsize(f)
            except OSError: continue
            if _track_id(f) in have: already += 1
            else:
                new += 1
                if not Path(f).resolve().is_relative_to(dest.resolve()): copy += sz
    return {"new": new, "already": already, "copy_mb": round(copy / 2 ** 20)}

def _foreign_rows(stick):
    """Rows on the stick that Waxfinder did not write (an old Rekordbox library). The engine cannot merge them with a crate that holds
    the same files, so such a stick gets a fresh Waxfinder library (the old one is set aside, not deleted). None = nothing to set aside."""
    if not stick["rekordbox"]: return None
    if not stick["ours"]: return -1   # written by Rekordbox, count unknown
    try:
        g = json.loads((_root(Path(stick["path"])) / "rbxport" / "manifest.json").read_text()).get("generation") or {}
        n = sum(1 for t in (g.get("device_sources") or {}).values() if (t.get("device") or {}).get("preserve"))
        return n or None
    except Exception: return -1

def _safe(name, fallback="Crate"):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", name or "")).strip(" .")[:80] or fallback

def start(hist, crate_ids, volume, confirm_foreign=False, rebuild=False):
    """Begin a background export. Returns {"id": job} or {"error": ...}.
    The export only ever ADDS to the stick's library. rebuild=True is the separate, explicit "replace the stick's library" operation:
    the old one is set aside (never deleted) and put back if the rebuild fails."""
    if not available(): return {"error": "The CDJ export tool isn't installed on this computer"}
    stick = next((s for s in sticks() if s["name"] == volume), None)
    if not stick: return {"error": "That stick isn't plugged in any more"}
    dest = Path(stick["path"])
    with LOCK:
        if any(j["state"] == "running" and j["stick"] == stick["name"] for j in JOBS.values()): return {"error": f"{stick['name']} already has an export running"}
    cs = {c["id"]: c for c in crates._load()["crates"]}
    picked = [cs[i] for i in dict.fromkeys(crate_ids or ()) if i in cs]
    if not picked: return {"error": "Pick at least one crate"}
    idx = crates._index(hist); plan, missing, need = [], 0, 0; names = set(); left_out = []; plan_ids = []
    have = _on_stick(dest); on_stick = {n.lower() for n in _stick_names(dest)}; owner = _owners(stick["name"])
    for c in picked:
        files, seen = [], set()
        for tid, e in crates._resolve(hist, c["ids"], c.get("snap", {}), idx):
            f = e and e.get("file")
            if not (f and setbuild.exists(f)):
                missing += 1; sn = c.get("snap", {}).get(tid) or {}
                title = " – ".join(x for x in (sn.get("artist"), sn.get("title")) if x) or (Path(f).stem if f else "Unknown track")
                left_out.append({"title": title, "crate": c["name"], "why": "not in the library any more" if not e else
                                 "its file can't be reached (stick or drive not plugged in, or the file was moved or deleted)"})
                continue
            if f in seen: continue
            seen.add(f); files.append(f)
            if _track_id(f) not in have and not Path(f).resolve().is_relative_to(dest.resolve()):   # already copied by an earlier export = no new room needed
                try: need += os.path.getsize(f)
                except OSError: pass
        nm = _safe(c["name"]); k = 2
        # A playlist of the same name written by a DIFFERENT crate is never overwritten: this one gets "(2)". (Same crate again = updated in place.)
        while nm.lower() in names or (nm.lower() in on_stick and owner.get(nm.lower(), c["id"]) != c["id"]): nm = f"{_safe(c['name'])} ({k})"; k += 1
        names.add(nm.lower()); plan.append((nm, files)); plan_ids.append((nm, c["id"]))
    if not any(f for _, f in plan): return {"error": "None of these crates' tracks are reachable right now (is the music stick plugged in?)"}
    if need + 300 * 2 ** 20 > stick["free"]:
        return {"error": f"Not enough room on {stick['name']}: needs about {need // 2**20 + 300} MB, has {stick['free'] // 2**20} MB free"}
    job = {"id": uuid.uuid4().hex[:8], "state": "running", "stage": "starting", "done": 0, "total": sum(len(f) for _, f in plan),
           "stick": stick["name"], "crates": [n for n, f in plan if f], "missing": missing, "crate_ids": [c["id"] for c in picked], "volume": stick["name"], "left_out": left_out[:500], "pct": 1, "started": time.time(), "report": None, "error": None, "log": [], "plan_ids": plan_ids}
    with LOCK: JOBS[job["id"]] = job
    _save(job)
    threading.Thread(target=_run, args=(job, plan, dest, stick, bool(rebuild)), daemon=True).start()
    return {"id": job["id"]}

def _backup(dest, root):
    """A foreign (Rekordbox-written) stick: keep a copy of its PIONEER folder before the first write."""
    b = dest / f"_Waxfinder backup {time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copytree(root, b / root.name)
    return b

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".aif", ".aiff", ".m4a"}
def _stick_audio(dest):
    """Every audio file on the stick (outside the library database folders), so an export can report what it NEWLY copied."""
    out = set()
    for dp, dn, fn in os.walk(dest):
        dn[:] = [d for d in dn if not d.startswith((".", "_")) and d.upper() not in ("PIONEER", "SYSTEM VOLUME INFORMATION")]
        out.update(os.path.join(dp, n) for n in fn if not n.startswith(".") and os.path.splitext(n)[1].lower() in AUDIO_EXTS)
    return out

def _put_back(job, dest):
    """Undo a failed rebuild: move any half-built library out of the way, then give the set-aside one its name back."""
    try:
        aside, name = Path(job["backup"]), job.get("aside_name") or "PIONEER"
        if not aside.exists(): return False
        cur = _root(dest)
        if cur: cur.rename(dest / f"_{cur.name} failed rebuild {time.strftime('%Y%m%d-%H%M%S')}")
        aside.rename(dest / name); job["backup"] = None
        return True
    except OSError: return False

def _run(job, plan, dest, stick, set_aside=False):
    stage = Path(tempfile.mkdtemp(prefix="wf-cdj-"))
    try:
        for nm, files in plan:
            if not files: continue
            d = stage / nm; d.mkdir(); used = set()
            for f in files:
                n = Path(f).name; k = 2
                while n.lower() in used: n = f"{Path(f).stem} ({k}){Path(f).suffix}"; k += 1
                used.add(n.lower()); os.symlink(f, d / n)
        before = _stick_audio(dest)
        # Each playlist's track order, by real file, for the exporter (it would otherwise sort by file name).
        order = {nm: [unicodedata.normalize("NFC", os.path.realpath(f)) for f in files] for nm, files in plan if files}
        (stage / ".order.json").write_text(json.dumps(order))
        root = _root(dest)
        if set_aside and root:   # explicit rebuild only. Rename, never delete: the old library stays on the stick under this name
            job["stage"] = "setting the old library aside"; _bump(job, 2)
            aside = dest / f"_{root.name} before Waxfinder {time.strftime('%Y%m%d-%H%M%S')}"; root.rename(aside)
            job["backup"], job["aside_name"] = str(aside), root.name; _save(job)
        CACHE.mkdir(exist_ok=True)
        w = WARM["thread"]
        if w and w.is_alive():   # don't wait minutes for the background listening: stop it (finished tracks are already cached; this export listens to its own)
            job["stage"] = "starting"; pr = WARM.get("proc")
            if pr and pr.poll() is None: pr.terminate()
            w.join(10)
        # Listening (analysis) writes the shared cache, so only one export does it at a time; writing the stick then runs in parallel.
        if not LISTEN.acquire(blocking=False):
            job["stage"] = "waiting for the other export to finish listening"
            while not LISTEN.acquire(timeout=1):
                if job.get("cancel"): raise RuntimeError("Cancelled")
        try:
            if job.get("cancel"): raise RuntimeError("Cancelled")
            job["stage"] = "listening to tracks"
            wp = job["proc"] = subprocess.Popen([*enginebin.gentle(5), str(BIN), "warm", str(stage), "--cache", str(CACHE)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace", env=_env(False))
            for line in wp.stderr:
                m = re.match(r"\[(\d+)/(\d+)\]", line.strip())
                if m: job["done"] = int(m[1]); _bump(job, 4 + 76 * int(m[1]) / max(1, int(m[2])))
            wp.wait()
            if job.get("cancel"): raise RuntimeError("Cancelled")
        finally: LISTEN.release()
        # A Rekordbox-written exportLibrary.db makes SQLite create -wal/-shm files the first time it is opened, which the engine's
        # "did another writer change the device" check reads as a change and aborts BEFORE publishing anything. The files exist
        # after that first try, so one automatic retry goes through (reproduced on a copy of the real stick, 2026-11-05).
        for attempt in (1, 2):
            if job.get("cancel"): raise RuntimeError("Cancelled")
            p = job["proc"] = subprocess.Popen([str(BIN), "export", str(stage), str(dest), "--add", "--root", "auto", "--cache", str(CACHE), "--order", str(stage / ".order.json")],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace", env=_env(False))
            def pump():
                for line in p.stderr:
                    line = line.strip(); job["log"] = (job["log"] + [line])[-30:]
                    m = re.match(r"\[(\d+)/(\d+)\]", line)
                    if m: job["done"], job["stage"] = int(m[1]), "listening to tracks"; _bump(job, 4 + 76 * int(m[1]) / max(1, int(m[2])))
                    elif line.startswith("export: "):
                        job["stage"] = {"checking": "checking files", "copying": "copying audio", "database": "writing the stick's library",
                                        "verifying": "checking the result", "publishing": "finishing"}.get(line[8:], line[8:])
                        _bump(job, {"checking": 82, "copying": 86, "database": 92, "verifying": 96, "publishing": 98}.get(line[8:], 0)); _save(job)   # a restart must know how far it got
            t = threading.Thread(target=pump, daemon=True); t.start()
            out = p.stdout.read(); p.wait(); t.join(5)
            if job.get("cancel"): raise RuntimeError("Cancelled")
            if p.returncode == 0: break
            err = next((l for l in reversed(job["log"]) if l.startswith("error")), "the export tool failed")
            if attempt == 1 and "changed during sync" in err:
                job["stage"] = "retrying once"; job["log"].append("retry after device-changed conflict"); continue
            raise RuntimeError(err[:1500])
        r = json.loads(out)
        job["report"] = {k: r.get(k) for k in ("tracks", "playlists", "bytes_copied", "verify_ok", "root", "skipped", "failed", "warnings", "not_analysed")}
        try: job["report"]["new_files"] = len(_stick_audio(dest) - before)   # files actually copied onto the stick by this export
        except OSError: pass
        for k, why in (("failed", "the export tool could not read or analyse it"), ("skipped", "the export tool skipped it")):
            for x in r.get(k) or []:
                t = x if isinstance(x, str) else (x.get("title") or x.get("path") or x.get("file") or json.dumps(x, ensure_ascii=False))
                z = "" if isinstance(x, str) else (x.get("reason") or x.get("error") or x.get("detail") or "")
                job["left_out"].append({"title": Path(str(t)).stem if "/" in str(t) else str(t), "crate": "", "why": (why + (": " + str(z) if z else ""))[:200]})
        if r.get("verify_ok") is not True:   # false OR missing: the engine already PUBLISHED, so never show a green "checked OK"
            job["outcome"] = "verify_failed"
            job["error"] = "The playlists were written to the stick, but its own check did not pass (some audio may be missing). Don't rely on this stick yet: export these crates again to repair it."
            job["state"], job["stage"] = "error", "check failed"
        else:
            job["outcome"] = "omissions" if (job["left_out"] or job.get("missing")) else "verified"
            job["state"], job["stage"], job["pct"] = "done", "done", 100
            _remember_names(stick["name"], job.get("plan_ids") or [])
            try: job["report"]["changes"] = _changes(stick["name"], plan, bool(set_aside))
            except Exception: pass
    except Exception as ex:
        job["state"], job["error"] = "error", _plain(ex); job["detail"] = str(ex)[:1500]; job["log"].append("error: " + str(ex)[:300])
        job["outcome"] = "failed"
        if set_aside and job.get("backup"):   # the rebuild failed: put the previous library back so the stick is as it was
            ok = _put_back(job, dest)
            job["restored"] = ok
            job["error"] = "The rebuild did not complete." if "ancel" not in job["error"] else "Cancelled."
            job["error"] += " The stick's previous library was put back." if ok else f" Your previous library is still on the stick in the folder {Path(job['backup']).name}."
        elif not set_aside and re.search(r"discoverable|did not verify|mismatch|collision", str(ex)):
            mine = {n.lower() for n, _ in plan}
            job["will_vanish"] = [n for n in _stick_names(dest) if n.lower() not in mine][:60]   # playlists a rebuild would drop from the CDJ-visible library
            job["needs_rebuild"] = True   # offered as a separate, explicit choice in the UI; never done automatically
    finally:
        job["ended"] = time.time(); shutil.rmtree(stage, ignore_errors=True); _save(job)

def cancel(jid):
    """Stop a running export. Safe only before the engine starts publishing (it writes the stick's library last, all at once)."""
    j = JOBS.get(jid)
    if not j or j["state"] != "running": return {"error": "Not running"}
    if j.get("pct", 0) >= 95: return {"error": "Too late, finishing"}
    j["cancel"] = True
    pr = j.get("proc")
    if pr and pr.poll() is None: pr.terminate()
    return {"ok": True}

def warm(hist, force=False):
    """Pre-analyse every reachable crate track into rbx_cache/ in the background (all cores, low priority), so a later export only
    writes the stick (about a second) whatever the machine. Cheap when everything is already cached. At most once a minute."""
    if not available(): return False
    with LOCK:
        t = WARM["thread"]
        if (t and t.is_alive()) or (not force and time.time() - WARM["at"] < 60): return False
        WARM["at"] = time.time()
        WARM["thread"] = threading.Thread(target=_warm, args=(hist,), daemon=True); WARM["thread"].start()
    return True

def _warm(hist):
    stage = Path(tempfile.mkdtemp(prefix="wf-warm-"))
    try:
        idx = crates._index(hist); seen = set(); n = 0
        for c in crates._load()["crates"]:
            for _, e in crates._resolve(hist, c["ids"], c.get("snap", {}), idx):
                f = e and e.get("file")
                if f and f not in seen and setbuild.exists(f):
                    seen.add(f); os.symlink(f, stage / f"{n:05d}-{Path(f).name}"); n += 1
        if not n: return
        CACHE.mkdir(exist_ok=True)
        pr = WARM["proc"] = subprocess.Popen([*enginebin.gentle(10), str(BIN), "warm", str(stage), "--cache", str(CACHE)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=_env(True))
        pr.wait(timeout=7200)
    except Exception: pass
    finally: shutil.rmtree(stage, ignore_errors=True)

def _plain(msg):
    """Engine/OS error -> one plain sentence for the person. The raw text stays in the job log."""
    m = str(msg); low = m.lower()
    for pats, say in ((("no space", "not enough room", "not enough temporary", "disk full"), "The stick is full."),
                      (("device gone", "no such file or directory", "input/output error", "not a folder", "device not configured", "broken pipe"), "The stick was unplugged or stopped responding."),
                      (("permission denied", "read-only"), "The stick is read-only or locked."),
                      (("cancelled",), "Cancelled."),
                      (("another writer", "changed during sync"), "Something else changed the stick during the export."),
                      (("did not verify", "not discoverable", "mismatch", "collision"), "The stick's existing library could not be merged safely. Waxfinder did not change or replace it."),
                      (("did not pass its own check",), "The stick's library did not pass its check. Waxfinder did not replace it.")):
        if any(p in low for p in pats): return say
    return "The export stopped unexpectedly. Check the stick before relying on it; exporting again is safe."

def _bump(job, p): job["pct"] = max(job.get("pct", 0), min(99, int(p)))   # never goes backwards (the analysis pass and the tool's own pass both report)

LAST = HERE / "cdj_last.json"   # the latest export's outcome, so a restart of the app never makes the progress pill just vanish
def _save(job):
    try:
        tmp = LAST.with_suffix(".tmp"); tmp.write_text(json.dumps({k: job.get(k) for k in KEYS + ("started", "ended")}, default=str)); os.replace(tmp, LAST)
    except Exception: pass
def _restore():
    try:
        j = json.loads(LAST.read_text())
        if j.get("state") == "done": return   # a finished export is not news after a restart; only a failure or interruption still needs attention
        if j.get("state") == "running":
            pre = (j.get("stage") or "") in ("starting", "listening to tracks", "checking files", "setting the old library aside") or str(j.get("stage") or "").startswith("waiting")
            j.update(state="error", outcome="unknown", stage="interrupted", error="Interrupted: the app restarted during the export. " + (
                "It had not started writing to the stick." if pre and not j.get("backup") else
                "It may have been part-way through writing the stick, so the outcome is unknown. Check the stick (export again to be safe)."
                + (f" The previous library was set aside as {Path(j['backup']).name}." if j.get("backup") else "")))
        j.setdefault("log", []); JOBS[j["id"]] = j
    except Exception: pass

KEYS = ("id", "state", "stage", "pct", "done", "total", "stick", "crates", "missing", "left_out", "report", "error", "detail", "backup", "outcome", "needs_rebuild", "will_vanish", "restored", "crate_ids", "volume")
def status(jid):
    j = JOBS.get(jid)
    return j and {k: j.get(k) for k in KEYS}

def active():
    """The running export, else the most recent one (kept so the shell's progress pill can still show how it ended). None if there never was one."""
    if not JOBS: return None
    run = [j for j in JOBS.values() if j["state"] == "running"]
    j = (run or sorted(JOBS.values(), key=lambda j: j["started"]))[-1]
    if j["state"] == "done" and time.time() - (j.get("ended") or j["started"]) > 300: return None   # a clean finish shows for 5 minutes, then the pill goes away on its own
    out = {k: j.get(k) for k in KEYS}
    out["others"] = [{k: o.get(k) for k in ("id", "stick", "pct", "stage")} for o in run if o is not j]   # other exports running at the same time
    return out


# ---- Devices chip (static/devices.js): list sticks, browse folders read-only, reveal, eject ----
AUDIO = {".mp3", ".wav", ".flac", ".aiff", ".aif", ".m4a", ".aac", ".ogg", ".alac"}
_DEV = {"sig": None, "at": 0, "out": []}

def devices():
    """Plugged-in sticks, cached for 3 s (diskutil per volume is slow) and refreshed at once when /Volumes changes."""
    try: sig = tuple(sorted(os.listdir("/Volumes")))
    except OSError: sig = ()
    if sig == _DEV["sig"] and time.time() - _DEV["at"] < 3: return _DEV["out"]
    _DEV.update(sig=sig, at=time.time(), out=sticks()); return _DEV["out"]

def places():
    """This computer's usual music places (only the ones that exist)."""
    h = Path.home()
    return [{"name": n, "path": str(p)} for n, p in (("Home", h), ("Music", h / "Music"), ("Downloads", h / "Downloads"), ("Desktop", h / "Desktop"), ("Documents", h / "Documents")) if p.is_dir()]

_PICKED = set()   # folders the person chose with the system picker this session: browsable even outside home / the sticks
def allow(path): _PICKED.add(str(Path(path).resolve()))

def pick_folder(prompt):
    """Open the system folder picker and return the chosen folder (None = cancelled). macOS Finder, Windows Explorer, or zenity on Linux."""
    try:
        if sys.platform == "darwin":
            r = subprocess.run(["osascript", "-e", f'POSIX path of (choose folder with prompt "{prompt.replace(chr(34), "")}")'], capture_output=True, text=True, timeout=600)
        elif sys.platform.startswith("win"):
            ps = "Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='" + prompt.replace("'", "") + "';if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}"
            r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True, timeout=600)
        else:
            r = subprocess.run(["zenity", "--file-selection", "--directory", "--title", prompt], capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired): return None
    p = (r.stdout or "").strip()
    return p.rstrip("/") if r.returncode == 0 and p and Path(p).is_dir() else None

def _inside(path, sticks_only=False):
    """The real path if it is inside a plugged-in stick or (unless sticks_only) your home folder, else None.
    Hidden folders and ~/Library are never reachable."""
    try: real = Path(path).resolve()
    except Exception: return None
    roots = [Path(s["path"]).resolve() for s in devices()]
    if not sticks_only: roots += [Path.home().resolve()] + [Path(x) for x in _PICKED]
    for base in roots:
        if real == base or base in real.parents:
            rel = real.relative_to(base).parts
            if base == Path.home().resolve() and (rel[:1] == ("Library",) or any(p.startswith(".") for p in rel)): return None
            return real
    return None

def listdir(path, cap=400):
    real = _inside(path)
    if not real or not real.is_dir(): return {"error": "That folder isn't on a plugged-in stick"}
    dirs, files = [], []
    try:
        for e in sorted(os.scandir(real), key=lambda e: e.name.lower()):
            if e.name.startswith(".") or e.name.startswith("_Waxfinder backup"): continue
            if e.is_dir(follow_symlinks=False):
                tag = {"PIONEER": "CDJ library", "Contents": "audio copied for CDJs"}.get(e.name, "")
                dirs.append({"name": e.name, "tag": tag})
            elif Path(e.name).suffix.lower() in AUDIO:
                try: files.append({"name": e.name, "size": e.stat().st_size})
                except OSError: pass
    except OSError as ex: return {"error": str(ex)[:80]}
    more = max(0, len(dirs) + len(files) - cap)
    return {"dirs": dirs[:cap], "files": files[:max(0, cap - len(dirs))], "more": more}

_PL = {}   # stick path -> (export.pdb mtime, crates): only re-read when the stick's library changed
def playlists(path):
    """Every crate/set on a stick (its CDJ playlists) with the tracks in each, read straight from export.pdb. Nothing else on the stick."""
    real = _inside(path, sticks_only=True)
    if not real or not real.is_dir(): return {"error": "That isn't a plugged-in stick"}
    root = _root(real); pdb = root / "rekordbox" / "export.pdb" if root else None
    if not pdb or not pdb.is_file(): return {"playlists": []}
    mt = pdb.stat().st_mtime
    if _PL.get(str(real), (0,))[0] == mt: return {"playlists": _PL[str(real)][1]}
    try:
        import pdbread
        rows = pdbread.read(str(pdb))
    except Exception as ex: return {"error": "Could not read the stick's library: " + str(ex)[:60]}
    rows = [{"name": (r["folder"] + " / " if r["folder"] else "") + r["name"], "tracks": r["tracks"]} for r in rows]
    _PL[str(real)] = (mt, rows)
    return {"playlists": rows}

def playlist_match(hist, stick_name, name):
    """Library track ids for the tracks of one crate on a stick (so the Library can show that crate). Matches the copy on the stick
    by path first, then by artist + title. Returns {ids, total, matched}."""
    stick = next((x for x in sticks() if x["name"] == stick_name), None)
    if not stick: return {"error": "That stick isn't plugged in"}
    root = _root(Path(stick["path"])); pdb = root / "rekordbox" / "export.pdb" if root else None
    if not pdb or not pdb.is_file(): return {"error": "No crates on that stick"}
    import pdbread, names as nm
    pls = pdbread.read(str(pdb), paths=True)
    pl = next((r for r in pls if ((r["folder"] + " / " if r["folder"] else "") + r["name"]) == name), None)
    if not pl: return {"error": "That crate isn't on the stick any more"}
    rows = crates.library_all(hist)
    by_path = {setbuild.nfc(e["file"]): e["id"] for e in hist if e.get("file")}
    by_key, by_title = {}, {}
    for r in rows:
        by_key.setdefault(nm.akey(r["artist"]) + "|" + nm.akey(r["title"]), r["id"]); by_title.setdefault(nm.akey(r["title"]), []).append(r["id"])
    ids, seen = [], set()
    for t in pl["tracks"]:
        i = by_path.get(setbuild.nfc(stick["path"] + t.get("path", ""))) if t.get("path") else None
        i = i or by_key.get(nm.akey(t["artist"]) + "|" + nm.akey(t["title"]))
        if not i:
            c = by_title.get(nm.akey(t["title"]), []); i = c[0] if len(c) == 1 else None   # same title, only one such song in the library
        if i and i not in seen: seen.add(i); ids.append(i)
    return {"ids": ids, "total": len(pl["tracks"]), "matched": len(ids)}

def reveal(path):
    real = _inside(path)
    if not real: return {"error": "not on a stick"}
    subprocess.run(["open", "-R", str(real)], timeout=10); return {"ok": True}

def eject(path):
    real = _inside(path, True)
    if not real or not os.path.ismount(real): return {"error": "not a stick"}
    if any(j["state"] == "running" and j["stick"] == real.name for j in JOBS.values()): return {"error": "an export is running"}
    r = subprocess.run(["diskutil", "eject", str(real)], capture_output=True, text=True, timeout=60)
    _DEV["sig"] = None
    return {"ok": True} if r.returncode == 0 else {"error": (r.stderr or r.stdout).strip()[:120] or "in use"}

_restore()
