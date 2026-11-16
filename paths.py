"""Paths as they are stored in the data files: always '/'-separated (/Volumes/MUSIC/...), so the same JSON works on the
Mac and on Windows. On Windows str(Path) gives backslashes, which made every song look new (duplicates in history.json)."""
import os, sys, threading, time
from pathlib import Path


def safe_replace(src, dst):
    """os.replace for the atomic data-file saves. On Windows it fails with 'access denied' while another thread is
    reading the old copy (open files can't be replaced there), which turned crate edits into errors: wait it out."""
    for i in range(20):
        try: return os.replace(src, dst)
        except PermissionError:
            if sys.platform != "win32" or i == 19: raise
            time.sleep(.05)


def atomic_write(path, text):
    """Save a data file all-or-nothing: write a temp copy, then swap it in. A crash or kill mid-write can no longer leave a
    half-written (damaged) votes/dismissed/bpm file behind."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")   # one temp per writer: two saves at once never share it
    try:
        tmp.write_text(text, encoding="utf-8"); safe_replace(tmp, path)
    except BaseException:
        try: tmp.unlink()
        except OSError: pass
        raise


_NOTED = {}
def note(where, ex=None):
    """For the places that must carry on when something fails: keep going, but leave one line in swallowed.log so a real fault is
    never silent. At most one line per place per 10 minutes (a loop cannot flood it). Never raises."""
    try:
        now = time.time()
        if now - _NOTED.get(where, 0) < 600: return
        _NOTED[where] = now
        with open(Path(__file__).parent / "swallowed.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {where}: {type(ex).__name__}: {str(ex)[:200]}\n")
    except Exception: pass


if sys.platform == "win32":
    def posix(p): return str(p).replace("\\", "/")
else:
    def posix(p): return str(p)   # a backslash is a legal filename character on the Mac: leave paths alone
