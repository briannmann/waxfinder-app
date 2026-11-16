"""Independent tempo evidence across three parts of a local audio file.

Spectral-flux autocorrelation includes multiple beat periods so a strong dotted
rhythm cannot win solely because one onset tracker picked that pulse first.
No artist/title lookup or hard-coded BPM correction is used.
"""
import numpy as np
from scipy.signal import resample_poly
from math import gcd

SR, HOP, WIN = 11025, 64, 1024
VERSION = 1


def window_tempo(x):
    if len(x) < SR * 8:
        return None
    frames = np.lib.stride_tricks.sliding_window_view(x, WIN)[::HOP]
    window = np.hanning(WIN).astype(np.float32)
    flux = []
    previous = None
    for start in range(0, len(frames), 512):
        mag = np.abs(np.fft.rfft(frames[start:start+512] * window, axis=1))[:, 1:200]
        mag = np.log1p(100 * mag)
        if previous is not None:
            mag = np.concatenate([previous[None, :], mag])
        flux.append(np.maximum(np.diff(mag, axis=0), 0).sum(axis=1))
        previous = mag[-1]
    flux = np.concatenate(flux)
    fps = SR / HOP
    k = int(fps * .4)
    flux = np.maximum(flux - np.convolve(flux, np.ones(k) / k, mode='same'), 0)
    if not flux.any():
        return None
    f = np.fft.rfft(flux, 2 * len(flux))
    ac = np.fft.irfft(f * np.conj(f))[:len(flux)]
    lags = np.arange(int(fps * 60 / 185), int(fps * 60 / 68) + 1)
    bpms = 60 * fps / lags
    prior = np.exp(-.5 * (np.log2(bpms / 122) / .9) ** 2)
    strengths = sum(weight * ac[np.minimum(lags * multiple, len(ac)-1)]
                    for multiple, weight in [(1, 1), (2, .5), (4, .25)])
    lag = int(lags[np.argmax(strengths * prior)])
    if 1 <= lag < len(ac)-1:
        a, b, c = ac[lag-1:lag+2]
        correction = (a-c)/(2*(a-2*b+c)) if a-2*b+c else 0
        lag += float(np.clip(correction, -.5, .5))
    return float(60 * fps / lag)


def estimate(y, sr):
    """Return a seed only when at least two independent windows agree."""
    sr = int(sr)
    duration = len(y) / sr
    starts = sorted(set(max(0, min(duration - 30, duration * f)) for f in (.15, .45, .75)))
    estimates = []
    common = gcd(sr, SR)
    for start in starts:
        audio = np.asarray(y[int(start*sr):int((start+30)*sr)], dtype=np.float32)
        if sr != SR:
            audio = resample_poly(audio, SR//common, sr//common)
        bpm = window_tempo(audio)
        if bpm:
            estimates.append(bpm)
    clusters = [[other for other in estimates if abs(other-bpm) <= .5] for bpm in estimates]
    best = max(clusters, key=lambda c: (len(c), -np.ptp(c)), default=[])
    agreed = len(best) >= 2
    return {'bpm': float(np.median(best)) if agreed else None,
            'confidence': 'high' if agreed and len(best) == len(estimates) and len(best) >= 3 else 'medium' if agreed else 'low',
            'window_bpms': [round(x, 3) for x in estimates],
            'agreement': len(best), 'windows': len(estimates), 'version': VERSION}
