"""Tempo Lab analysis, ported to Python (numpy only) for use in other apps such as Wax finder.

This file mirrors the Rust analyser in Tempo Lab step by step, with the same tuned numbers,
so both give the same BPM and key (checked by check_port.py).

Quick use
---------
    import numpy as np
    import tempolab_analysis as tla

    x = ...                      # mono float32 samples, any sample rate (11025 Hz is ideal)
    r = tla.analyse(x, sr=11025) # dict: bpm, confidence, key, wheel, energy, beat grid...
    r["bpm"], r["key"], r["wheel"]

    tla.tempo(x)                 # drop-in for Wax finder's bpm.tempo(x) (expects 11025 Hz): BPM or None
    tla.key(x)                   # ("A minor", "8A", strength) or None

Steps (see ANALYSIS.md for the why):
  1. mono, decimate to ~11 kHz
  2. STFT 1024 window / 128 hop (~86 frames/s), 24 log-spaced bands
  3. onset strength = positive change of log band energy, summed; minus a 0.4 s running mean
  4. autocorrelation of the onset envelope; score every tempo 50-220 BPM on 1..8 beat lags,
     weighted by a log-normal prior around 120 BPM and by how well a pulse train fits
  5. half/double check on the "body" envelope (bands under 2 kHz, so hi-hats don't vote)
  6. least-squares fit of the actual onset peaks along the grid -> BPM to 0.01
  7. beat phase, first downbeat (low-band energy), confidence
  8. key: chromagram (8192 window, 50 Hz-2.1 kHz) correlated with Krumhansl-Kessler profiles
"""
import math

import numpy as np

__version__ = "1.0"

WIN = 1024
HOP = 128
KEY_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Tuned numbers (change them here, and in Tempo Lab, together)
MIN_BPM, MAX_BPM = 50.0, 220.0
PRIOR_CENTER, PRIOR_OCTAVES = 120.0, 1.0
OFFBEAT_DOUBLE = 0.40   # body onsets halfway between beats this strong (vs beats) -> tempo is double
ALT_BEAT_HALVE = 0.25   # every other beat this weak -> tempo is half
THIRDS_UP = 0.5        # onsets at both thirds of a beat this strong -> tempo is 1.5x
SNAP = 0.06             # snap to a whole BPM when this close


def _rnd(t):
    """Round half away from zero (as Rust does), for t >= 0."""
    return int(math.floor(t + 0.5))


# ---------------------------------------------------------------------------
# 1-3. Onset envelopes
# ---------------------------------------------------------------------------

def prepare(x, sr):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    factor = max(1, int(round(sr / 11025.0)))
    if factor == 1:
        return x, float(sr)
    n = len(x)
    prefix = np.concatenate([[0.0], np.cumsum(x)])
    w = factor * 2
    i = np.arange(0, n, factor)
    lo = np.maximum(i - w // 2, 0)
    hi = np.minimum(i + w // 2, n)
    out = (prefix[hi] - prefix[lo]) / np.maximum(hi - lo, 1)
    return out, sr / factor


def _detrend(e, w):
    n = len(e)
    if n == 0:
        return e
    prefix = np.concatenate([[0.0], np.cumsum(e)])
    i = np.arange(n)
    lo = np.maximum(i - w // 2, 0)
    hi = np.minimum(i + w // 2 + 1, n)
    m = (prefix[hi] - prefix[lo]) / (hi - lo)
    return np.maximum(e - m, 0.0)


def spectral(x, sr):
    """Onset envelopes (all bands, low < ~150 Hz, body < 2 kHz) and low/mid/high band energy per frame."""
    nbins = WIN // 2
    hz = sr / WIN
    nb = 24
    fmin, fmax = 30.0, sr / 2.0
    f = np.maximum(np.arange(nbins) * hz, fmin)
    t = np.log(f / fmin) / np.log(fmax / fmin)
    band_of = np.minimum((t * nb).astype(int), nb - 1)
    band_hz = fmin * (fmax / fmin) ** (np.arange(nb) / nb)
    low_cut = math.ceil(150.0 / hz)
    mid_cut = math.ceil(2000.0 / hz)

    frames = (len(x) - WIN) // HOP + 1 if len(x) > WIN else 1
    need = (frames - 1) * HOP + WIN
    xp = np.zeros(need)
    xp[: min(len(x), need)] = x[:need]
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)

    onset = np.zeros(frames)
    low = np.zeros(frames)
    body = np.zeros(frames)
    bands = np.zeros((frames, 3))
    prev = np.zeros(nb)
    chunk = 2048
    for s in range(0, frames, chunk):
        idx = np.arange(WIN)[None, :] + HOP * np.arange(s, min(frames, s + chunk))[:, None]
        spec = np.fft.rfft(xp[idx] * window, axis=1)
        p = (spec.real ** 2 + spec.imag ** 2)[:, 1:nbins]
        bo = band_of[1:nbins]
        cur = np.zeros((p.shape[0], nb))
        for k in range(nb):
            sel = bo == k
            if sel.any():
                cur[:, k] = p[:, sel].sum(axis=1)
        bands[s : s + p.shape[0], 0] = p[:, : low_cut - 1].sum(axis=1)
        bands[s : s + p.shape[0], 1] = p[:, low_cut - 1 : mid_cut - 1].sum(axis=1)
        bands[s : s + p.shape[0], 2] = p[:, mid_cut - 1 :].sum(axis=1)
        v = np.log1p(1000.0 * np.sqrt(cur))
        d = np.diff(np.vstack([prev[None, :], v]), axis=0)
        d = np.maximum(d, 0.0)
        onset[s : s + p.shape[0]] = d.sum(axis=1)
        low[s : s + p.shape[0]] = d[:, :5].sum(axis=1)
        body[s : s + p.shape[0]] = d[:, band_hz < 2000.0].sum(axis=1)
        prev = v[-1]
    onset[0] = low[0] = body[0] = 0.0
    fr = sr / HOP
    w = int(0.4 * fr)
    return _detrend(onset, w), _detrend(low, w), _detrend(body, w), bands, fr


# ---------------------------------------------------------------------------
# 4-6. Tempo
# ---------------------------------------------------------------------------

def autocorr(e, max_lag):
    n = len(e)
    max_lag = min(max_lag, n - 1)
    size = 1 << (n + max_lag + 1 - 1).bit_length()
    X = np.fft.rfft(e - e.mean(), size)
    r = np.fft.irfft(X.real ** 2 + X.imag ** 2, size)
    r0 = max(r[0], 1e-12)
    lags = np.arange(max_lag + 1)
    overlap = np.maximum(n - lags, 1) / max(n, 1)
    return r[: max_lag + 1] / r0 / np.maximum(overlap, 0.25)


def _interp(v, x):
    if x < 0:
        return 0.0
    i = int(math.floor(x))
    if i + 1 >= len(v):
        return 0.0
    t = x - i
    return v[i] * (1 - t) + v[i + 1] * t


def tempo_score(ac, fr, bpm, multiples):
    lag = 60.0 * fr / bpm
    s = wsum = 0.0
    for k in range(1, multiples + 1):
        l = lag * k
        if l + 1.0 >= len(ac):
            break
        v = max(_interp(ac, l), _interp(ac, l - 0.5), _interp(ac, l + 0.5))
        w = 1.0 / math.sqrt(k)
        s += v * w
        wsum += w
    return s / wsum if wsum > 0 else 0.0


def prior(bpm):
    z = math.log2(bpm / PRIOR_CENTER) / PRIOR_OCTAVES
    return math.exp(-0.5 * z * z)


def _at3(env, i):
    """max of env[i-1], env[i], env[i+1] for an array of indices i (i+1 < len)."""
    return np.maximum(np.maximum(env[np.maximum(i - 1, 0)], env[i]), env[i + 1])


def pulse_fit(env, fr, bpm):
    """(how much the best-phase pulse train beats the average onset, phase in frames)."""
    period = 60.0 * fr / bpm
    mean = max(env.mean(), 1e-9)
    steps = int(math.ceil(period * 4.0))
    best = (0.0, 0.0)
    n = len(env)
    for s in range(steps):
        phase = s * 0.25
        cnt = int(math.floor((n - 2 - phase) / period)) + 1 if n - 2 - phase > 0 else 0
        t = phase + period * np.arange(max(cnt, 0))
        t = t[t.astype(int) + 2 < n]
        if len(t) == 0:
            v = 0.0
        else:
            i = np.floor(t + 0.5).astype(int)
            v = _at3(env, i).sum() / len(t)
        if v > best[0]:
            best = (v, phase)
    return best[0] / mean, best[1]


def offbeat_ratio(env, fr, bpm, phase, frac):
    period = 60.0 * fr / bpm
    n = len(env)
    on = off = 0.0
    t = phase
    while t + period < n - 2.0:
        for tt, which in ((t, 0), (t + period * frac, 1)):
            i = _rnd(tt)
            v = 0.0 if i + 1 >= n else max(env[i], env[max(i - 1, 0)], env[i + 1])
            if which == 0:
                on += v
            else:
                off += v
        t += period
    return 0.0 if on <= 1e-9 else off / on


def alternate_ratio(env, fr, bpm, phase):
    """Weaker of the even / odd beats of a grid divided by the stronger (1 = all beats alike)."""
    period = 60.0 * fr / bpm
    n = len(env)
    sums = [0.0, 0.0]
    t, k = phase, 0
    while _rnd(t) + 1 < n:
        i = _rnd(t)
        sums[k % 2] += max(env[i], env[max(i - 1, 0)], env[i + 1])
        k += 1
        t += period
    hi = max(sums)
    return 1.0 if hi <= 1e-9 else min(sums) / hi


def refine_tempo(env, fr, bpm):
    period = 60.0 * fr / bpm
    _, phase = pulse_fit(env, fr, bpm)
    srt = np.sort(env)[::-1]
    k = max(len(srt) // 20, 1)
    peak_mean = srt[:k].mean()
    n = len(env)
    for _ in range(3):
        pts = []
        k = 0
        while True:
            c = phase + k * period
            if c + period * 0.25 + 2.0 >= n:
                break
            lo = int(max(c - period * 0.2, 1.0))
            hi = int(c + period * 0.2)
            seg = env[lo : min(hi, n - 2) + 1]
            bi = lo + int(np.argmax(seg)) if len(seg) else lo
            v = env[bi]
            if v > peak_mean * 0.25 and bi > 0:
                a, b, cc = env[bi - 1], v, env[bi + 1]
                den = a - 2 * b + cc
                off = min(max(0.5 * (a - cc) / den, -0.5), 0.5) if abs(den) > 1e-12 else 0.0
                pts.append((k, bi + off, v))
            k += 1
        if len(pts) < 4:
            break
        P = np.array(pts)
        w = P[:, 2].sum()
        mx = (P[:, 0] * P[:, 2]).sum() / w
        my = (P[:, 1] * P[:, 2]).sum() / w
        num = (P[:, 2] * (P[:, 0] - mx) * (P[:, 1] - my)).sum()
        den = (P[:, 2] * (P[:, 0] - mx) ** 2).sum()
        if den <= 0:
            break
        np_ = num / den
        if abs(np_ / period - 1.0) > 0.03:
            break
        period = np_
        phase = my - np_ * mx
    return 60.0 * fr / period


def fold(bpm, lo=None, hi=None):
    """Fold a tempo into [lo, hi) by doubling/halving (a DJ 'BPM range')."""
    if lo is None or bpm <= 0:
        return bpm
    while bpm < lo - 1e-6:
        bpm *= 2
    while bpm >= hi + 1e-6:
        bpm /= 2
    return bpm


def estimate_tempo(env, body, fr, bpm_range=None):
    max_lag = int(60.0 * fr / MIN_BPM * 8.0) + 4
    ac = autocorr(env, min(max_lag, len(env) - 1))
    multiples = 8
    scan = []
    b = MIN_BPM
    while b <= MAX_BPM:
        scan.append((b, max(tempo_score(ac, fr, b, multiples), 0.0)))
        b += 0.25
    peaks = [scan[i] for i in range(1, len(scan) - 1)
             if scan[i][1] >= scan[i - 1][1] and scan[i][1] >= scan[i + 1][1] and scan[i][1] > 0]
    if not peaks:
        return {"bpm": 120.0, "confidence": 0.0, "alternatives": []}
    cands = []
    for bpm, s in peaks:
        fit, _ = pulse_fit(env, fr, bpm)
        cands.append((bpm, s, s * prior(bpm) * math.sqrt(max(fit, 0.0))))
    cands.sort(key=lambda c: c[2], reverse=True)
    best = cands[0][0]

    _, ph = pulse_fit(body, fr, best)
    # 2:3 check: strong onsets at 1/3 and 2/3 of each beat mean three real beats were
    # grouped into two (e.g. 128 read as 85.3)
    r13 = offbeat_ratio(body, fr, best, ph, 1.0 / 3.0)
    r23 = offbeat_ratio(body, fr, best, ph, 2.0 / 3.0)
    if min(r13, r23) > THIRDS_UP and best * 1.5 <= 200:
        best *= 1.5
    _, ph = pulse_fit(body, fr, best)
    r_off = offbeat_ratio(body, fr, best, ph, 0.5)
    if r_off > OFFBEAT_DOUBLE and best * 2 <= 200:
        best *= 2
    elif r_off <= OFFBEAT_DOUBLE and best / 2 >= 60 and alternate_ratio(body, fr, best, ph) < ALT_BEAT_HALVE:
        best /= 2  # every other beat of this grid is much weaker: the real pulse is half as fast

    best = refine_tempo(env, fr, best)
    if abs(best - round(best)) < SNAP:
        best = float(round(best))

    best_score = tempo_score(ac, fr, best, multiples)
    fit, _ = pulse_fit(env, fr, best)
    score_c = min(max((best_score - 0.08) / 0.4, 0.0), 1.0)
    fit_c = min(max((fit - 4.0) / 6.0, 0.0), 1.0)
    confidence = 0.75 * score_c + 0.25 * fit_c

    lo, hi = bpm_range if bpm_range else (None, None)
    folded = fold(best, lo, hi)
    top = max(cands[0][2], 1e-9)
    alts = []
    for c in cands:
        f = fold(c[0], lo, hi)
        if abs(f - folded) / folded < 0.03 or any(abs(a[0] - f) / f < 0.03 for a in alts):
            continue
        alts.append((f, min(max(c[2] / top, 0.0), 1.0)))
        if len(alts) >= 3:
            break
    for alt in (folded * 2, folded / 2):
        if 50 <= alt <= 240 and not any(abs(a[0] - alt) / alt < 0.03 for a in alts):
            alts.append((alt, 0.0))
    return {"bpm": folded, "confidence": confidence, "alternatives": alts}


# ---------------------------------------------------------------------------
# 8. Key
# ---------------------------------------------------------------------------

def chromagram(x, sr):
    KW, KH = 8192, 4096
    hz = sr / KW
    b = np.arange(1, KW // 2)
    f = b * hz
    ok = (f >= 50.0) & (f <= 2100.0)
    b, f = b[ok], f[ok]
    midi = 69.0 + 12.0 * np.log2(f / 440.0)
    nearest = np.floor(midi + 0.5)
    w = np.maximum(1.0 - np.abs(midi - nearest) * 2.0, 0.0) ** 2
    keep = w > 0
    b, w, pc = b[keep], w[keep], (nearest[keep].astype(int) % 12)
    M = np.zeros((len(b), 12))
    M[np.arange(len(b)), pc] = w
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(KW) / KW)
    chroma = np.zeros(12)
    n = len(x)
    start = 0
    while start + KW <= max(n, KW):
        seg = np.zeros(KW)
        piece = x[start : start + KW]
        seg[: len(piece)] = piece
        mag = np.abs(np.fft.rfft(seg * window))[b]
        c = mag @ M
        tot = c.sum()
        if tot > 1e-6:
            chroma += np.sqrt(c / tot)
        start += KH
        if n < KW:
            break
    return chroma / max(chroma.max(), 1e-9)


def detect_key(chroma):
    """[(tonic pitch class, minor?, correlation), ...] best first, all 24 keys."""
    scores = []
    for tonic in range(12):
        for minor in (False, True):
            prof = np.roll(MINOR_PROFILE if minor else MAJOR_PROFILE, tonic)
            r = np.corrcoef(chroma, prof)[0, 1] if chroma.std() > 0 else 0.0
            scores.append((tonic, minor, float(r)))
    scores.sort(key=lambda s: s[2], reverse=True)
    return scores


def key_name(pc, minor):
    return f"{KEY_NAMES[pc % 12]} {'minor' if minor else 'major'}"


def wheel_number(pc, minor):
    return (7 * pc + 4) % 12 + 1 if minor else (7 * pc + 7) % 12 + 1


def wheel_code(pc, minor):
    """Harmonic-mixing wheel code, e.g. A minor -> '8A', C major -> '8B'."""
    return f"{wheel_number(pc, minor)}{'A' if minor else 'B'}"


def harmonic_distance(a, b):
    """0 = same key, 1 = mixes smoothly (wheel neighbour or A/B partner), None = clash."""
    na, nb = wheel_number(*a), wheel_number(*b)
    d = min((na - nb) % 12, (nb - na) % 12)
    if a[1] == b[1]:
        return {0: 0, 1: 1}.get(d)
    return 1 if d == 0 else None


# ---------------------------------------------------------------------------
# Everything at once
# ---------------------------------------------------------------------------

def analyse(x, sr, bpm_range=None):
    """Full analysis of mono audio. bpm_range=(lo, hi) folds the BPM like a DJ app's range setting."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    xd, dsr = prepare(x, sr)
    onset, low, body, bands, fr = spectral(xd, dsr)
    t = estimate_tempo(onset, body, fr, bpm_range)
    bpm = t["bpm"]

    _, phase = pulse_fit(onset, fr, bpm)
    period = 60.0 * fr / bpm
    first = phase
    while first - period >= 0.0:
        first -= period
    frame_time = lambda f: (f * HOP + WIN / 2.0) / dsr
    down = [0.0] * 4
    k, tpos = 0, first
    while int(tpos) + 2 < len(low):
        i = _rnd(tpos)
        down[k % 4] += max(low[i], low[i + 1])
        k += 1
        tpos += period
    downbeat = int(np.argmax(down))
    first_beat = max(frame_time(first), 0.0)

    chroma = chromagram(xd, dsr)
    keys = detect_key(chroma)
    (pc, minor, strength), alt = keys[0], keys[1]

    rms = math.sqrt(float(np.mean(x ** 2))) if len(x) else 0.0
    loud_db = 20 * math.log10(max(rms, 1e-9))
    tot = bands.sum(axis=0)
    brightness = tot[2] / (tot.sum() + 1e-12)
    loud_n = min(max((loud_db + 24) / 18, 0), 1)
    tempo_n = min(max((bpm - 70) / 110, 0), 1)
    dens_n = min(max(onset.mean() / 2, 0), 1)
    bright_n = min(max(brightness * 4, 0), 1)
    energy = int(min(max(round(1 + (0.4 * loud_n + 0.25 * tempo_n + 0.2 * dens_n + 0.15 * bright_n) * 9), 1), 10))

    return {
        "bpm": round(bpm, 2),
        "confidence": round(t["confidence"], 3),
        "alternatives": [round(a[0], 2) for a in t["alternatives"]],
        "first_beat": round(first_beat, 4),
        "downbeat": downbeat,
        "first_downbeat": round(first_beat + downbeat * 60.0 / bpm, 4),
        "key": key_name(pc, minor),
        "key_pc": pc,
        "key_minor": minor,
        "wheel": wheel_code(pc, minor),
        "key_strength": round(strength, 3),
        "key_alt": key_name(alt[0], alt[1]),
        "chroma": [round(float(c), 3) for c in chroma],
        "energy": energy,
        "loudness_db": round(loud_db, 1),
        "duration": round(len(x) / sr, 2),
        "version": __version__,
    }


def tempo(x, sr=11025):
    """Drop-in for Wax finder's bpm.tempo(x): BPM rounded to 0.1, or None if too short / no beat."""
    if len(x) < sr * 8:
        return None
    xd, dsr = prepare(np.asarray(x, dtype=np.float64), sr)
    onset, _, body, _, fr = spectral(xd, dsr)
    if not onset.any():
        return None
    t = estimate_tempo(onset, body, fr)
    if t["confidence"] < 0.05:
        return None
    return round(t["bpm"], 1)


def key(x, sr=11025):
    """(key name, wheel code, strength) or None."""
    if len(x) < sr * 4:
        return None
    xd, dsr = prepare(np.asarray(x, dtype=np.float64), sr)
    pc, minor, r = detect_key(chromagram(xd, dsr))[0]
    return key_name(pc, minor), wheel_code(pc, minor), round(r, 3)


if __name__ == "__main__":
    import json
    import sys
    import wave

    for path in sys.argv[1:]:
        with wave.open(path, "rb") as w:
            sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(w.getnframes())
        dt = {1: np.int8, 2: np.int16, 4: np.int32}[sw]
        a = np.frombuffer(raw, dtype=dt).astype(np.float64) / float(np.iinfo(dt).max)
        if ch > 1:
            a = a.reshape(-1, ch).mean(axis=1)
        r = analyse(a, sr)
        r.pop("chroma")
        print(json.dumps({"file": path, **r}))
