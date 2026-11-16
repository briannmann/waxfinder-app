/* Waxfinder deck engine (sample-accurate).
   Each track is decoded into memory and played by an AudioBufferSourceNode on ONE shared AudioContext clock,
   so both decks are scheduled to the exact sample: no drift, no correction loops, no browser-player latency.
   Tempo changes work like a CDJ with Master Tempo off (pitch moves with tempo, e.g. ~0.5 semitone for 123 -> 127).
   Plays local files only (/play?id=...). No YouTube.

   API (window.DeckEngine):
     load(side, track)      decode + cue to the first downbeat. track {id,title,artist,bpm,beat_len,first_beat,level_db,url}
     play(side) / pause(side) / toggle(side) / cue(side)   paused: save cue; playing: stop and return to it
     seek(side, seconds)    exact while paused; playing: snap to the nearest beat (matching bar beat when synced)
     sync(side) -> {ok, rate, reason}   unsync(side)
     setJog(side, direction) gentle -1/0/+1 tempo bend on this deck only; release (0) restores the set tempo
     adjustGrid(side, ms)   shift the kick grid by milliseconds (saved per song); resetGrid(side)
     setEq(side, 'low'|'mid'|'high', dB)  -26..+6 dB, 0 = flat     setChannel(side, 0..1) channel fader     levels() -> {A,B} 0..1 meters
     setKeyLock(side, on) / toggleKeyLock(side)   Master Tempo: tempo changes keep the original key (state(side).keylock)
     loop(side, bars)       1/2/4/8-bar quantized loop toggle (state(side).loop = {bars,start,end} or null)
     setPitch(side, pct)    pitch fader: -10..+10 % from the track's own tempo (state(side).pitch reads it back)
     setCrossfader(x)       0 = all A, 1 = all B. Plain equal-power volume crossfade (no automatic bass swap: use the Low EQ).
     state(side)            {track, ready, loading, playing, time, duration, bpm, rate, synced, beat, bar, phaseMs}
     onState(fn)            ~10x a second with {A, B, x}
     readout()              live gains / bass-shelf dB per deck
*/
(function () {
  const BASS_HZ = 180, REF_DB = -12, SMOOTH = 0.015;
  const MAX_STRETCH = 0.10, LEAD = 0.06, FADE = 0.006, JOG_BOOST = 0.01;
  let ctx = null, master = null, x = 0.5;
  const listeners = [];
  const decks = { A: mk('A'), B: mk('B') };

  function mk(side) {
    return { side, track: null, buffer: null, src: null, srcGain: null, playing: false, loading: false,
             offset: 0, cuePoint: null, cueCustom: false, t0: 0, rate: 1, baseRate: 1, jogging: false, jogDirection: 0, barStart: false, manualJog: false, synced: false, bass: null, trim: null, fader: null, loadSeq: 0,
             get a() { return shim(this); } };     // old field some views read: {currentTime, playbackRate, paused, duration}
  }
  const actualRate = d => d.rate * (1 + (d.jogDirection || 0) * JOG_BOOST);
  const waitingForDownbeat = d => !!(d.barStart && d.playing && ctx && ctx.currentTime < d.t0);
  function shim(d) { return { currentTime: pos(d), playbackRate: actualRate(d), paused: !d.playing, duration: d.buffer ? d.buffer.duration : 0, seeking: false }; }
  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      for (const d of Object.values(decks)) {
        d.bass = ctx.createBiquadFilter(); d.bass.type = 'lowshelf'; d.bass.frequency.value = BASS_HZ;
        // channel strip: 3-band EQ -> trim -> channel fader -> crossfader -> master (meter taps the channel)
        d.eq = { low: ctx.createBiquadFilter(), mid: ctx.createBiquadFilter(), high: ctx.createBiquadFilter() };
        d.eq.low.type = 'lowshelf'; d.eq.low.frequency.value = 120;
        d.eq.mid.type = 'peaking'; d.eq.mid.frequency.value = 1000; d.eq.mid.Q.value = 0.7;
        d.eq.high.type = 'highshelf'; d.eq.high.frequency.value = 6000;
        d.trim = ctx.createGain(); d.chan = ctx.createGain(); d.fader = ctx.createGain();
        d.meter = ctx.createAnalyser(); d.meter.fftSize = 1024; d.meterBuf = new Float32Array(1024);
        d.bass.connect(d.eq.low).connect(d.eq.mid).connect(d.eq.high).connect(d.trim).connect(d.chan).connect(d.fader).connect(master);
        // input bus -> [key lock: SoundTouch]  or  [plain: delay of the same length] -> bass swap...  (both always running, so
        // switching key lock is a short crossfade and the two decks always come out at the same moment)
        d.pre = ctx.createGain(); d.plainDelay = ctx.createDelay(1.0); d.plainGain = ctx.createGain(); d.lockGain = ctx.createGain();
        d.pre.connect(d.plainDelay).connect(d.plainGain).connect(d.bass);
        d.lockGain.gain.value = 0; d.lockGain.connect(d.bass);
        d.chan.connect(d.meter);
        d.chan.gain.value = d.chanLevel ?? 1;
      }
      applyFader(true);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const other = s => (s === 'A' ? decks.B : decks.A);
  const bl = d => d.track.beat_len || 60 / d.track.bpm;               // exact beat length (track seconds)
  const fb = d => (d.track.first_beat || 0) + (d.fbAdj || 0);           // grid, nudged onto the decoded kicks
  const tbpm = d => 60 / bl(d);
  const storageKey = (track, kind) => track && (track.id != null || track.url)
    ? 'waxfinder:' + kind + ':v1:' + encodeURIComponent(String(track.id ?? track.url)) : null;
  const cueKey = track => storageKey(track, 'cue');
  const gridKey = track => storageKey(track, 'grid-offset');
  function savedCue(track) {
    const key = cueKey(track); if (!key) return null;
    try {
      const raw = window.localStorage.getItem(key), value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch { return null; }
  }
  function savedGrid(track) {
    const key = gridKey(track); if (!key) return 0;
    try { const value = Number(window.localStorage.getItem(key)); return Number.isFinite(value) ? value : 0; }
    catch { return 0; }
  }
  function pos(d, at) {                                                // track position at a context time
    if (!d.buffer) return 0;
    if (!d.playing) return d.offset;
    const raw = d.offset + Math.max(0, (at ?? ctx.currentTime) - d.t0) * actualRate(d);
    if (d.loop && raw >= d.loop.end) { const len = d.loop.end - d.loop.start; return d.loop.start + ((raw - d.loop.start) % len); }
    return raw;
  }
  // Re-anchor before a rate change, retaining the small phase correction from a jog push.
  function anchorRate(d, at) {
    if (d.jogging && d.playing) d.earAdj = (d.earAdj || 0) + Math.max(0, at - d.t0) * d.rate * JOG_BOOST * d.jogDirection;
    d.offset = pos(d, at); d.t0 = d.playing ? Math.max(at, d.t0) : at;
  }
  function writeRate(d, at) {
    const rate = actualRate(d);
    for (const param of [d.src?.playbackRate, d.st?.parameters.get('playbackRate')]) {
      if (!param) continue;
      param.cancelScheduledValues?.(at); param.setValueAtTime(rate, at);
    }
  }
  function setJog(side, direction) {
    const d = decks[side], value = Number(direction);
    const next = Number.isFinite(value) && d.buffer && d.playing && !waitingForDownbeat(d) ? Math.sign(value) : 0;
    if (d.jogDirection === next) return state(side);
    const at = ctx.currentTime;
    anchorRate(d, at); d.jogDirection = next; d.jogging = next !== 0;
    if (next) d.manualJog = true;
    writeRate(d, at);
    refreshQueuedStarts();
    return state(side);
  }

  /* ---- fader ---- */
  function curve(xv) {
    const gA = Math.cos(xv * Math.PI / 2), gB = Math.sin(xv * Math.PI / 2);
    return { A: { gain: gA, bassDb: 0 }, B: { gain: gB, bassDb: 0 } };   // bass stays full on both decks; cut it yourself with Low EQ
  }
  function applyFader(now) {
    if (!ctx) return;
    const c = curve(x), t = ctx.currentTime;
    for (const k of ['A', 'B']) {
      const d = decks[k];
      if (now) { d.fader.gain.value = c[k].gain; d.bass.gain.value = c[k].bassDb; }
      else { d.fader.gain.setTargetAtTime(c[k].gain, t, SMOOTH); d.bass.gain.setTargetAtTime(c[k].bassDb, t, SMOOTH); }
    }
  }

  /* ---- sources: every start is a fresh node, faded in/out so restarts never click ---- */
  function stopSrc(d, at) {
    if (!d.src) return;
    const s = d.src, g = d.srcGain, t = Math.max(at ?? ctx.currentTime, ctx.currentTime);
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + FADE);
    try { s.stop(t + FADE + 0.002); } catch (e) {}
    d.src = null; d.srcGain = null;
  }
  function startAt(d, when, offset) {
    setJog(d.side, false);
    d.barStart = false;
    offset = clamp(offset, 0, d.buffer.duration - 0.01);
    stopSrc(d, when);
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = d.buffer; s.playbackRate.value = actualRate(d);
    if (d.loop) { s.loop = true; s.loopStart = d.loop.start; s.loopEnd = d.loop.end; }
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + FADE);
    s.connect(g).connect(d.pre);
    if (d.st) d.st.parameters.get('playbackRate').setValueAtTime(actualRate(d), when);
    s.onended = () => { if (d.src === s) { setJog(d.side, false); d.playing = false; d.offset = d.buffer.duration; d.synced = false; d.src = null; } };
    s.start(when, offset);
    d.src = s; d.srcGain = g; d.offset = offset; d.t0 = when; d.playing = true;
  }
  /* where this deck must be at `when` to sit on the same beat of the bar as the other deck, nearest to `near` */
  function aligned(d, when, near) {
    const m = other(d.side);
    const mb = (pos(m, when) - fb(m)) / bl(m), phase = ((mb % 4) + 4) % 4;
    const nb = (near - fb(d)) / bl(d);
    let k = Math.round((nb - phase) / 4); if (k < 0) k = 0;
    return fb(d) + (k * 4 + phase) * bl(d) + (d.earAdj || 0);
  }
  const masterPlaying = d => { const m = other(d.side); return !!(m.track && m.buffer && m.playing); };
  // Queue an incoming deck's nearest beat 1 onto the master's next beat 1.
  // Running decks still phase-align immediately, keeping the master uninterrupted.
  function startOnDownbeat(d) {
    const m = other(d.side), earliest = ctx.currentTime + LEAD;
    const bar = 4 * bl(m), masterAt = pos(m, earliest);
    const nextBar = Math.ceil((masterAt - fb(m)) / bar - 1e-9);
    const masterDownbeat = fb(m) + nextBar * bar;
    if (!m.loop && masterDownbeat >= m.buffer.duration - .01) return false;
    const when = earliest + Math.max(0, masterDownbeat - masterAt) / actualRate(m);
    const ownBar = 4 * bl(d), maxBar = Math.floor((d.buffer.duration - .01 - fb(d)) / ownBar);
    if (maxBar < 0) return false;
    const index = clamp(Math.round((d.offset - fb(d)) / ownBar), 0, maxBar);
    const offset = fb(d) + index * ownBar + (d.earAdj || 0);
    if (waitingForDownbeat(d)) stopSrc(d, ctx.currentTime); // Cancel the old scheduled launch before replacing it.
    startAt(d, when, offset); d.barStart = true;
    const source = d.src;
    setTimeout(() => { if (d.src === source && d.synced && d.playing && !d.earAdj) earLock(d); }, (when - ctx.currentTime) * 1000 + 250);
    return true;
  }
  function refreshQueuedStarts() {
    for (const d of Object.values(decks)) {
      if (!waitingForDownbeat(d) || !d.synced) continue;
      if (!masterPlaying(d) || !startOnDownbeat(d)) pause(d.side);
    }
  }

  /* The grid came from Rekordbox's own decode; the browser's MP3 decode can sit a few ms off it (encoder padding).
     Look +-80 ms around the grid for where the kicks really land in THIS decode. Narrow on purpose, so an offbeat
     bassline can never drag the grid half a beat. */
  async function refineGrid(buf, first, beat) {
    const sr = buf.sampleRate, dur = buf.duration, segStart = Math.min(Math.max(30, dur * 0.25), Math.max(0, dur - 40)), segLen = Math.min(30, dur - segStart);
    if (segLen < 8) return 0;
    const oc = new OfflineAudioContext(1, Math.ceil(segLen * sr), sr), s = oc.createBufferSource(), lp = oc.createBiquadFilter();
    s.buffer = buf; lp.type = 'lowpass'; lp.frequency.value = 140; s.connect(lp).connect(oc.destination); s.start(0, segStart);
    const v = (await oc.startRendering()).getChannelData(0), hop = Math.round(sr / 1000), n = Math.floor(v.length / hop), env = new Float32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < hop; j++) { const z = v[i * hop + j]; q += z * z; } const r = Math.sqrt(q / hop); env[i] = Math.max(0, r - prev); prev = r; }
    const score = adj => { let s2 = 0; const k0 = Math.ceil((segStart - first - adj) / beat);
      for (let k = k0; ; k++) { const t = (first + adj + k * beat - segStart) * 1000; if (t >= n - 3) break; if (t < 2) continue;
        const i = Math.round(t); s2 += env[i - 1] + env[i] + env[i + 1] + env[i + 2]; } return s2; };
    let best = -1, bestAdj = 0;
    for (let ms = -80; ms <= 80; ms++) { const sc = score(ms / 1000); if (sc > best) { best = sc; bestAdj = ms / 1000; } }
    return bestAdj;
  }

  /* ---- API ---- */
  /* ---- key lock (Master Tempo): SoundTouch pitch-corrects the sped-up/slowed source back to its original key ---- */
  const ST_URL = '/static/vendor/soundtouch-processor.js';
  let stReady = null, stLatency = 0, stOk = false;
  function ensureKeyLock() {
    if (stReady) return stReady;
    stReady = (async () => {
      try {
        await ctx.audioWorklet.addModule(ST_URL);
        stLatency = await measureLatency();
        for (const d of Object.values(decks)) {
          d.st = new AudioWorkletNode(ctx, 'soundtouch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          d.st.parameters.get('pitch').value = 1; d.st.parameters.get('playbackRate').value = actualRate(d);
          d.pre.connect(d.st); d.st.connect(d.lockGain);
        }
        stOk = true;
      } catch (e) { stOk = false; stLatency = 0; }
      for (const d of Object.values(decks)) d.plainDelay.delayTime.value = stLatency;   // both paths line up
    })();
    return stReady;
  }
  /* How late SoundTouch's output is vs its input: render a kick-like pulse train through it offline and cross-correlate. */
  async function measureLatency() {
    const sr = ctx.sampleRate, secs = 4, oc = new OfflineAudioContext(2, sr * secs, sr);
    await oc.audioWorklet.addModule(ST_URL);
    const buf = oc.createBuffer(2, sr * secs, sr);
    for (let ch = 0; ch < 2; ch++) { const x = buf.getChannelData(ch);
      for (let k = 0.25; k < secs - 0.3; k += 0.5) { const i0 = Math.round(k * sr);
        for (let i = 0; i < sr * 0.12; i++) x[i0 + i] += Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-i / (sr * 0.01))) * i / sr) * Math.exp(-i / (sr * 0.05)); } }
    const src = oc.createBufferSource(); src.buffer = buf;
    const st = new AudioWorkletNode(oc, 'soundtouch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    src.connect(st).connect(oc.destination); src.start(0);
    const out = (await oc.startRendering()).getChannelData(0), inp = buf.getChannelData(0), hop = Math.round(sr / 1000);
    const env = v => { const n = Math.floor(v.length / hop), e2 = new Float32Array(n); let prev = 0;
      for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < hop; j++) { const z = v[i * hop + j]; q += z * z; } const r = Math.sqrt(q / hop); e2[i] = Math.max(0, r - prev); prev = r; } return e2; };
    const ei = env(inp), eo = env(out); let best = -1, lag = 0;
    for (let L = 0; L <= 400; L++) { let s = 0; for (let i = 0; i + L < eo.length; i++) s += ei[i] * eo[i + L]; if (s > best) { best = s; lag = L; } }
    return lag / 1000;
  }
  /* Re-measure SoundTouch's delay on real music (the first track loaded): 20 s through SoundTouch vs straight, kick envelopes
     cross-correlated. Real music passes through ~10 ms quicker than the synthetic pulses, so this is what the decks hear. */
  let calibrated = false;
  async function calibrateOnMusic(buf) {
    if (calibrated || !stOk) return; calibrated = true;
    try {
      const sr = buf.sampleRate, secs = 20, start = Math.min(Math.max(30, buf.duration * 0.3), Math.max(0, buf.duration - secs - 1));
      const oc = new OfflineAudioContext(2, Math.ceil(secs * sr), sr), merge = oc.createChannelMerger(2);
      await oc.audioWorklet.addModule(ST_URL);
      const mk = () => { const s2 = oc.createBufferSource(); s2.buffer = buf; return s2; };
      const lpA = oc.createBiquadFilter(), lpB = oc.createBiquadFilter(); lpA.type = lpB.type = 'lowpass'; lpA.frequency.value = lpB.frequency.value = 140;
      const a = mk(), b = mk(), st = new AudioWorkletNode(oc, 'soundtouch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      a.connect(lpA).connect(merge, 0, 0); b.connect(st).connect(lpB).connect(merge, 0, 1); merge.connect(oc.destination);
      a.start(0, start); b.start(0, start);
      const out = await oc.startRendering(), hop = Math.round(sr / 1000);
      const env = ch => { const v = out.getChannelData(ch), n = Math.floor(v.length / hop), e2 = new Float32Array(n); let prev = 0;
        for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < hop; j++) { const z = v[i * hop + j]; q += z * z; } const r = Math.sqrt(q / hop); e2[i] = Math.max(0, r - prev); prev = r; } return e2; };
      const e0 = env(0), e1 = env(1); let best = -1, lag = 0;
      for (let L = 40; L <= 260; L++) { let sum = 0; for (let i = 0; i + L < e1.length; i++) sum += e0[i] * e1[i + L]; if (sum > best) { best = sum; lag = L; } }
      stLatency = lag / 1000; for (const d of Object.values(decks)) d.plainDelay.delayTime.setValueAtTime(stLatency, ctx.currentTime);
    } catch (e) { /* keep the synthetic measurement */ }
  }
  function setKeyLock(side, on) {
    const d = decks[side]; if (!ctx || !stOk) { d.keylock = false; return state(side); }
    d.keylock = !!on; const t = ctx.currentTime;
    d.lockGain.gain.setTargetAtTime(d.keylock ? 1 : 0, t, 0.012);         // short crossfade: no click, no time jump
    d.plainGain.gain.setTargetAtTime(d.keylock ? 0 : 1, t, 0.012);
    return state(side);
  }
  async function load(side, track) {
    ensureCtx(); await ensureKeyLock();
    const d = decks[side], seq = ++d.loadSeq;
    pause(side);
    setJog(side, false);
    stopSrc(d); d.playing = false; d.synced = false; d.rate = d.baseRate = 1;
    d.track = track; d.buffer = null; d.loading = true; d.offset = 0;
    d.loop = null; d.cuePoint = null; d.cueCustom = false; d.manualJog = false;
    const trimDb = track.level_db != null ? clamp(REF_DB - track.level_db, -9, 9) : 0;
    d.trim.gain.setTargetAtTime(Math.pow(10, trimDb / 20), ctx.currentTime, 0.05);
    try {
      const data = await fetch(track.url).then(r => { if (!r.ok) throw new Error('Could not load that track'); return r.arrayBuffer(); });
      const buf = await ctx.decodeAudioData(data);
      if (seq !== d.loadSeq) return state(side);                       // a newer load replaced this one
      d.buffer = buf; d.fbAdj = clamp(savedGrid(track), -bl(d) / 2, bl(d) / 2);
      d.earAdj = 0; other(side).earAdj = 0; other(side).manualJog = false; // corrections belonged to the old pair
      if (seq !== d.loadSeq) return state(side);
      const stored = savedCue(track);
      d.cuePoint = clamp(stored ?? fb(d), 0, Math.max(0, buf.duration - 0.01));
      d.cueCustom = stored !== null;
      d.offset = d.cuePoint;
      calibrateOnMusic(buf);
    } finally { if (seq === d.loadSeq) d.loading = false; }
    return state(side);
  }
  function play(side) {
    ensureCtx(); const d = decks[side];
    if (!d.buffer || d.playing) return;
    // If the nominal follower was started first, let that already-playing deck lead.
    if (masterPlaying(d) && other(side).synced && !sync(side).ok) return;
    if (d.synced && masterPlaying(d)) {
      startOnDownbeat(d);
      return;
    }
    const when = ctx.currentTime + LEAD;
    const off = d.synced && masterPlaying(d) ? aligned(d, when, d.offset) : d.offset;   // lands on the matching kick even if Play was late
    startAt(d, when, off);
    if (d.synced && masterPlaying(d) && !d.earAdj) setTimeout(() => earLock(d), 250);
  }
  function pause(side) {
    const d = decks[side]; if (!d.playing) return;
    setJog(side, false);
    const t = ctx.currentTime; d.offset = pos(d, t); d.playing = false; stopSrc(d, t);
    d.barStart = false;
    const follower = other(side);
    if (follower.synced && waitingForDownbeat(follower)) pause(follower.side);
  }
  function toggle(side) { return decks[side].playing ? pause(side) : play(side); }
  function cue(side) {
    const d = decks[side]; if (!d.buffer) return;
    if (!d.playing) {
      d.cuePoint = clamp(pos(d), 0, Math.max(0, d.buffer.duration - 0.01));
      d.cueCustom = true;
      const key = cueKey(d.track);
      if (key) {
        try { window.localStorage.setItem(key, String(d.cuePoint)); } catch { /* Still usable for this session. */ }
        const partner = other(side);
        if (partner.buffer && cueKey(partner.track) === key) {
          partner.cuePoint = clamp(d.cuePoint, 0, Math.max(0, partner.buffer.duration - 0.01));
          partner.cueCustom = true;
        }
      }
    }
    pause(side); d.loop = null;
    d.offset = d.cuePoint ?? clamp(fb(d), 0, Math.max(0, d.buffer.duration - 0.01));
    return state(side);
  }
  function seek(side, t) {
    const d = decks[side]; if (!d.buffer || !Number.isFinite(t)) return;
    if (d.loop) exitLoop(d);
    const end = Math.max(0, d.buffer.duration - 0.01);
    t = clamp(t, 0, end);
    if (!d.playing) { d.offset = t; return; }
    if (waitingForDownbeat(d)) { d.offset = t; startOnDownbeat(d); return; }
    t = clamp(fb(d) + Math.round((t - fb(d)) / bl(d)) * bl(d), 0, end);
    const when = ctx.currentTime + 0.03;
    startAt(d, when, d.synced && masterPlaying(d) ? aligned(d, when, t) : t);
    const m = other(side);                                             // a deck synced to this one follows it onto the bar
    if (m.synced && m.playing) {
      if (waitingForDownbeat(m)) startOnDownbeat(m);
      else startAt(m, when, aligned(m, when, pos(m, when)));
    }
  }
  function sync(side) {
    const d = decks[side], m = other(side);
    if (!d.track || !m.track) return { ok: false, reason: 'Load both decks first' };
    const target = tbpm(m) * m.rate;
    let best = null;
    const r = target / tbpm(d);
    if (Math.abs(r - 1) <= MAX_STRETCH + 1e-9) best = r;
    if (!best) return { ok: false, reason: `${Math.round(tbpm(d))} → ${Math.round(target)} BPM is too far to sync` };
    const queued = waitingForDownbeat(d);
    setJog(side, false); anchorRate(d, ctx.currentTime); d.manualJog = false; d.earAdj = 0;
    d.rate = d.baseRate = best; d.synced = true; m.synced = false;
    if (queued && masterPlaying(d)) {
      startOnDownbeat(d);
    } else if (d.playing && masterPlaying(d)) {                        // match the beat AND bar, sample exact
      const when = ctx.currentTime + 0.03;
      startAt(d, when, aligned(d, when, pos(d, when)));
      if (!d.earAdj) setTimeout(() => earLock(d), 150);
    } else if (d.playing && d.src) {                                   // other deck stopped: just change tempo smoothly
      writeRate(d, ctx.currentTime);
    }
    return { ok: true, rate: best };
  }
  function adjustGrid(side, deltaMs) {
    const d = decks[side], m = other(side);
    if (!d.buffer || !Number.isFinite(deltaMs)) return state(side);
    setJog(side, false);
    d.fbAdj = clamp((d.fbAdj || 0) + deltaMs / 1000, -bl(d) / 2, bl(d) / 2);
    d.earAdj = 0;
    const key = gridKey(d.track);
    if (key) {
      try { window.localStorage.setItem(key, String(d.fbAdj)); } catch { /* Keep the session adjustment. */ }
      if (m.buffer && gridKey(m.track) === key) { setJog(m.side, false); m.fbAdj = d.fbAdj; m.earAdj = 0; }
    }
    if (d.playing && m.playing) {
      const follower = d.synced ? d : m.synced ? m : null;
      if (follower) {
        setJog(follower.side, false); follower.earAdj = 0;
        if (waitingForDownbeat(follower)) startOnDownbeat(follower);
        else {
          const when = ctx.currentTime + .03;
          startAt(follower, when, aligned(follower, when, pos(follower, when)));
        }
      }
    }
    return state(side);
  }
  /* Pitch fader: set this deck to `pct` % from its original tempo (-10..+10). Same rules as the -/+ buttons:
     a synced partner follows at the same instant, and moving the follower's fader moves the master. */
  function setPitch(side, pct) {
    let d = decks[side], m = other(side);
    if (!d.buffer) return;
    const want = 1 + clamp(+pct, -MAX_STRETCH * 100, MAX_STRETCH * 100) / 100;
    if (d.synced && m.buffer) {                      // follower's fader: move the master so both land on this tempo
      const targetBpm = tbpm(d) * want;
      [d, m] = [m, d];
      const r = clamp(targetBpm / tbpm(d), 1 - MAX_STRETCH, 1 + MAX_STRETCH);
      return applyRate(d, m, r, side);
    }
    return applyRate(d, m, want, side);
  }
  function applyRate(d, m, newRate, side) {
    const t = ctx.currentTime;
    const setR = (x, r) => { anchorRate(x, t); x.rate = x.baseRate = r; writeRate(x, t); };
    const f = newRate / d.rate; setR(d, newRate);
    if (m.synced && m.buffer) setR(m, m.rate * f);
    refreshQueuedStarts();
    return state(side);
  }
  function nudgeTempo(side, dBpm) {
    let d = decks[side], m = other(side);
    if (d.synced && m.track && m.buffer) { d = m; m = decks[side]; }      // nudging the follower moves the master (CDJ-style)
    if (!d.buffer) return;
    const newRate = clamp((tbpm(d) * d.rate + dBpm) / tbpm(d), 1 - MAX_STRETCH, 1 + MAX_STRETCH);
    const t = ctx.currentTime;
    const setR = (x, r) => { anchorRate(x, t); x.rate = x.baseRate = r; writeRate(x, t); };
    const f = newRate / d.rate; setR(d, newRate);
    if (m.synced && m.buffer) setR(m, m.rate * f);                      // follower keeps exactly the same lock
    refreshQueuedStarts();
    return state(side);
  }
  /* Quantized bar loops (1, 2, 4, 8 bars): start on the beat nearest to the press, sample-exact via the source's own loop.
     Same length again = exit and play on; another length = re-size from the same start beat. */
  function loop(side, bars) {
    const d = decks[side]; if (!d.buffer || !d.track) return state(side);
    if (d.loop && d.loop.bars === bars) { exitLoop(d); return state(side); }
    const t = ctx.currentTime, p = pos(d, t), len = bars * 4 * bl(d);
    let start = d.loop ? d.loop.start : fb(d) + Math.round((p - fb(d)) / bl(d)) * bl(d);     // nearest kick
    if (start < 0) start = Math.max(0, fb(d));
    if (start + len > d.buffer.duration) return state(side);              // not enough track left
    const end = start + len;
    if (d.playing) {
      // re-anchor without a jump: keep the current position (wrapped into the new loop if a shorter loop leaves us past its end)
      let cur = p; if (cur >= end) cur = start + ((cur - start) % len);
      if (d.loop && cur !== p) { d.loop = { bars, start, end }; startAt(d, t + 0.02, cur); return state(side); }
      d.offset = cur; d.t0 = t; d.loop = { bars, start, end };
      if (d.src) { d.src.loopStart = start; d.src.loopEnd = end; d.src.loop = true; }
    } else d.loop = { bars, start, end };
    return state(side);
  }
  function exitLoop(d) {
    if (!d.loop) return;
    if (d.playing) { const t = ctx.currentTime; d.offset = pos(d, t); d.t0 = t; if (d.src) d.src.loop = false; }
    d.loop = null;
  }
  /* Mixer: 3-band EQ per channel (-26..+6 dB, 0 = flat), channel fader (0..1), and live levels for the meters. */
  const EQ_MIN = -26, EQ_MAX = 6;
  function setEq(side, band, db) {
    ensureCtx(); const d = decks[side], f = d.eq && d.eq[band]; if (!f) return;
    const v = clamp(+db, EQ_MIN, EQ_MAX); d.eqDb = { ...(d.eqDb || { low: 0, mid: 0, high: 0 }), [band]: v };
    f.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
  }
  function setChannel(side, level) {
    ensureCtx(); const d = decks[side], v = clamp(+level, 0, 1); d.chanLevel = v;
    d.chan.gain.setTargetAtTime(v * v, ctx.currentTime, 0.01);          // squared: feels like a real fader
  }
  function levels() {                                                   // 0..1 per deck, post channel fader (pre crossfader)
    const out = {};
    for (const k of ['A', 'B']) {
      const d = decks[k]; if (!ctx || !d.meter || !d.playing) { out[k] = 0; continue; }
      d.meter.getFloatTimeDomainData(d.meterBuf); let pk = 0; for (const v of d.meterBuf) { const a = Math.abs(v); if (a > pk) pk = a; }
      out[k] = clamp((20 * Math.log10(pk + 1e-6) + 36) / 36, 0, 1);    // -36 dBFS .. 0 dBFS
    }
    return out;
  }
  function unsync(side) {
    const d = decks[side], queued = waitingForDownbeat(d);
    d.synced = false;
    if (queued) { pause(side); play(side); }
  }
  function setCrossfader(v) { x = clamp(+v, 0, 1); ensureCtx(); applyFader(false); }

  function phaseMs(d) {
    const m = other(d.side); if (!d.buffer || !m.buffer) return null;
    const t = ctx.currentTime;
    let e = ((pos(d, t) - fb(d)) / bl(d)) - ((pos(m, t) - fb(m)) / bl(m)); e = e % 1; if (e > .5) e -= 1; if (e < -.5) e += 1;
    return e * bl(d) * 1000 / actualRate(d);
  }
  function state(side) {
    const d = decks[side], t = d.track;
    const p = pos(d), b = t && d.buffer ? (p - fb(d)) / bl(d) : 0;
    return { track: t, ready: !!d.buffer, loading: d.loading, playing: d.playing, time: p, duration: d.buffer ? d.buffer.duration : 0,
             cuePoint: d.cuePoint, cueCustom: d.cueCustom,
             bpm: t ? tbpm(d) * actualRate(d) : null, rate: actualRate(d), jogging: d.jogging, jogDirection: d.jogDirection, synced: d.synced, pitch: (d.rate - 1) * 100, pitchRange: MAX_STRETCH * 100,
             waitingForDownbeat: waitingForDownbeat(d),
             gridOffsetMs: (d.fbAdj || 0) * 1000, firstBeat: t ? fb(d) : 0,
             beat: t && d.buffer ? ((Math.floor(b + 1e-9) % 4) + 4) % 4 + 1 : 0, bar: t && d.buffer ? Math.floor((b + 1e-9) / 4) + 1 : 0,
             phaseMs: d.synced && ctx ? phaseMs(d) : null, eq: { low: 0, mid: 0, high: 0, ...(d.eqDb || {}) }, keylock: !!d.keylock, keylockAvailable: stOk, channel: d.chanLevel ?? 1, loop: d.loop ? { bars: d.loop.bars, start: d.loop.start, end: d.loop.end } : null };
  }
  function readout() {
    const c = curve(x);
    return { x, target: c, live: ctx ? { A: { gain: decks.A.fader.gain.value, bassDb: decks.A.bass.gain.value },
                                          B: { gain: decks.B.fader.gain.value, bassDb: decks.B.bass.gain.value } } : null };
  }
  function onState(fn) { listeners.push(fn); }
  setInterval(() => { if (!listeners.length) return; const s = { A: state('A'), B: state('B'), x }; listeners.forEach(f => { try { f(s); } catch (e) {} }); }, 100);

  /* Envelope of the kick band (1 ms frames) for `secs` of each deck from their live positions. */
  async function kickEnvelopes(secs, T) {
    const A = decks.A, B = decks.B, sr = A.buffer.sampleRate;
    const oc = new OfflineAudioContext(2, Math.ceil(secs * sr), sr), merge = oc.createChannelMerger(2);
    for (const [d, ch] of [[A, 0], [B, 1]]) {
      const s = oc.createBufferSource(); s.buffer = d.buffer; s.playbackRate.value = actualRate(d);
      const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140;
      s.connect(lp).connect(merge, 0, ch); s.start(0, Math.max(0, pos(d, T)));
    }
    merge.connect(oc.destination);
    const out = await oc.startRendering(), hop = Math.round(sr / 1000);
    const env = ch => { const v = out.getChannelData(ch), n = Math.floor(v.length / hop), e2 = new Float32Array(n); let prev = 0;
      for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < hop; j++) { const z = v[i * hop + j]; q += z * z; } const r = Math.sqrt(q / hop); e2[i] = Math.max(0, r - prev); prev = r; } return e2; };
    return [env(0), env(1)];
  }
  function bestLag(ea, eb, range) {
    const sc = [];
    for (let L = -range; L <= range; L++) { let s = 0; for (let i = 100; i < ea.length - 100; i++) s += ea[i] * eb[i + L]; sc.push(s); }
    let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
    const sorted = [...sc].sort((a, b) => b - a), clear = sorted[0] > 1.1 * (sc.reduce((a, b) => a + b, 0) / sc.length);
    return { lag: bi - range, clear };
  }
  /* Tracks Rekordbox never gridded: after syncing, listen to the pair once and line the kicks up (+-100 ms max). */
  async function earLock(d) {
    const m = other(d.side);
    if (!d.synced || !d.playing || !m.playing) return;
    if (d.manualJog || m.manualJog || d.fbAdj || m.fbAdj) return;
    const loadD = d.loadSeq, loadM = m.loadSeq;
    if (d.track.grid === 'rekordbox' && m.track.grid === 'rekordbox') return;   // gridded pairs: trust the grids
    const T = ctx.currentTime + 0.15, [ea, eb] = await kickEnvelopes(8, T);
    const [eM, eD] = d.side === 'B' ? [ea, eb] : [eb, ea];
    const { lag, clear } = bestLag(eM, eD, 100);                      // +-100 ms: wide enough for rough grids, far from half a beat
    if (!clear || Math.abs(lag) < 3 || !d.synced || !d.playing || !m.playing ||
        d.manualJog || m.manualJog || d.fbAdj || m.fbAdj || d.loadSeq !== loadD || m.loadSeq !== loadM) return;
    d.earAdj = (d.earAdj || 0) + lag / 1000 * d.rate;                  // d late -> move it forward in its track
    const when = ctx.currentTime + 0.03; startAt(d, when, pos(d, when) + lag / 1000 * d.rate);
  }

  /* Proof without ears: render `secs` of the pair offline through the same placement maths (A left, B right),
     then cross-correlate the kick envelopes. Returns the real kick-to-kick lag in ms. */
  async function _lagTest(secs = 20) {
    const A = decks.A, B = decks.B; if (!A.buffer || !B.buffer) return { error: 'load both decks' };
    const sr = A.buffer.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(secs * sr), sr), merge = oc.createChannelMerger(2);
    const T = ctx.currentTime + 0.2, startA = pos(A, T), offB = pos(B, T);   // exactly what is scheduled right now
    if (stOk) await oc.audioWorklet.addModule(ST_URL);
    for (const [d, off, ch] of [[A, startA, 0], [B, offB, 1]]) {      // same paths as live: key lock through SoundTouch, else the matched delay
      const s = oc.createBufferSource(); s.buffer = d.buffer; s.playbackRate.value = actualRate(d);
      const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140;
      let mid;
      if (d.keylock && stOk) { mid = new AudioWorkletNode(oc, 'soundtouch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }); mid.parameters.get('playbackRate').value = actualRate(d); }
      else { mid = oc.createDelay(1.0); mid.delayTime.value = stLatency; }
      s.connect(mid).connect(lp).connect(merge, 0, ch); s.start(0, off);
    }
    merge.connect(oc.destination);
    const out = await oc.startRendering(), hop = Math.round(sr / 1000);   // 1 ms frames
    const env = ch => { const v = out.getChannelData(ch), n = Math.floor(v.length / hop), e = new Float32Array(n); let prev = 0;
      for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j++) { const q = v[i * hop + j]; s += q * q; } const r = Math.sqrt(s / hop); e[i] = Math.max(0, r - prev); prev = r; } return e; };
    const ea = env(0), eb = env(1);
    let best = -1, lag = 0;
    for (let L = -80; L <= 80; L++) { let s = 0; for (let i = 100; i < ea.length - 100; i++) s += ea[i] * eb[i + L]; if (s > best) { best = s; lag = L; } }
    return { lagMs: lag, note: lag > 0 ? 'B late' : lag < 0 ? 'B early' : 'together' };
  }

  window.DeckEngine = { load, play, pause, toggle, cue, seek, sync, unsync, setJog, adjustGrid, resetGrid: s => adjustGrid(s, -(decks[s].fbAdj || 0) * 1000), nudgeTempo, setPitch, setKeyLock, toggleKeyLock: s => setKeyLock(s, !decks[s].keylock), _latency: () => stLatency, loop, setEq, setChannel, levels, exitLoop: s => exitLoop(decks[s]), setCrossfader, state, onState, readout, curve, _decks: decks, _lagTest };
})();
