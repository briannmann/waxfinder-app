"""Small tempo estimator: 30 s of audio -> spectral-flux onset envelope -> autocorrelation -> BPM.
Self-contained (numpy + tempolab_analysis.py + the bundled ffmpeg), so it works on any machine. Tuned for club music (4/4)."""
import subprocess
import numpy as np

SR, HOP, WIN = 11025, 64, 1024

def decode(ffmpeg, src, start=45, dur=30, headers=None, timeout=40):
    cmd = [ffmpeg, "-v", "error", "-nostdin"]
    if headers: cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items())]
    cmd += ["-ss", str(start), "-t", str(dur), "-i", src, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=timeout).stdout
    return np.frombuffer(out, dtype=np.float32)

def tempo_coarse(x):
    if len(x) < SR * 8: return None
    n = 1 + (len(x) - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * np.hanning(WIN), axis=1))[:, 1:200]   # up to ~2 kHz: kick, bass, hats' body
    mag = np.log1p(100 * mag)
    flux = np.maximum(np.diff(mag, axis=0), 0).sum(axis=1)
    k = int(SR / HOP * .4)                                                      # remove slow loudness drift
    flux = flux - np.convolve(flux, np.ones(k) / k, mode="same")
    flux = np.maximum(flux, 0)
    if not flux.any(): return None
    f = np.fft.rfft(flux, 2 * len(flux))
    ac = np.fft.irfft(f * np.conj(f))[:len(flux)]
    fps = SR / HOP
    lags = np.arange(int(fps * 60 / 185), int(fps * 60 / 68) + 1)
    bpms = 60 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpms / 122) / 0.9) ** 2)                    # club music sits near 120-128
    # a true beat also lines up at 2x and 4x the lag: reward that so half/double errors lose
    def acl(L): return ac[np.clip(L, 0, len(ac) - 1)]
    strength = acl(lags) + .5 * acl(2 * lags) + .25 * acl(4 * lags)
    i = int(np.argmax(strength * prior))
    L = lags[i]
    if 1 <= L < len(ac) - 1:                                                    # parabolic refine for sub-frame lag
        a, b, c = ac[L - 1], ac[L], ac[L + 1]
        d = (a - c) / (2 * (a - 2 * b + c)) if (a - 2 * b + c) != 0 else 0
        L = L + max(-.5, min(.5, d))
    return round(60 * fps / L, 1)

def tempo(x):
    """Coarse reading, then Tempo Lab's beat-by-beat fine-tuning (nearer the exact BPM; measured with ./bpm-compare).
    Any problem in the fine step falls back to the coarse reading."""
    c = tempo_coarse(x)
    if not c: return c
    try:
        import tempolab_analysis as tla
        xd, dsr = tla.prepare(np.asarray(x, dtype=np.float64), SR)
        onset, _, _, _, fr = tla.spectral(xd, dsr)
        f = tla.refine_tempo(onset, fr, c)
        return round(f, 2) if abs(f - c) <= 1.0 else c
    except Exception: return c

def estimate(ffmpeg, src, headers=None, start=45):
    try: return tempo(decode(ffmpeg, src, start=start, headers=headers))
    except Exception: return None

def near(b, lo, hi):
    """How far a BPM sits outside [lo, hi], forgiving half/double-time reads. 0 = inside."""
    if not b: return 0
    return min(max(0, lo - x, x - hi) for x in (b, b * 2, b / 2))
