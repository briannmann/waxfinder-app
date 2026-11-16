"""Second-opinion BPM from the open-source realtime-bpm-analyzer (vendor/rtbpm, Apache-2.0). Fast (~10 ms to analyse; decoding dominates).
Measured with ./bpm-compare: about as accurate as bpm.py on its own, but where the two AGREE they are right 99% of the time.
Needs `node` on PATH; without it available() is False and callers just skip this reading."""
import json, shutil, subprocess
from pathlib import Path

HERE = Path(__file__).parent / "vendor" / "rtbpm"
SR = 44100

def available(): return bool(shutil.which("node") and (HERE / "node.mjs").is_file())

def estimate(ffmpeg, src, start=45, dur=30, timeout=40):
    """BPM (to 2 decimals) from a 30 s clip, or None."""
    if not available(): return None
    try:
        pcm = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-ss", str(start), "-t", str(dur), "-i", str(src), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                             capture_output=True, timeout=timeout).stdout
        if len(pcm) < SR * 4 * 8: return None
        out = subprocess.run(["node", str(HERE / "run.mjs"), str(SR)], input=pcm, capture_output=True, timeout=timeout).stdout
        t = json.loads(out)
        return round(float(t[0]["tempo"]), 2) if t else None
    except Exception: return None
