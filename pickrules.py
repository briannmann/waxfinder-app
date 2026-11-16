"""Version exclusions shared with Picks rendering; applies to suggestions only."""
import json
import re
from pathlib import Path

_RULE = json.loads((Path(__file__).parent / "static/pick-exclusions.json").read_text())
_EXCLUDED = re.compile(_RULE["pattern"], re.I)


def excluded_pick(item):
    title = item.get("title", "") if isinstance(item, dict) else item
    return bool(_EXCLUDED.search(title or ""))
