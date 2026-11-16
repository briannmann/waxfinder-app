# PyInstaller recipe for the Windows build (onedir; the installer wraps the dist\Waxfinder folder).
from PyInstaller.utils.hooks import collect_all, collect_submodules
datas, binaries, hidden = [], [], []
for pkg in ("yt_dlp", "imageio_ffmpeg", "certifi"):
    d, b, h = collect_all(pkg); datas += d; binaries += b; hidden += h
try:
    d, b, h = collect_all("pyrekordbox"); datas += d; binaries += b; hidden += h   # optional: only if it installed
except Exception: pass
hidden += collect_submodules("mutagen")
for f in ("page.html", "shell.html", "set.html", "crates.html", "clean.html"): datas.append((f, "."))
for d in ("static", "vendor", "analyser", "tools"): datas.append((d, d))

a = Analysis(["app.py"], pathex=["."], binaries=binaries, datas=datas, hiddenimports=hidden,
             excludes=["librosa", "scipy", "sklearn", "numba", "matplotlib", "tkinter", "pandas"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [("X utf8", None, "OPTION")], exclude_binaries=True, name="Waxfinder",
          console=False, icon="static/wf-icon.png")
coll = COLLECT(exe, a.binaries, a.datas, name="Waxfinder")
