"""Audio-fingerprint lookup (Chromaprint fpcalc + AcoustID web service). Identifies a file from its SOUND, so the file name does not matter.
Gated: needs ~/Tools/fpcalc/fpcalc (or fpcalc on PATH) and the key in ~/Library/Application Support/Waxfinder/acoustid-key (kept out of the repo).
Without either, available() is False and callers fall back to title matching. About 3 requests/second at most."""
import json, shutil, subprocess, time, threading, urllib.parse, urllib.request
from pathlib import Path

KEY_FILE = Path.home() / "Library/Application Support/Waxfinder/acoustid-key"
FPCALC = Path.home() / "Tools/fpcalc/fpcalc"
_LOCK = threading.Lock(); _last = [0.0]

def _bin(): return str(FPCALC) if FPCALC.is_file() else shutil.which("fpcalc")
def _key():
    try: return KEY_FILE.read_text().strip()
    except OSError: return ""
def available(): return bool(_bin() and _key())

def fingerprint(path, secs=120):
    p = subprocess.run([_bin(), "-length", str(secs), str(path)], capture_output=True, text=True, timeout=60)
    kv = dict(l.split("=", 1) for l in p.stdout.splitlines() if "=" in l)
    return (int(float(kv["DURATION"])), kv["FINGERPRINT"]) if "FINGERPRINT" in kv else (None, None)

def lookup(path):
    """-> list of {score, title, artist, length} (best first), [] when nothing matches, None when it could not run."""
    if not available(): return None
    try: dur, fp = fingerprint(path)
    except Exception: return None
    if not fp: return None
    with _LOCK:
        wait = .4 - (time.time() - _last[0])
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
    body = urllib.parse.urlencode({"client": _key(), "duration": dur, "fingerprint": fp, "meta": "recordings releasegroups"}).encode()
    try: j = json.loads(urllib.request.urlopen(urllib.request.Request("https://api.acoustid.org/v2/lookup", data=body), timeout=25).read())
    except Exception: return None
    out = []
    for r in j.get("results", []):
        for rec in r.get("recordings", []):
            out.append({"score": r.get("score", 0), "title": rec.get("title", ""), "length": rec.get("duration"),
                        "artist": "".join(a.get("name", "") + a.get("joinphrase", "") for a in rec.get("artists", []))})
    return sorted(out, key=lambda x: -x["score"])
