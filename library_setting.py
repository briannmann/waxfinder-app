"""Where THIS person's music library lives. Unset = the old behaviour (the MUSIC stick if plugged in, else ./downloads).
Set from the Files browser ("Use this folder as my library"); stored in library_setting.json (not in config.json, which holds keys)."""
import json, os
from pathlib import Path
FILE = Path(__file__).parent / "library_setting.json"

def configured():
    """The folder the person chose, whether or not it is reachable right now (None = never chose one)."""
    try: p = Path(json.loads(FILE.read_text()).get("dir", ""))
    except (OSError, ValueError, TypeError): return None
    return p if str(p) and str(p) != "." else None

def get():
    try: p = Path(json.loads(FILE.read_text()).get("dir", ""))
    except (OSError, ValueError, TypeError): return None
    return p if str(p) and p.is_dir() else None

def set_dir(path):
    p = Path(path)
    if not p.is_dir(): raise ValueError("not a folder")
    tmp = FILE.with_suffix(".tmp"); tmp.write_text(json.dumps({"dir": str(p)})); os.replace(tmp, FILE)
    return p
