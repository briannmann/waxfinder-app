"""Bounded preference nudges for discovery Picks. Uses saved votes, tags and audio only; no network or writes."""
import base64
import re
import time
from urllib.parse import urlsplit, parse_qs

import numpy as np
import lastfm
import profile
import soundindex
import taste
from names import parse_title


def identities(item):
    keys = set()
    if item.get("id"): keys.add("id:" + item["id"])
    url = item.get("url") or item.get("page")
    if url:
        u = urlsplit(url)
        keys.add("url:" + u._replace(query="", fragment="").geturl())
        # Library entries have local IDs; votes use the YouTube video ID.
        host = (u.hostname or "").lower()
        video = (parse_qs(u.query).get("v") or [None])[0] if host in ("youtube.com", "www.youtube.com", "m.youtube.com") else u.path.strip("/") if host == "youtu.be" else None
        if video and re.fullmatch(r"[\w-]{11}", video):
            keys.add("id:" + video)
            keys.discard("url:" + u._replace(query="", fragment="").geturl())
    return keys


def song_key(item):
    artist = item.get("artist")
    title = item.get("track") or item.get("title") or ""
    parsed, track = parse_title(title)
    if parsed: artist, title = parsed, track
    return taste.own_key(artist, title)


def unit_vector(value):
    try:
        vector = np.frombuffer(base64.b64decode(value, validate=True), dtype=np.float16).astype(np.float32)
        norm = float(np.linalg.norm(vector))
        return vector / norm if vector.shape == (1280,) and np.isfinite(vector).all() and norm > 0 else None
    except (ValueError, TypeError): return None


class Preferences:
    def __init__(self, votes, hist, catalogue, now=None):
        now = time.time() if now is None else now
        self.blocked = {key for vote in votes.values() if vote.get("v") == -1
                        if (key := song_key(vote.get("item") or {}))}
        signals = []
        bank = {}
        for candidate in catalogue:
            if candidate.get("v"):
                for key in identities(candidate): bank[key] = candidate["v"]
        for entry in hist:
            try: cached = soundindex.cached(entry)
            except Exception: cached = None   # one unreadable entry must never take the whole taste profile (and Picks) down
            if cached:
                for key in identities(entry): bank[key] = cached["v"]
        self.bank = bank
        self.audio = {1: [], -1: []}
        for vote_id, vote in votes.items():
            side = vote.get("v")
            if side not in self.audio: continue
            item = vote.get("item") or {}
            signals.append({"artists": profile.item_artists(item.get("title"), item.get("channel", "")),
                            "channel": item.get("channel", ""), "weight": 1.,
                            "side": "yes" if side == 1 else "no", "ts": vote.get("ts", now)})
            vector = self.vector({**item, "id": vote_id})
            if vector is not None:
                age = max(0, now - (vote.get("ts") or now))
                self.audio[side].append((vector, .5 ** (age / (120 * 86400))))
        self.metadata = profile.Profile(signals, tags_loader=lastfm.cached_tags_w)
        self.scale = soundindex.matrix(hist) if any(self.audio.values()) else None

    def vector(self, item):
        if item.get("v"): return unit_vector(item["v"])
        for key in identities(item):
            if key in self.bank: return unit_vector(self.bank[key])
        return None

    def _strength(self, vector, side):
        matches = []
        for known, weight in self.audio[side]:
            percent = soundindex.pct(float(vector @ known), self.scale)
            matches.append((max(0., min(1., (percent - 60) / 40)), weight))
        nearest = sorted(matches, key=lambda x: x[0] * x[1], reverse=True)[:3]
        return sum(strength * weight for strength, weight in nearest) / max(1., sum(weight for _, weight in nearest))

    def audio_adjustment(self, item):
        vector = self.vector(item)
        if vector is not None and self.scale is not None:
            return 6 * self._strength(vector, 1) - 8 * self._strength(vector, -1)
        return 0.

    def adjustment(self, item):
        title = item.get("title") or ""
        if item.get("artist") and not parse_title(title)[0]: title = item["artist"] + " - " + title
        adjustment, _ = self.metadata.score(title, item.get("channel") or item.get("label") or "")
        adjustment += self.audio_adjustment(item)
        return max(-12., min(10., adjustment))
