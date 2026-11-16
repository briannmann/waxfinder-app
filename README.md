# Waxfinder

DJ library organiser and music discovery app. It runs locally on your PC and opens in your browser at `http://127.0.0.1:8765`.

- Library: one table for all your tracks, with BPM, key, energy, crates and filters
- Crates, smart crates and a Set builder with in-browser decks
- Picks: recommendations from your taste, with previews
- Import from Rekordbox (XML or the local library), and export crates as Rekordbox XML / M3U8
- Downloads from YouTube and SoundCloud (built on yt-dlp) into your chosen library folder. Only use it on content you have the rights to.

## Install (Windows)

Download `Waxfinder-Setup.exe` from the latest Release and run it. Windows SmartScreen will warn because the installer isn't code-signed: click **More info**, then **Run anyway**. It installs for your user only (no admin needed) and starts Waxfinder in your browser.

Your music library folder is chosen inside the app (Files). If you don't pick one, downloads go to `Music\Waxfinder`.

This Windows build does tempo analysis only. Key detection, sound-based genre estimates, Rekordbox key import and one-click CDJ USB export need extra tools that exist only in the Mac setup, so they are switched off here.

## Build

Pushing a tag like `v0.1.0` runs `.github/workflows/build-windows.yml`, which builds the installer on a Windows runner, smoke-tests it, and attaches `Waxfinder-Setup.exe` to the release. It can also be run by hand from the Actions tab.
