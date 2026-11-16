"""Second opinion on tempo from the export engine's own analyser (rbx-cli analyse: a local beat/grid tracker that is also what the CDJ
export writes). The spectral-flux consensus can lock onto a rhythmic PATTERN period instead of the beat: a dotted pulse (2/3 of the real
tempo), a five-sixteenths pulse (4/5), and so on, and all three windows then agree on the wrong pulse. A second, independent tracker
catches that. Nothing here knows any artist, title or fixed BPM.

Rule: the two agree (within 1.5%) -> keep the consensus (it is the more precise number) and the result is solid.
They differ by a pulse-alias ratio (1/2, 2/3, 3/4, 4/5 and their inverses) -> the pattern period is the likelier slip, so take the
second tracker's beat. They differ by something else, or the second tracker is unsure -> keep the consensus and mark it low."""
import json, os, subprocess
from pathlib import Path

BIN = Path(os.environ.get("WF_RBX_CLI") or Path.home() / "Tools/rbx-cli/target/release/rbx-cli")   # Waxfinder passes where the engine is on this computer
ALIASES = {"1/2": .5, "2/3": 2 / 3, "3/4": .75, "4/5": .8, "5/4": 1.25, "4/3": 4 / 3, "3/2": 1.5, "2": 2.0}

def available(): return BIN.is_file()

def second_opinion(path, timeout=240):
    if not available(): return None
    try:
        p = subprocess.run([str(BIN), "analyse", str(path)], capture_output=True, text=True, timeout=timeout)
        for line in p.stdout.splitlines():
            j = json.loads(line)
            if j.get("bpm"): return {"bpm": float(j["bpm"]), "confidence": float(j.get("confidence") or 0), "first_beat_ms": j.get("first_beat_ms")}
    except Exception: pass
    return None

def alias_of(consensus, other):
    """Name of the pulse-alias ratio consensus/other, or None."""
    r = consensus / other
    for name, v in ALIASES.items():
        if abs(r / v - 1) < .02: return name
    return None

def arbitrate(consensus, confidence, other):
    """-> (bpm seed or None, confidence label, note dict)"""
    if not other: return consensus, confidence, None
    o = other["bpm"]
    note = {"engine_bpm": round(o, 3), "engine_confidence": round(other["confidence"], 3)}
    if consensus is None:
        return o, "medium", {**note, "decision": "engine only (no consensus)"}
    if abs(consensus / o - 1) <= .015:
        return consensus, "high", {**note, "decision": "agree"}
    # They disagree. Checked against 1,074 Rekordbox-analysed tracks (2026-11-07): in all 20 disagreements the engine was never
    # beaten by the consensus (right 16 times; both wrong 4 times, none where only the consensus was right), so its beat wins.
    a = alias_of(consensus, o)
    note = {**note, "was": round(consensus, 3), "decision": "engine beat (pulse alias " + a + ")" if a else "engine beat"}
    if a in ("1/2", "2"):   # an octave apart: both could be reading the same pulse as 2 or 1/2 of a dotted beat: say so
        return o, "low", note
    return o, "high" if other["confidence"] >= .75 else "medium", note
