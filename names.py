"""Turn a YouTube title + channel into a clean 'Artist - Title' name."""
import re

CODE_RE = re.compile(r"^[A-Za-z]{2,6}[ -]?\d{2,}[A-Za-z]?$")  # catalogue numbers like NPW001, LBP004

def parse_title(title):
    """'Artist - Track (Mix)' -> (artist, track). Artist is None when the title has no clear artist part."""
    t = re.sub(r"\s+", " ", (title or "").strip())
    m = re.match(r"^(.{2,60}?)\s+[-–—]\s+(.+)$", t)
    if not m: return None, t
    left, right = m.group(1).strip(), m.group(2).strip()
    if CODE_RE.match(left) or len(left.split()) > 7 or re.fullmatch(r"[\d\W]+", left): return None, t
    return left, right

def split_artists(s):
    parts = re.split(r"\s+(?:feat\.?|ft\.?|featuring|vs\.?|x|&|and|with)\s+|\s*,\s*|\s*/\s*", s or "", flags=re.I)
    return [p.strip() for p in parts if p.strip()]

def akey(name): return re.sub(r"[^a-z0-9]+", "", (name or "").lower())

_NOISE = re.compile(r"official|video|audio|lyric|visuali[sz]er|\bhd\b|\bhq\b|free download|premiere|out now|full (?:track|version)|music only|remaster(?:ed)?\s*$", re.I)
_GENERIC_CHANNELS = re.compile(r"^(?:various|unknown|youtube|topic)", re.I)

def _strip_noise(t):
    t = re.sub(r"\s*[\(\[]([^\)\]]*)[\)\]]", lambda m: "" if _NOISE.search(m.group(1)) else m.group(0), t)   # (Official Video), [HD]
    t = re.split(r"\s+\|\s+", t)[0]                                                                          # " | Label / year"
    return re.sub(r"\s+", " ", t).strip(" -–—")

def display_name(title, channel="", uploader=""):
    """Always 'Artist - Title'. Artist comes from the title, else a '- Topic' channel, else the uploader."""
    t = _strip_noise(re.sub(r"\s+", " ", (title or "").strip()))
    m = re.match(r"^(.+?)\s+[-\u2013\u2014]\s+free\s+(?:download|dl)\b\s*[:\-\u2013\u2014]?\s*(.+)$", t, re.I)
    if m: t = m.group(2) if re.search(r"\s[-\u2013\u2014]\s", m.group(2)) else m.group(1) + " - " + m.group(2)   # "Uploader - FREE DOWNLOAD : Artist - Track"
    t = re.sub(r"\s*[\(\[]?\bfree\s+(?:download|dl)\b[\)\]]?\s*:?", " ", t, flags=re.I).strip(" -:")
    m = re.match(r"^([A-Za-z]{2,6}[ -]?\d{2,}[A-Za-z]?)\s+[-\u2013\u2014]\s+(.+)$", t)   # "NPW001 - Rock The Boat": drop the catalogue number
    if m: t = m.group(2)
    artist, track = parse_title(t)
    if not artist:
        ch = (channel or uploader or "").strip()
        if ch.endswith(" - Topic"): ch = ch[:-8].strip()
        artist = ch if ch and not _GENERIC_CHANNELS.match(ch) else ""
        track = t
    track = re.sub(r"^\s*[-–—]\s*", "", track).strip() or t or "Untitled"
    return (f"{artist} - {track}" if artist else track), (artist or ""), track

def safe_filename(name):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name)).strip(" .")[:150] or "track"


# ---- credits: main artist + remixers/editors + featured artists ------------------------------------------------
_STRONG = r"remix|re-?mix|rmx|edit|re-?edit|rework|re-?work|bootleg|refix|re-?fix|flip|rerub|re-?rub|remodel|reconstruction|revision|redo|vip|touch"
_WEAK = r"mix|dub|version|vocal|instrumental"
_QUALIFIERS = {"vocal","dub","instrumental","club","extended","radio","main","original","acapella","a cappella","long","short","full","album","single","uk","us","special","vip","re","the","new","old","classic","alternative","alternate","live"}
_FLAVOUR_LAST = {"soul","deep","tribal","jazz","house","garage","disco","funk","tech","afro","latin","piano","sunset","sunrise","night","day","dark","light","bass","acid","dream","summer","winter","mood","ambient","groove","lounge","jackin","vibe","vibes","beat","beats","spirit","gospel","soulful"}
_BRACKETS = re.compile(r"[\(\[]([^\)\]]{3,80})[\)\]]")

def remixers(title):
    """Names credited inside brackets: '(Derrick Carter Remix)', '(Kerri Chandler Dub)', '(Remix by X)', '(feat. Y)' is separate."""
    out = []
    for m in _BRACKETS.finditer(title or ""):
        b = re.sub(r"\s+", " ", m.group(1)).strip()
        by = re.match(r"^(?:remix(?:ed)?|edit(?:ed)?|rework(?:ed)?|produced|mixed)\s+by\s+(.+)$", b, re.I)
        if by: out += split_artists(by.group(1)); continue
        k = re.match(rf"^(.+?)(?:['’]s)?\s+({_STRONG}|{_WEAK})(?:\s+(?:{_STRONG}|{_WEAK}))*$", b, re.I)
        if not k: continue
        name, kw = k.group(1).strip(), k.group(2).lower()
        words = name.split()
        while words and words[-1].lower() in _QUALIFIERS: words.pop()       # "Fred Everything Vocal" -> "Fred Everything"
        name = " ".join(words)
        if not name or name.lower() in _QUALIFIERS or len(name) < 2: continue
        if words[-1].lower() in _FLAVOUR_LAST: continue                      # "Yoruba Soul Mix": a flavour, not a person
        if re.fullmatch(r"(?:\d+|[ivx]+|part \d+|pt\.? ?\d+)", name, re.I): continue
        if re.fullmatch(_WEAK, kw) and not re.fullmatch(_STRONG, kw) and len(words) < 2: continue   # one word + Mix/Dub: too ambiguous
        out += split_artists(name)
    return out

def featured(title):
    out = []
    for m in re.finditer(r"(?:\bfeat\.?|\bft\.?|\bfeaturing)\s+([^()\[\]\-–—]+)", title or "", re.I):
        out += split_artists(re.sub(r"\s+(?:remix|edit|mix|dub)$", "", m.group(1).strip(), flags=re.I))
    return out

def credits(title):
    """Everyone credited on a track, main artist first, de-duplicated."""
    seen, out = set(), []
    for n in split_artists(parse_title(title)[0] or "") + remixers(title) + featured(title):
        k = akey(n)
        if k and k not in seen: seen.add(k); out.append(n)
    return out
