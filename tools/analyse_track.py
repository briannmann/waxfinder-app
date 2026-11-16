"""Run by setbuild with the analyser's Python, cwd = the analyser folder (~/Tools/AudioIntel if installed, else analyser/ in this app): analyse one local file, print JSON.
Uses the analyser for BPM / key / sections / mix points, plus gain-matched features so energy compares across tracks.
Local files only - no network."""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, next((d for d in (str(Path.cwd()), str(Path.home() / "Tools/AudioIntel")) if (Path(d) / "analysis.py").is_file()), str(Path.cwd())))
import analysis, librosa

def feats(y):
    n = len(y); y = y[int(n * .2): int(n * .8)]          # body of the track
    y = y / (np.sqrt(np.mean(y ** 2)) + 1e-9)             # gain-match like a mixer trim
    S = np.abs(librosa.stft(y, hop_length=512)) ** 2
    f = librosa.fft_frequencies(sr=analysis.SR); tot = S.sum(0) + 1e-9
    on = librosa.onset.onset_strength(S=librosa.power_to_db(S), sr=analysis.SR)
    ons = librosa.onset.onset_detect(onset_envelope=on, sr=analysis.SR)
    return {"flux": float(on.mean()), "onset_rate": len(ons) / (len(y) / analysis.SR),
            "low": float((S[f < 120].sum(0) / tot).mean()), "high": float((S[f > 5000].sum(0) / tot).mean())}

p = sys.argv[1]
import os
res = analysis.analyze(p, use_cache=not os.environ.get('WF_FORCE'))   # WF_FORCE=1: re-run even if AudioIntel has a cached result (tools/bpmlab/retempo.py)
res.pop("_chroma", None)
res["feats"] = feats(analysis._load(p))
print(json.dumps(res))
