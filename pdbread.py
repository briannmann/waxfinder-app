"""Read the crates (playlists) and their tracks straight from a stick's PIONEER/rekordbox/export.pdb (read-only).
Layout: the Pioneer 'DeviceSQL' database as documented by Deep Symmetry (crate-digger). Checked against `rbx-cli inspect` counts."""
import struct

TRACKS, ARTISTS, TREE, ENTRIES = 0, 2, 7, 8

def _str(b, p):
    f = b[p]
    if f & 1: n = (f >> 1) - 1; return b[p + 1:p + 1 + n].decode("utf-8", "replace")
    n = struct.unpack_from("<H", b, p + 1)[0]
    if f == 0x40: return b[p + 4:p + n].decode("utf-8", "replace")
    if f == 0x90: return b[p + 4:p + n].decode("utf-16-le", "replace").rstrip("\x00")
    return ""

def _rows(b, first, last, ps):
    """Row start offsets (within b) of one table: follow its page chain, read each page's row index groups."""
    page, seen = first, set()
    while page not in seen and page * ps + ps <= len(b):
        seen.add(page); base = page * ps
        flags = b[base + 0x1b]; nxt = struct.unpack_from("<I", b, base + 12)[0]
        if not flags & 0x40:   # 0x40 = strange page (an index page), skipped
            n = (b[base + 0x18] | b[base + 0x19] << 8 | b[base + 0x1a] << 16) & 0x1fff   # number of row offsets (13 bits); the rest of those 24 bits count valid rows
            for i in range(n):
                g, k = divmod(i, 16); gb = base + ps - 36 * (g + 1)
                present = struct.unpack_from("<H", b, gb + 32)[0]
                if present >> k & 1:
                    off = struct.unpack_from("<H", b, gb + 2 * (15 - k))[0]
                    yield base + 0x28 + off
        if page == last: break
        page = nxt

def read(path, paths=False):
    """-> list of {name, folder: 'A / B' or '', tracks: [{artist, title}]} for every playlist (folders flattened into the name path)."""
    b = open(path, "rb").read()
    ps, nt = struct.unpack_from("<II", b, 4)
    tabs = {}
    for i in range(nt):
        kind, _empty, first, last = struct.unpack_from("<IIII", b, 28 + 16 * i); tabs[kind] = (first, last)
    rows = lambda k: _rows(b, *tabs[k], ps) if k in tabs else iter(())
    artists = {}
    for p in rows(ARTISTS):
        sub = struct.unpack_from("<H", b, p)[0]; aid = struct.unpack_from("<I", b, p + 4)[0]
        ofs = struct.unpack_from("<H", b, p + 10)[0] if sub & 4 else b[p + 9]
        artists[aid] = _str(b, p + ofs)
    tracks = {}
    for p in rows(TRACKS):
        art = struct.unpack_from("<I", b, p + 0x44)[0]; tid = struct.unpack_from("<I", b, p + 0x48)[0]
        tofs = struct.unpack_from("<H", b, p + 0x5e + 2 * 17)[0]
        tracks[tid] = {"artist": artists.get(art, ""), "title": _str(b, p + tofs)}
        if paths: tracks[tid]["path"] = _str(b, p + struct.unpack_from("<H", b, p + 0x5e + 2 * 20)[0])
    tree = {}
    for p in rows(TREE):
        parent, _u, order, nid, isf = struct.unpack_from("<IIIII", b, p)
        tree[nid] = {"parent": parent, "order": order, "folder": bool(isf), "name": _str(b, p + 20)}
    ents = {}
    for p in rows(ENTRIES):
        idx, tid, pid = struct.unpack_from("<III", b, p); ents.setdefault(pid, []).append((idx, tid))
    out = []
    def walk(parent, trail):
        for nid, n in sorted(((i, n) for i, n in tree.items() if n["parent"] == parent), key=lambda x: x[1]["order"]):
            if n["folder"]: walk(nid, trail + [n["name"]])
            else: out.append({"name": n["name"], "folder": " / ".join(trail),
                              "tracks": [tracks.get(t, {"artist": "", "title": "(missing)"}) for _, t in sorted(ents.get(nid, []))]})
    walk(0, [])
    return out
