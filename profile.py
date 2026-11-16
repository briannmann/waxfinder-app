"""Taste profile: what you like and don't, learned from genre tags, artists and channels.

Signals: likes and downloads say yes, Rekordbox says a quieter yes, "Not for me" says no.
Each artist's Last.fm tags are spread over the signal; a tag's score is the log-odds of it turning up
in your yes pile vs your no pile, so tags on both sides (house, electronic, dance) cancel out and only
the ones that separate your taste (pop, dance-pop vs deep house, chicago house) count.
Everything is soft: no tag, artist or channel is ever banned outright.
"""
import math, time
from names import credits, akey
import lastfm

def item_artists(title, channel=""):
    """Main artist first, then remixers / featured. Falls back to an auto-made 'Artist - Topic' channel only."""
    names = credits(title or "")
    if not names and (channel or "").endswith(" - Topic"): names = [channel[:-8].strip()]
    return names

class Profile:
    def __init__(self, signals, half_life_days=120, tags_loader=None):
        """signals: dicts {artists:[...], channel, weight, side:'yes'|'no', ts}."""
        self.tag_y, self.tag_n, self.art, self.chan = {}, {}, {}, {}
        self.tags_loader = tags_loader or lastfm.tags_w
        now = time.time()
        for s in signals:
            w = s["weight"] * (0.5 ** ((now - s.get("ts", now)) / 86400 / half_life_days) if s.get("ts") else 1)
            sign = 1 if s["side"] == "yes" else -1
            arts = s.get("artists") or []
            for i, a in enumerate(arts[:2]):
                k = akey(a)
                if k: self.art[k] = self.art.get(k, 0) + sign * w * (1 if i == 0 else .5)
            ch = s.get("channel") or ""
            if ch and not ch.endswith(" - Topic"): self.chan[akey(ch)] = self.chan.get(akey(ch), 0) + sign * w * .5
            if arts:
                tw = self.tags_loader(arts[0])
                tot = sum(c for _, c in tw)
                bag = self.tag_y if sign > 0 else self.tag_n
                for t, c in tw: bag[t] = bag.get(t, 0) + w * c / tot
        Y, N = sum(self.tag_y.values()) or 1, sum(self.tag_n.values()) or 1
        V, a = max(1, len(set(self.tag_y) | set(self.tag_n))), 0.3
        self.tag = {t: math.log((self.tag_y.get(t, 0) + a) / (Y + a * V)) - math.log((self.tag_n.get(t, 0) + a) / (N + a * V))
                    for t in set(self.tag_y) | set(self.tag_n)}

    def tag_fit(self, artist):
        """-1..1-ish: how much this artist's genre tags look like your yes pile vs your no pile. None = no tags known."""
        tw = self.tags_loader(artist) if artist else []
        tw = [(t, c) for t, c in tw if t in self.tag]
        if not tw: return None
        return math.tanh(sum(self.tag[t] * c for t, c in tw) / sum(c for _, c in tw) / 2)

    def score(self, title, channel=""):
        """Adjustment for a candidate, plus a short reason. Capped both ways so nothing is ever a hard ban."""
        arts = item_artists(title, channel)
        fit = self.tag_fit(arts[0]) if arts else None
        adj = 3.0 * fit if fit is not None else 0.0
        a = max([self.art.get(akey(x), 0) for x in arts[:2]] or [0], key=abs)
        adj += max(-2.5, min(2.0, a))                                       # artists you've voted on, netted out
        adj += max(-1.0, min(1.0, self.chan.get(akey(channel), 0)))         # channels, gently
        return max(-5.0, min(4.0, adj)), fit
