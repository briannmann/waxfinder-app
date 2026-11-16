"""Popularity penalty, tuned on your own votes: what separates your likes from your passes is how fast a video
piles up views (views per year online), not its total, so your old classics aren't punished like this year's chart pop."""
import math, time

def views_per_year(m):
    if not m or not m.get("views"): return None
    try: yrs = max(.5, (time.time() - time.mktime(time.strptime(m["up"], "%Y%m%d"))) / 31557600)
    except Exception: yrs = 3.0
    return m["views"] / yrs

def penalty(m):
    """0 for underground / steady classics, up to ~2.5 for fresh mega-hits on huge channels."""
    vpy = views_per_year(m)
    if vpy is None: return 0.0
    p = max(0.0, min(1.0, (math.log10(vpy) - math.log10(2e6)) / (math.log10(40e6) - math.log10(2e6)))) * 2.0
    f = m.get("followers") or 0
    if f > 5e6: p += 0.5                                   # giant artist / VEVO-size channels
    return p
