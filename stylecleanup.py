"""Remove model-generated genre fields while preserving vectors, votes and listing metadata."""
import json
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit


def published(record):
    source = record.get("style_source") or record.get("source")
    url = urlsplit(record.get("style_url") or record.get("url") or "")
    if url.scheme != "https":
        return False
    if source == "Traxsource":
        return url.hostname == "www.traxsource.com" and bool(re.match(r"^/track/\d+(?:/|$)", url.path))
    if source == "Discogs (release styles)":
        return url.hostname in ("www.discogs.com", "discogs.com") and bool(re.match(r"^/release/\d+(?:[/-]|$)", url.path))
    return False


def purge(path, data, records, *, inferred=False):
    """Call before workers start. Back up exact original bytes, then remove only estimated styles."""
    targets = [r for r in records if "styles" in r and (inferred or not published(r))]
    if not targets:
        return {"removed": 0}
    path = Path(path)
    # Refuse to turn a damaged or missing store into a replacement.
    json.loads(path.read_text())
    backup = path.parent / "tools" / "ref" / (path.name + ".before-style-cleanup-" + str(time.time_ns()) + ".bak")
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    for r in targets:
        r.pop("styles", None)
        if r.get("style_source") == "sound estimate":
            r.pop("style_source", None)
    tmp = path.with_name(path.name + ".style-cleanup.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    os.replace(tmp, path)
    return {"removed": len(targets), "backup": str(backup)}
