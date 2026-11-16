"""Local audio analysis for DJ prep: BPM, key (Camelot), swing, energy per 8 bars, sections."""
import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import butter, sosfilt
import tempo_consensus
import tempo_arbiter

VERSION = 4  # multi-window tempo evidence before full-track grid fitting
SR = 22050
HOP = 512
CACHE = Path(__file__).resolve().parent / "cache" / "tracks"

NOTES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
ALIASES = {"C#": "Db", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb"}
CAMELOT_MAJ = {0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
               6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B"}
CAMELOT_MIN = {9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A",
               3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A"}
# Key profiles, index 0 = tonic. Kostka-Payne beat Krumhansl-Kessler against Rekordbox on
# the 38-track Post office H2 test (19 vs 14 exact) - see validate.py
KK_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KP_MAJ = np.array([.748, .060, .488, .082, .670, .460, .096, .715, .104, .366, .057, .400])
KP_MIN = np.array([.712, .084, .474, .618, .049, .460, .105, .747, .404, .067, .133, .330])


def camelot(key_name):
    """'Fm' -> '4A', 'Eb' -> '5B'. Returns None for anything unparseable."""
    if not key_name:
        return None
    minor = key_name.endswith("m")
    root = key_name[:-1] if minor else key_name
    root = ALIASES.get(root, root)
    if root not in NOTES:
        return None
    pc = NOTES.index(root)
    return (CAMELOT_MIN if minor else CAMELOT_MAJ)[pc]


def camelot_relation(a, b):
    """How two Camelot codes mix: perfect / adjacent / relative / boost / clash."""
    if not a or not b:
        return "unknown"
    na, la, nb, lb = int(a[:-1]), a[-1], int(b[:-1]), b[-1]
    step = min((na - nb) % 12, (nb - na) % 12)
    if a == b:
        return "perfect"
    if la == lb and step == 1:
        return "adjacent"
    if na == nb:
        return "relative"
    if la == lb and step == 2:
        return "boost"
    return "clash"


def _mmss(s):
    return f"{int(s // 60)}:{int(s % 60):02d}"


def _load(path):
    try:
        y, _ = librosa.load(path, sr=SR, mono=True)
    except Exception:
        # librosa could not read it (m4a/aac/alac): decode to a temporary WAV. The Mac's own CoreAudio first, then the
        # ffmpeg that comes with Waxfinder (imageio-ffmpeg), which is what Windows and Linux use.
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "decoded.wav")
            try:
                subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(path), wav], check=True, capture_output=True)
            except (OSError, subprocess.CalledProcessError):
                import imageio_ffmpeg
                subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-i", str(path), "-ac", "1", "-ar", str(SR), wav], check=True, capture_output=True)
            y, _ = librosa.load(wav, sr=SR, mono=True)
    return y


def _tempo(onset, bpm_hint=None):
    """Track beats, then fit a straight line through them for a precise BPM."""
    options = {'bpm': bpm_hint} if bpm_hint else {'start_bpm': 120}
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP, **options)
    t = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    if len(t) < 16:
        return None
    ibi = np.diff(t)
    m = np.median(ibi)
    # count beats cumulatively so skipped beats don't shift the index
    n = np.concatenate([[0], np.cumsum(np.maximum(1, np.round(ibi / m)))])
    keep = np.ones(len(t), bool)
    for _ in range(3):
        P, a = np.polyfit(n[keep], t[keep], 1)
        keep = np.abs(t - (a + P * n)) < 0.1 * P
        if keep.sum() < 16:
            P, a = np.polyfit(n, t, 1)
            break
    local = [60 / np.polyfit(n[i:i + 33], t[i:i + 33], 1)[0]
             for i in range(0, len(t) - 32, 16) if n[i + 32] - n[i] == 32]
    return t, _comb_refine(onset, P), keep.mean(), local


def _comb_refine(onset, P):
    """Fine-tune the beat period (+-1%) so one fixed grid best lines up with every onset."""
    fps = SR / HOP
    env = np.convolve(onset, np.hanning(5), mode="same")
    frames = np.arange(len(env))
    dur = len(env) / fps
    best, best_p = -1.0, P
    for p in np.linspace(P * 0.99, P * 1.01, 201):
        n = np.arange(0, dur / p - 1)
        phases = np.linspace(0, p, 24, endpoint=False)[:, None]
        score = np.interp((phases + n * p) * fps, frames, env).sum(axis=1).max()
        if score > best:
            best, best_p = score, p
    return best_p


def _complete_beats(t, P, dur):
    """Fill gaps in the tracked beats and extend the grid to the start and end."""
    out = [t[0]]
    for x in t[1:]:
        prev, gap = out[-1], x - out[-1]
        k = max(1, int(round(gap / P)))
        out.extend(prev + j * gap / k for j in range(1, k))
        out.append(x)
    head = np.arange(out[0] - P, 0, -P)[::-1]
    tail = np.arange(out[-1] + P, dur, P)
    return np.concatenate([head, out, tail])


def _downbeat_offset(beats, chroma, low_on):
    """Pick which of every 4 beats is the 1: harmonic change + bass hit."""
    bf = np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, chroma.shape[1] - 1)
    cs = librosa.util.sync(chroma, bf, aggregate=np.median)
    nov = np.linalg.norm(np.diff(cs, axis=1), axis=0)[: len(bf)]
    low = low_on[bf]
    n = min(len(nov), len(low)); nov, low = nov[:n], low[:n]   # beats clipped at the very end can leave these one apart
    z = lambda v: (v - v.mean()) / (v.std() + 1e-9)
    score = z(nov) + z(low)
    return int(np.argmax([score[k::4].mean() for k in range(4)]))


def key_scores(prof, maj=KP_MAJ, mnr=KP_MIN):
    scores = []
    for pc in range(12):
        scores.append((np.corrcoef(prof, np.roll(maj, pc))[0, 1], NOTES[pc]))
        scores.append((np.corrcoef(prof, np.roll(mnr, pc))[0, 1], NOTES[pc] + "m"))
    return scores


def _key(prof):
    scores = key_scores(prof)
    scores.sort(reverse=True)
    gap = scores[0][0] - scores[1][0]
    conf = "high" if gap > 0.06 else "medium" if gap > 0.02 else "low"
    return scores[0][1], scores[1][1], conf


def _swing(y, beats):
    """MPC-style swing %: where the 2nd/4th 16th hats land between the 8ths (50 = straight)."""
    sos = butter(4, 5000, "highpass", fs=SR, output="sos")
    hop = 64
    env = librosa.feature.rms(y=sosfilt(sos, y), frame_length=256, hop_length=hop)[0]
    le = np.log(env + 1e-6)
    on = np.maximum(0, np.diff(le, prepend=le[0]))

    def peak(t0, t1):
        i0, i1 = max(0, int(t0 * SR / hop)), int(t1 * SR / hop) + 1
        seg = on[i0:i1]
        if len(seg) < 3:
            return None, 0.0
        j = int(np.argmax(seg))
        d = 0.0
        if 0 < j < len(seg) - 1:
            a, b, c = seg[j - 1], seg[j], seg[j + 1]
            den = a - 2 * b + c
            d = 0.5 * (a - c) / den if den else 0.0
        return (i0 + j + d) * hop / SR, seg[j]

    pairs = []
    for b0, b1 in zip(beats[:-1], beats[1:]):
        P = b1 - b0
        p = [peak(b0 + lo * P, b0 + hi * P)
             for lo, hi in ((-0.08, 0.08), (0.17, 0.40), (0.42, 0.58), (0.67, 0.90))]
        pairs.append((p[0], p[1], P))
        pairs.append((p[2], p[3], P))
    strengths = [s for (_, s0), (_, s1), _ in pairs for s in (s0, s1)]
    if not strengths:
        return None
    thr = 0.25 * np.percentile(strengths, 90)
    ratios = [(t1 - t0) / P for (t0, s0), (t1, s1), P in pairs
              if t0 is not None and t1 is not None and s0 > thr and s1 > thr]
    ratios = [r for r in ratios if 0.18 <= r <= 0.40]
    if len(ratios) < 32:
        return None
    return int(round(float(np.median(ratios)) * 200))


def _analyze(path):
    y = _load(path)
    dur = len(y) / SR
    S = np.abs(librosa.stft(y, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR)
    low_band = freqs < 150
    power = (S ** 2).mean(axis=0)
    low_power = (S[low_band] ** 2).sum(axis=0)
    frame_db = 10 * np.log10(power + 1e-12)

    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S), sr=SR, hop_length=HOP)
    low_on = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S[low_band]), sr=SR,
                                          hop_length=HOP)
    y_h = librosa.effects.harmonic(y, margin=2)
    chroma = librosa.feature.chroma_cqt(y=y_h, sr=SR, hop_length=HOP)

    res = {"file": os.path.basename(path), "duration": _mmss(dur),
           "level_db": round(float(10 * np.log10(np.mean(y ** 2) + 1e-12)), 1)}
    loud = frame_db > np.percentile(frame_db, 30)
    prof = chroma[:, loud].mean(axis=1)
    res["_chroma"] = [round(float(v), 4) for v in prof]  # lets key maths be re-scored from cache
    key, alt, conf = _key(prof)
    res.update(key=key, camelot=camelot(key), key_confidence=conf)
    if conf == "low":
        res["key_alt"] = f"{alt} ({camelot(alt)})"

    evidence = tempo_consensus.estimate(y, SR)
    # second opinion from the export engine's own tracker: a pattern period (2/3, 4/5 of the beat) can win all three windows
    seed, confidence, note = tempo_arbiter.arbitrate(evidence['bpm'], evidence['confidence'],
                                                     tempo_arbiter.second_opinion(path))
    if note:
        evidence = {**evidence, 'arbiter': note}
    evidence['seed'] = seed
    tempo = _tempo(onset, bpm_hint=seed)
    res.update(analysis_version=VERSION, bpm_confidence=confidence,
               bpm_evidence=evidence)
    if tempo is None:
        res["bpm"] = None
        res["note"] = "no steady beat found"
        return res
    t, P, _, local = tempo
    bpm = 60 / P
    if not seed and bpm < 88:  # legacy fallback, explicitly low-confidence
        bpm, P = bpm * 2, P / 2
        t = np.sort(np.concatenate([t, (t[:-1] + t[1:]) / 2]))
        local = [x * 2 for x in local]
    elif not seed and bpm >= 176:
        bpm, P, t = bpm / 2, P * 2, t[::2]
        local = [x / 2 for x in local]
    res["bpm"] = round(bpm, 2)
    if local:
        lo, hi = np.percentile(local, [10, 90])
        if hi - lo > 1.0:
            res["bpm_note"] = f"live drums: drifts {lo:.1f}-{hi:.1f}"

    beats = _complete_beats(t, P, dur)
    res["swing"] = _swing(y, beats)
    if res["swing"] is not None:
        s = res["swing"]
        res["feel"] = ("straight" if s < 53 else "light swing" if s < 57
                       else "swung" if s < 62 else "heavy shuffle")

    # 8-bar phrases from the first downbeat
    off = _downbeat_offset(beats, chroma, low_on)
    edges = [beats[i] for i in range(off, len(beats), 32)]
    edges[0] = 0.0
    edges.append(dur)
    if len(edges) > 2 and edges[-1] - edges[-2] < 4 * P:
        edges.pop(-2)
    ft = librosa.frames_to_time(np.arange(S.shape[1]), sr=SR, hop_length=HOP)
    rms_db, low_db = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        sel = (ft >= a) & (ft < b)
        rms_db.append(10 * np.log10(power[sel].mean() + 1e-12))
        low_db.append(10 * np.log10(low_power[sel].mean() + 1e-12))
    rms_db, low_db = np.array(rms_db), np.array(low_db)
    energy = np.clip(np.round(10 + ((rms_db - rms_db.max()) + (low_db - low_db.max())) / 3), 1, 10)
    res["energy_per_8_bars"] = " ".join(str(int(e)) for e in energy)

    main_low = np.percentile(low_db, 75)
    full = low_db >= main_low - 4
    first, last = int(np.argmax(full)), len(full) - 1 - int(np.argmax(full[::-1]))
    labels = ["intro" if i < first else "outro" if i > last else "main" if full[i] else "break"
              for i in range(len(full))]
    for i in range(1, len(labels) - 1):  # rising last phrase of a breakdown = build
        if labels[i] == "break" and labels[i - 1] == "break" and labels[i + 1] == "main" \
                and rms_db[i] > rms_db[i - 1] + 1.0:
            labels[i] = "build"
    sections = []
    for i, lab in enumerate(labels):
        bars = int(round((edges[i + 1] - edges[i]) / (4 * P)))
        if sections and sections[-1][0] == lab:
            sections[-1][2] += bars
        else:
            sections.append([lab, edges[i], bars])
    res["sections"] = " | ".join(f"{lab} {_mmss(s)} {b}b" for lab, s, b in sections)
    mains = [s for s in sections if s[0] == "main"]
    if mains:
        res["mix_in"] = _mmss(mains[0][1])
        outro = [s for s in sections if s[0] == "outro"]
        res["mix_out"] = _mmss(outro[0][1]) if outro else _mmss(dur)
    return res


def _cache_file(path):
    st = os.stat(path)
    h = hashlib.sha1(f"{path}|{st.st_size}|{int(st.st_mtime)}|{VERSION}".encode()).hexdigest()
    return CACHE / f"{h}.json"


def cached(path):
    try:
        cf = _cache_file(os.path.expanduser(path))
    except OSError:
        return None
    return json.loads(cf.read_text()) if cf.exists() else None


def analyze(path, use_cache=True):
    path = os.path.expanduser(str(path))
    cf = _cache_file(path)
    if use_cache and cf.exists():
        return json.loads(cf.read_text())
    res = _analyze(path)
    CACHE.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(res))
    return res


def _safe_analyze(path):
    try:
        # workers share the MCP server's stdout pipe; keep stray prints off it
        with contextlib.redirect_stdout(sys.stderr):
            return analyze(path)
    except Exception as e:  # one bad file shouldn't sink a whole playlist
        return {"file": os.path.basename(path), "error": f"{type(e).__name__}: {e}"}


def analyze_many(paths, workers=4):
    with ProcessPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(_safe_analyze, paths))


if __name__ == "__main__":
    import time
    for p in sys.argv[1:]:
        t0 = time.time()
        print(json.dumps(analyze(p, use_cache=False)), f"[{time.time() - t0:.1f}s]")
