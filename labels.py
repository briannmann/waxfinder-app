"""Pull a record label / publisher name out of a YouTube description."""
import re

_JUNK = re.compile(r"all rights|rights holder|respective|https?:|www\.|youtube|subscribe|follow|facebook|instagram|spotify|bandcamp|soundcloud|\bapple\b", re.I)
_SUFFIX = re.compile(r"\s*\((?:[A-Z0-9 ]{2,8})\)\s*$")            # "Jazzanova Compost Records (JCR)" -> drop "(JCR)"
_TAIL = re.compile(r"[\s.,;:|\-–—]+$")

def _clean(s):
    s = _SUFFIX.sub("", (s or "").strip())
    s = re.sub(r"\b(?:inc|llc|ltd|limited|gmbh)\.?$", "", s, flags=re.I).strip()
    s = re.sub(r"\s+(?:worldwide|everywhere|now|today|soon|only)$", "", _TAIL.sub("", s).strip(), flags=re.I)
    s = _TAIL.sub("", s).strip()
    if not (3 <= len(s) <= 60) or _JUNK.search(s) or re.fullmatch(r"[\d\W]+", s): return ""
    return s

def extract_label(desc):
    if not desc: return ""
    lines = [l.strip() for l in desc.splitlines() if l.strip()]
    pats = [
        r"(?:℗|\(P\)|©|\(C\))\s*\d{4}\s*,?\s*(.+)",                                  # (C) 1991 PolyGram Records Inc.
        r"(?:Vinyl|CD|Cassette|Digital|File|Album|EP|LP|12\"|10\"|7\")[^\n]*?\s[-–—]\s{1,4}([A-Z0-9][^\n]{2,60})$",  # ... Vinyl, 12"  -  Deep Jazz Records
        r"^(?:Record\s+)?Label\s*[:\-–]\s*(.+)",                                      # Label: Toolroom
        r"(?:Released|Out now|Out|Available)\s+(?:on|via|by)\s+(.+)",                 # Out now on Defected
        r"^Provided to YouTube by\s+(.+)",                                            # distributor: lowest priority
    ]
    for rank, pat in enumerate(pats):
        for l in lines:
            m = re.search(pat, l, re.I if rank != 1 else 0)
            if m:
                c = _clean(re.split(r"\s{2,}|\s+[|•]\s+", m.group(1))[0])
                if c and not (rank == 4): return c
    return ""
