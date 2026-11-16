"""Where the outside helpers live on THIS computer, so nothing else hard-codes a path that only exists on one machine.

rbx-cli (the CDJ export / key / second-tempo engine, a separate GPL-2 program run as its own process) is looked for in:
  1. WF_RBX_CLI (environment variable: full path to the program)
  2. ~/Tools/rbx-cli/target/release/     (a build made on this computer)
  3. bin/<mac|win|linux>-<arm64|x64>/    (a ready-built copy shipped next to the app)
Missing = the features that need it switch themselves off (export button hidden, keys fall back to the built-in analyser)."""
import os, platform, sys
from pathlib import Path

HERE = Path(__file__).parent
WIN = sys.platform == "win32"

def rbx_cli():
    exe = "rbx-cli.exe" if WIN else "rbx-cli"
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    plat = {"darwin": "mac", "win32": "win"}.get(sys.platform, "linux") + "-" + arch
    built = Path.home() / "Tools" / "rbx-cli" / "target" / "release" / exe
    for p in (os.environ.get("WF_RBX_CLI"), built, HERE / "bin" / plat / exe):
        if p and Path(p).is_file(): return Path(p)
    return built   # not installed: callers test .is_file()

def gentle(n=10):
    """Command prefix that runs a background job at low priority ('nice' does not exist on Windows)."""
    return [] if WIN else ["nice", "-n", str(n)]
