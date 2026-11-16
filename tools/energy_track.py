"""Energy features for one track, after Mixed In Key's patent US8865993 (personal use).
Run with the AudioIntel venv: energy_track.py <path> <bpm> [first_beat_seconds]  -> one JSON line.

A-weighted spectrum, level-matched to its 95th-percentile frame loudness, split by median filters into
transients (hits) and ambient (sustained sound). The beat grid is re-fitted every 8 bars so tempo drift
can't smear it. Each 8-bar (32-beat) section gets one feature vector; scoring happens in energy.py."""
import json, sys
import numpy as np, librosa
from scipy.ndimage import maximum_filter1d

V = 1
SR, NFFT, HOP = 22050, 1024, 341                 # ~15.5 ms frames (patent: 2048 / 682 at 44.1 kHz)
GROUPS = {"all": (0, 11025), "low": (0, 180), "mid": (180, 2500), "high": (2500, 11025)}
NAMES = ([f"hit_{g}" for g in GROUPS] + ["hit_density", "offgrid"] + [f"amb_{g}" for g in GROUPS]
         + ["rec_q", "rec_h", "rec_b", "perc_level"])


def features(path, bpm, first_beat=None):
    y, _ = librosa.load(path, sr=SR, mono=True)
    S = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP))
    f = librosa.fft_frequencies(sr=SR, n_fft=NFFT)
    S *= librosa.db_to_amplitude(librosa.A_weighting(f))[:, None]            # weight to the ear
    S /= np.percentile(np.sqrt((S ** 2).mean(0)), 95) + 1e-9                 # level-match like a trim
    H, P = librosa.decompose.hpss(S, kernel_size=(13, 31))                   # ambient (time median 13) / transients
    bands = {g: (f >= lo) & (f < hi) for g, (lo, hi) in GROUPS.items()}
    Pdb = librosa.power_to_db(P ** 2, ref=1.0, top_db=None)
    on = {g: np.maximum(0, np.diff(Pdb[m], axis=1, prepend=Pdb[m][:, :1])).mean(0) for g, m in bands.items()}
    amb = {g: 10 * np.log10((H[m] ** 2).sum(0) + 1e-10) for g, m in bands.items()}
    perc = 10 * np.log10((P ** 2).sum(0) + 1e-10)
    nfr = S.shape[1]; fps = SR / HOP
    w = max(1, int(round(.035 * fps)))                                       # +-35 ms tolerance around grid points
    env = {g: maximum_filter1d(o, 2 * w + 1, mode="nearest") for g, o in on.items()}

    T = 60.0 / bpm; seg_len = 32 * T
    start = first_beat if first_beat is not None else 0.0
    while start - seg_len > 0: start -= seg_len                              # whole segments back to the top
    if start < 0: start += seg_len
    segs, seg_t = [], []
    t0 = start
    while t0 + seg_len <= nfr / fps:
        # re-fit the beat phase within this segment (half a beat either way)
        cands = np.arange(-T / 2, T / 2, 1 / fps)
        beats = t0 + np.arange(32) * T
        def idx(ts): return np.clip(np.round(ts * fps).astype(int), 0, nfr - 1)
        best = max(cands, key=lambda d: env["all"][idx(beats + d)].sum())
        grid = idx(t0 + best + np.arange(256) * T / 8)                       # 1/8-beat points
        a = {g: env[g][grid] for g in env}
        six = slice(0, None, 2)                                              # 1/4-beat (16th) points
        ref = np.percentile(a["all"][0::8], 50) + 1e-6                       # this segment's typical beat hit
        v = [float(np.percentile(a[g][six], 90)) for g in GROUPS]
        v.append(float((a["all"][six] > .5 * ref).mean()))                   # share of 16ths with a real hit
        v.append(float(np.percentile(a["all"][1::2], 90)))                  # off-grid hits
        sl = slice(grid[0], grid[-1] + 1)
        v += [float(np.mean(amb[g][sl])) for g in GROUPS]
        x = a["all"] - a["all"].mean(); d = float((x * x).sum()) + 1e-9
        v += [float((x[:-L] * x[L:]).sum() / d) for L in (2, 4, 8)]          # recurrence at 1/4, 1/2, 1 beat
        v.append(float(np.mean(perc[sl])))
        segs.append([round(z, 4) for z in v]); seg_t.append(round(t0 + best, 2))
        t0 += seg_len
    return {"v": V, "names": NAMES, "bpm": bpm, "segs": segs, "seg_t": seg_t}


if __name__ == "__main__":
    p, b = sys.argv[1], float(sys.argv[2])
    fb = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] not in ("", "None") else None
    print(json.dumps(features(p, b, fb)))
