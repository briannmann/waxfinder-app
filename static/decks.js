// One set of accessible controls, dressed as hardware or the original glass cards.
// Dynamic imports keep the cards usable when Three, its CDN, or WebGL is unavailable.
const sides = ['A', 'B'];
const mounts = new WeakMap(), views = new Set();
const busy = { A: false, B: false }, messages = { A: '', B: '' };
let library, libraryRequest, subscribed = false, serial = 0, latestSnapshot;
const WIDTH = 26.4, HEIGHT = 11;
const loopBars = [1, 2, 4, 8];
const eqBands = [['high', 'HI', 'High'], ['mid', 'MID', 'Mid'], ['low', 'LOW', 'Low']];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
// World X = (u - .5) * WIDTH, Z = (v - .5) * HEIGHT.
// One table drives both meshes and accessible overlays, including the raised screen.
const LAYOUT = {
  chassis: { x: .014, y: .133, w: .972, h: .849, kind: 'chassis' },
  mixerBody: { x: .376, y: .15, w: .248, h: .818, kind: 'body' },
  screenBody: { x: .367, y: .022, w: .266, h: .310, kind: 'screenBody' },
  touchScreen: { x: .377, y: .039, w: .246, h: .273, kind: 'screen' },
  centerScreen: { x: .381, y: .046, w: .238, h: .259, kind: 'overlay' },
  crossfader: { x: .4165, y: .910, w: .167, h: .041, kind: 'crossfader' }
};
for (const [i, side] of sides.entries()) {
  const offset = i * .608;
  const parts = {
    body: [.022, .15, .348, .818, 'body'],
    deckScreen: [.040, .164, .312, .250, 'deckScreen'],
    jog: [.105, .429, .180, .180 * WIDTH / HEIGHT, 'jog'],
    keylock: [.046, .520, .045, .066, 'keylock'],
    cue: [.046, .649, .045, .045 * WIDTH / HEIGHT, 'cue'],
    play: [.046, .775, .045, .045 * WIDTH / HEIGHT, 'play'],
    sync: [.302, .434, .052, .030, 'button'],
    tempoDown: [.3163, .485, .0234, .0234 * WIDTH / HEIGHT, 'button'],
    tempoUp: [.3163, .875, .0234, .0234 * WIDTH / HEIGHT, 'button'],
    pitch: [.322, .595, .012, .240, 'slider']
  };
  loopBars.forEach((bars, n) => { parts[`loop${bars}`] = [.126 + n * .045, .879, .038, .060, 'loop']; });
  for (const [name, [x, y, w, h, kind]] of Object.entries(parts))
    LAYOUT[`${name}-${side}`] = { x: x + offset, y, w, h, kind, side };
  LAYOUT[`topScreen-${side}`] = { ...LAYOUT[`deckScreen-${side}`], kind: 'overlay' };
  LAYOUT[`info-${side}`] = { x: .049 + offset, y: .174, w: .294, h: .205, kind: 'overlay', side };
  LAYOUT[`overview-${side}`] = { x: .049 + offset, y: .388, w: .294, h: .017, kind: 'overlay', side };
  LAYOUT[`tempoLabel-${side}`] = { x: .290 + offset, y: .555, w: .076, h: .018, kind: 'label', label: 'TEMPO ±10%' };
  eqBands.forEach(([band, label], row) => {
    const knob = { x: i ? .541 : .431, y: .395 + row * .118, w: .028, h: .028 * WIDTH / HEIGHT, kind: 'knob', side, band };
    LAYOUT[`eq-${band}-${side}`] = knob;
    LAYOUT[`eqLabel-${band}-${side}`] = { x: knob.x - .011, y: knob.y - .022, w: .050, h: .015, kind: 'label', label };
  });
  LAYOUT[`channel-${side}`] = { x: i ? .545 : .435, y: .733, w: .021, h: .147, kind: 'slider', side };
  LAYOUT[`meter-${side}`] = { x: i ? .506 : .484, y: .405, w: .010, h: .284, kind: 'meter', side };
  const jog = LAYOUT[`jog-${side}`];
  LAYOUT[`jogDisplay-${side}`] = { x: jog.x + jog.w / 2 - .028, y: jog.y + jog.h / 2 - .043, w: .056, h: .086, kind: 'label', label: side };
}
function place(el, name) {
  const p = LAYOUT[name];
  const parent = LAYOUT[el.parentElement?.closest('[data-part]')?.dataset.part];
  el.dataset.part = name;
  // Nested overlays still use world fractions from the same table.
  const rect = parent ? { left: (p.x - parent.x) / parent.w, top: (p.y - parent.y) / parent.h, width: p.w / parent.w, height: p.h / parent.h } :
    { left: p.x, top: p.y, width: p.w, height: p.h };
  for (const [prop, value] of Object.entries(rect))
    el.style.setProperty(`--part-${prop}`, `${value * 100}%`);
}
const engine = () => {
  if (!window.DeckEngine) throw new Error('The players are unavailable. Reload the page to try again.');
  return window.DeckEngine;
};
const clock = value => {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
function announce(side, text) {
  messages[side] = text;
  views.forEach(view => view.refresh());
}
async function getLibrary() {
  if (library) return library;
  if (!libraryRequest) libraryRequest = fetch('/set/library', { headers: { Accept: 'application/json' } })
    .then(response => {
      if (!response.ok) throw new Error('Could not get your tracks. Try again.');
      return response.json();
    }).then(data => {
      if (!Array.isArray(data.tracks)) throw new Error('Could not read your tracks. Try again.');
      library = data.tracks; // Keep original objects, including their local playback URLs.
      return library;
    }).catch(error => { libraryRequest = null; throw error; });
  return libraryRequest;
}
async function load(side, trackId) {
  if (!sides.includes(side)) throw new Error('Choose deck A or B.');
  if (busy[side]) throw new Error(`Deck ${side} is still loading.`);
  busy[side] = true;
  announce(side, 'Loading track…');
  try {
    const tracks = await getLibrary();
    const track = tracks.find(item => String(item.id) === String(trackId));
    if (!track) throw new Error('That track is not in your library.');
    const result = await engine().load(side, track);
    announce(side, 'Track ready.');
    return result;
  } catch (error) {
    announce(side, error.message || 'Could not load that track. Try again.');
    throw error;
  } finally {
    busy[side] = false;
    views.forEach(view => view.refresh());
  }
}
window.WaxDecks = { load, _anchors: () => {
  const view = [...views].reverse().find(item => item.hardware());
  return view ? view.anchors() : {};
} };

function button(side, name, label, text, extra = '') {
  return `<button type="button" class="wax-button wax-${name}" data-control="${name}-${side}"
    data-part="${name}-${side}" aria-label="${label}" ${extra} disabled>${text}</button>`;
}
function deckMarkup(side, id) {
  return `<section class="wax-deck wax-glass" data-side="${side}" aria-labelledby="${id}-heading">
    <div class="wax-top-screen" data-part="topScreen-${side}">
      <div class="wax-screen-info" data-part="info-${side}">
      <div class="wax-deck-heading"><h3 id="${id}-heading">Deck ${side}</h3><div class="wax-badges"><span class="wax-loop-badge" hidden></span><span class="wax-sync-badge" hidden>Synced</span></div></div>
      <button type="button" class="wax-track" data-control="choose-${side}" aria-label="Choose a track for deck ${side}" aria-expanded="false" aria-controls="${id}-picker">
        <span class="wax-title">Choose a track</span><span class="wax-artist">Your library, ready to play.</span></button>
      <div class="wax-readouts"><div class="wax-tempo"><strong>—</strong><span>BPM</span><span class="wax-keylock-badge" hidden>KEY</span><span class="wax-pitch-readout">+0.0%</span><span class="wax-key">—</span></div>
        <div class="wax-time" aria-label="Playback time"><span class="wax-elapsed">-0:00</span><span class="wax-duration"> / 0:00</span></div></div>
      <div class="wax-beat-row"><span>Beat</span><div class="wax-beats" role="img" aria-label="No track loaded">${[1, 2, 3, 4].map(n => `<span aria-hidden="true">${n}</span>`).join('')}</div>
        <div class="wax-grid-adjust" role="group" aria-label="Sync alignment, deck ${side}"><span>Sync</span>
          <button type="button" data-control="gridEarlier-${side}" aria-label="Sync 5 milliseconds earlier, deck ${side}" title="Move sync 5 ms earlier" disabled>−</button>
          <button type="button" class="wax-grid-reset" data-control="gridReset-${side}" aria-label="Reset sync alignment, deck ${side}" title="Reset sync alignment" disabled>0 ms</button>
          <button type="button" data-control="gridLater-${side}" aria-label="Sync 5 milliseconds later, deck ${side}" title="Move sync 5 ms later" disabled>+</button>
        </div></div>
      <p class="wax-message" role="status" aria-live="polite"></p>
      </div>
      <div class="wax-scrub-row" data-part="overview-${side}"><canvas class="wax-wave" aria-hidden="true"></canvas><input class="wax-scrub" type="range" value="0" data-control="scrub-${side}" aria-label="Position in the track, deck ${side}" disabled></div>
      <form class="wax-picker" id="${id}-picker" role="search" aria-label="Track library for deck ${side}">
        <label for="${id}-search">Find a track</label>
        <input id="${id}-search" type="search" data-control="search-${side}" placeholder="Search title or artist" autocomplete="off" disabled>
        <div class="wax-track-list" data-control="results-${side}" aria-label="Matching tracks"></div>
        <div class="wax-picker-row"><select data-control="select-${side}" aria-label="Track for deck ${side}" disabled><option value="">Getting your tracks…</option></select>
          <button type="submit" class="wax-button wax-load" data-control="load-${side}" disabled>Load</button></div>
      </form>

    </div>
    <button type="button" class="wax-jog" data-control="jog-${side}" data-part="jog-${side}" aria-label="Jog wheel, deck ${side}: hold left to slow, right to speed up" aria-pressed="false" title="Hold left to slow down, right to speed up; release to return" disabled><span>Slow / Fast</span></button>
    <div class="wax-loop-controls" aria-label="Loops, deck ${side}">
      ${loopBars.map(n => button(side, `loop${n}`, `${n} bar loop, deck ${side}`, n, 'aria-pressed="false"')).join('')}
    </div>
    <div class="wax-channel-controls">
      <label class="wax-fallback-label">Pitch<input class="wax-vertical wax-pitch" type="range" min="-10" max="10" step="0.02" value="0" data-part="pitch-${side}" data-control="pitch-${side}" aria-label="Pitch, deck ${side}" disabled></label>
      <div class="wax-eq-controls">${eqBands.map(([band, label, spoken]) => `<div class="wax-eq-control"><span class="wax-fallback-eq-label">${label}</span><div class="wax-eq" role="slider" tabindex="0" aria-orientation="vertical" aria-label="${spoken} EQ, deck ${side}" aria-valuemin="-26" aria-valuemax="6" aria-valuenow="0" aria-valuetext="0 dB" data-control="eq-${band}-${side}" data-part="eq-${band}-${side}"><span class="wax-eq-value">0 dB</span></div></div>`).join('')}</div>
      <label class="wax-fallback-label">Channel volume<input class="wax-vertical wax-channel" type="range" min="0" max="1" step="0.005" value="1" data-part="channel-${side}" data-control="channel-${side}" aria-label="Channel volume, deck ${side}"></label>
    </div>
    <div class="wax-nudges">
      ${button(side, 'tempoDown', `Slower, deck ${side}`, '−', 'title="−0.5 BPM"')}
      ${button(side, 'tempoUp', `Faster, deck ${side}`, '+', 'title="+0.5 BPM"')}
    </div>
    ${button(side, 'keylock', `Key lock, deck ${side}`, '<span>KEY LOCK</span>', 'aria-pressed="false"')}
    <div class="wax-transport">
      ${button(side, 'play', `Play deck ${side}`, '▶/❚❚')}
      ${button(side, 'cue', `Cue deck ${side}`, 'CUE', 'title="Paused: save cue here. Playing: return to cue."')}
      ${button(side, 'sync', `Sync deck ${side}`, 'Sync', 'aria-pressed="false"')}
    </div>
  </section>`;
}

/** Mount once per root. Returns { load(side, id), destroy() }. */
export function mountDecks(rootEl) {
  if (!(rootEl instanceof HTMLElement)) throw new TypeError('mountDecks needs an HTML element.');
  if (mounts.has(rootEl)) return mounts.get(rootEl);
  const id = `wax-decks-${++serial}`, shell = document.createElement('section');
  shell.className = 'wax-decks';
  shell.setAttribute('aria-label', 'Two deck mixer');
  shell.innerHTML = `<div class="wax-library-status" role="status"><span>Getting your tracks…</span><button type="button" data-control="retry" class="wax-button" hidden>Try again</button></div>
    <div class="wax-controller"><div class="wax-stage" aria-hidden="true"></div>
      <div class="wax-hardware-labels" aria-hidden="true">${Object.entries(LAYOUT).filter(([, p]) => p.kind === 'label').map(([name, p]) => `<span data-part="${name}">${p.label}</span>`).join('')}</div>
      <div class="wax-controls">${deckMarkup('A', `${id}-a`)}
        <section class="wax-mix wax-glass" aria-labelledby="${id}-mix">
          <div class="wax-mix-heading"><h3 id="${id}-mix">Mix</h3><span>A + B</span></div>
          <div class="wax-center-screen" data-part="centerScreen"><div class="wax-center-readouts"><span>A <b data-bpm="A">—</b></span><span>BEAT ALIGN</span><span>B <b data-bpm="B">—</b></span></div></div>
          <div class="wax-fader-block"><label for="${id}-fader">Crossfader</label><div class="wax-fader-ends" aria-hidden="true"><span>A</span><span>B</span></div>
            <input id="${id}-fader" type="range" min="0" max="1" step="0.001" value="0.5" data-control="crossfader" data-part="crossfader" aria-label="Crossfader" aria-valuetext="Equal mix of A and B">
            <p>Slide to blend your tracks.</p></div>
        </section>${deckMarkup('B', `${id}-b`)}</div></div>`;
  rootEl.append(shell);
  shell.querySelectorAll('[data-part]').forEach(el => place(el, el.dataset.part));
  const stage = shell.querySelector('.wax-stage'), controller = shell.querySelector('.wax-controller');
  const status = shell.querySelector('.wax-library-status'), statusText = status.querySelector('span');
  const control = name => shell.querySelector(`[data-control="${name}"]`);
  const retry = control('retry'), fader = control('crossfader'), refs = {}, overviews = [], jogReleases = [];
  const events = new AbortController(), wide = matchMedia('(min-width: 760px)');
  let disposed = false, visual, creating = false, failed = false, latest = latestSnapshot;
  const listen = (el, type, fn, options = {}) => el.addEventListener(type, fn, { ...options, signal: events.signal });
  const perform = (side, action) => {
    try {
      announce(side, '');
      Promise.resolve(action()).then(() => view.refresh()).catch(error => announce(side, error.message || 'Please try again.'));
    } catch (error) { announce(side, error.message || 'Please try again.'); }
  };
  function closePicker(side, focus = false) {
    const ui = refs[side];
    ui.screen.classList.remove('wax-picker-open');
    ui.choose.setAttribute('aria-expanded', 'false');
    if (focus) ui.choose.focus();
  }
  function openPicker(side) {
    sides.forEach(s => closePicker(s));
    const ui = refs[side];
    ui.screen.classList.add('wax-picker-open');
    ui.choose.setAttribute('aria-expanded', 'true');
    filterTracks(side);                                   // fresh: what's playing now and what's next
    if (!ui.search.disabled) ui.search.focus();
  }
  function pick(side, trackId) {
    if (busy[side]) return;
    closePicker(side, shell.classList.contains('wax-hardware'));
    load(side, trackId).catch(() => {});
  }
  function filterTracks(side) {
    const ui = refs[side], previous = ui.select.value;
    const query = ui.search.value.trim().toLocaleLowerCase();
    const hit = t => `${t.artist || ''} ${t.title || ''}`.toLocaleLowerCase().includes(query);
    const byId = new Map((library || []).map(t => [String(t.id), t]));
    // the generated set first (in order, with what's on the decks and what's next), then everything else
    const set = (window.WaxSet && window.WaxSet.get()) || { tracks: [], next: null };
    const setRows = set.tracks.map(s => ({ s, t: byId.get(String(s.id)) })).filter(r => r.t && hit(r.t));
    const inSet = new Set(set.tracks.map(s => String(s.id)));
    const rest = (library || []).filter(t => !inSet.has(String(t.id)) && hit(t));
    const nextRow = setRows.find(r => r.s.next);
    ui.matches = [...(nextRow ? [nextRow.t] : []), ...setRows.filter(r => r !== nextRow).map(r => r.t), ...rest];   // Enter loads "Next up"
    ui.select.replaceChildren(new Option(ui.matches.length ? 'Choose a track' : 'No matching tracks', ''));
    const fragment = document.createDocumentFragment();
    const heading = text => { const h = document.createElement('p'); h.className = 'wax-list-heading'; h.textContent = text; fragment.append(h); };
    const item = (track, s) => {
      const label = `${track.artist || 'Unknown artist'} — ${track.title || 'Untitled'}`;
      ui.select.add(new Option(label, String(track.id)));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wax-track-result' + (s && s.next ? ' is-next' : '') + (s && s.playing ? ' is-playing' : '') + (s && s.deck ? ' is-loaded' : '');
      b.dataset.control = `track-${side}`; b.dataset.trackId = String(track.id); b.disabled = busy[side];
      const title = document.createElement('span'), meta = document.createElement('small');
      title.textContent = (s ? s.n + '. ' : '') + label;
      const tags = s ? [s.next ? 'Next up' : null, s.deck ? (s.playing ? `Playing on ${s.deck}` : `On deck ${s.deck}`) : null].filter(Boolean) : [];
      meta.textContent = `${Number.isFinite(track.bpm) ? track.bpm.toFixed(1) : '—'} BPM · ${track.key || '—'}` + (tags.length ? '  ·  ' + tags.join(' · ') : '');
      b.append(title, meta); fragment.append(b);
    };
    if (setRows.length) heading('Your set');
    setRows.forEach(r => item(r.t, r.s));
    if (rest.length) heading(setRows.length ? 'All tracks' : 'Your library');
    rest.forEach(t => item(t, null));
    if (!ui.matches.length) { const empty = document.createElement('p'); empty.textContent = 'No matching tracks'; fragment.append(empty); }
    ui.results.replaceChildren(fragment);
    const nx = ui.results.querySelector('.is-next'); if (nx && !query) nx.scrollIntoView({ block: 'center' });
    if (ui.matches.some(track => String(track.id) === previous)) ui.select.value = previous;
    ui.select.disabled = !ui.matches.length;
    ui.load.disabled = !ui.select.value || busy[side];
  }
  sides.forEach(side => {
    const panel = shell.querySelector(`[data-side="${side}"]`), q = cls => panel.querySelector(`.wax-${cls}`);
    const ui = refs[side] = {
      panel, screen: q('top-screen'), choose: control(`choose-${side}`), search: control(`search-${side}`),
      select: control(`select-${side}`), results: control(`results-${side}`), load: control(`load-${side}`),
      play: control(`play-${side}`), cue: control(`cue-${side}`), sync: control(`sync-${side}`), keylock: control(`keylock-${side}`),
      down: control(`tempoDown-${side}`), up: control(`tempoUp-${side}`), scrub: control(`scrub-${side}`),
      jog: control(`jog-${side}`), gridEarlier: control(`gridEarlier-${side}`), gridLater: control(`gridLater-${side}`), gridReset: control(`gridReset-${side}`),
      title: q('title'), artist: q('artist'), bpm: q('tempo').querySelector('strong'),
      elapsed: q('elapsed'), duration: q('duration'), badge: q('sync-badge'), beats: q('beats'),
      message: q('message'), pitch: control(`pitch-${side}`), channel: control(`channel-${side}`),
      pitchReadout: q('pitch-readout'), key: q('key'), loopBadge: q('loop-badge'), keylockBadge: q('keylock-badge'),
      loops: loopBars.map(n => control(`loop${n}-${side}`)),
      eq: Object.fromEntries(eqBands.map(([band]) => [band, control(`eq-${band}-${side}`)])),
      dragging: new Set(), matches: []
    };
    listen(ui.gridEarlier, 'click', () => perform(side, () => engine().adjustGrid(side, -5)));
    listen(ui.gridLater, 'click', () => perform(side, () => engine().adjustGrid(side, 5)));
    listen(ui.gridReset, 'click', () => perform(side, () => engine().resetGrid(side)));
    let jogPointer = null, jogKey = null;
    const releaseJog = () => {
      if (jogPointer === null && jogKey === null) return;
      const pointer = jogPointer; jogPointer = null; jogKey = null;
      engine().setJog(side, false); view.refresh();
      if (pointer !== null && ui.jog.hasPointerCapture(pointer)) ui.jog.releasePointerCapture(pointer);
    };
    jogReleases.push(releaseJog);
    listen(ui.jog, 'pointerdown', event => {
      if (event.button !== 0 || jogPointer !== null || jogKey !== null || !engine().state(side).playing) return;
      event.preventDefault(); ui.jog.focus({ preventScroll: true });
      jogPointer = event.pointerId; ui.jog.setPointerCapture(jogPointer);
      const rect = ui.jog.getBoundingClientRect();
      engine().setJog(side, event.clientX < rect.left + rect.width / 2 ? -1 : 1); view.refresh();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      listen(ui.jog, type, event => { if (event.pointerId === jogPointer) releaseJog(); });
    listen(ui.jog, 'keydown', event => {
      if (event.key === 'Escape') { releaseJog(); return; }
      if (![' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      if (event.repeat || jogKey !== null || jogPointer !== null || !engine().state(side).playing) return;
      jogKey = event.key; engine().setJog(side, event.key === 'ArrowLeft' ? -1 : 1); view.refresh();
    });
    listen(ui.jog, 'keyup', event => { if (event.key === jogKey) { event.preventDefault(); releaseJog(); } });
    listen(ui.jog, 'blur', releaseJog);
    listen(window, 'blur', releaseJog);
    listen(document, 'visibilitychange', () => { if (document.hidden) releaseJog(); });
    listen(ui.choose, 'click', () => openPicker(side));
    listen(ui.search, 'input', () => filterTracks(side));
    // Handle Enter explicitly so the focused search always loads the first/next match.
    listen(ui.search, 'keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        if (ui.matches[0]) pick(side, ui.matches[0].id);
      }
    });
    loopBars.forEach((bars, n) => listen(ui.loops[n], 'click', () => perform(side, () => engine().loop(side, bars))));
    for (const [name, input, action] of [['pitch', ui.pitch, 'setPitch'], ['channel', ui.channel, 'setChannel']]) {
      listen(input, 'pointerdown', event => {
        ui.dragging.add(name); input.setPointerCapture(event.pointerId);
      });
      const finish = () => { ui.dragging.delete(name); view.refresh(); };
      listen(input, 'pointerup', finish); listen(input, 'pointercancel', finish); listen(input, 'lostpointercapture', finish);
      listen(input, 'input', () => {
        const value = Number(input.value);
        perform(side, () => engine()[action](side, value));
      });
    }
    listen(ui.pitch, 'dblclick', () => perform(side, () => engine().setPitch(side, 0)));
    for (const [band, knob] of Object.entries(ui.eq)) {
      let drag;
      const set = value => perform(side, () => engine().setEq(side, band, Math.round(clamp(value, -26, 6) * 10) / 10));
      const value = () => Number(knob.getAttribute('aria-valuenow'));
      listen(knob, 'pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); knob.focus(); knob.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, y: event.clientY, value: value() };
      });
      listen(knob, 'pointermove', event => {
        if (drag?.id === event.pointerId) set(drag.value + (drag.y - event.clientY) * 32 / 150);
      });
      const finish = () => { drag = null; };
      listen(knob, 'pointerup', finish); listen(knob, 'pointercancel', finish); listen(knob, 'lostpointercapture', finish);
      listen(knob, 'wheel', event => { event.preventDefault(); if (event.deltaY) set(value() - Math.sign(event.deltaY)); }, { passive: false });
      listen(knob, 'keydown', event => {
        const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
        if (delta) { event.preventDefault(); set(value() + delta); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); set(event.key === 'Home' ? -26 : 6); }
      });
      listen(knob, 'dblclick', () => set(0));
    }

    listen(ui.select, 'change', () => { ui.load.disabled = !ui.select.value || busy[side]; });
    listen(ui.results, 'click', event => {
      const item = event.target.closest(`[data-control="track-${side}"]`);
      if (item && !item.disabled) pick(side, item.dataset.trackId);
    });
    listen(q('picker'), 'submit', event => {
      event.preventDefault();
      const trackId = shell.classList.contains('wax-hardware') ? ui.matches[0]?.id : ui.select.value || ui.matches[0]?.id;
      if (trackId != null && trackId !== '') pick(side, trackId);
    });
    // WaxOverview owns ALL scrub events, range values, waveform fetching and seeking.
    if (window.WaxOverview) overviews.push(window.WaxOverview.attach(q('wave'), ui.scrub, side, {
      onPreview: seconds => { ui.elapsed.textContent = `-${clock((engine().state(side).duration || 0) - seconds)}`; }
    }));
    ui.overview = overviews[overviews.length - 1];
    listen(ui.down, 'click', () => perform(side, () => engine().nudgeTempo(side, -0.5)));
    listen(ui.up, 'click', () => perform(side, () => engine().nudgeTempo(side, +0.5)));
    listen(ui.play, 'click', () => perform(side, () => engine().toggle(side)));
    listen(ui.cue, 'click', () => perform(side, () => {
      const saving = !engine().state(side).playing;
      const state = engine().cue(side);
      if (state) announce(side, `${saving ? 'Cue saved at' : 'Returned to cue at'} ${clock(state.cuePoint)}.`);
    }));
    listen(ui.keylock, 'click', () => perform(side, () => engine().toggleKeyLock(side)));
    listen(ui.sync, 'click', () => perform(side, () => {
      if (engine().state(side).synced) engine().unsync(side);
      else {
        const result = engine().sync(side);
        if (!result.ok) announce(side, result.reason || 'Could not sync these tracks.');
      }
    }));
  });
  listen(document, 'pointerdown', event => sides.forEach(side => {
    if (!refs[side].screen.contains(event.target)) closePicker(side);
  }));
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape') return;
    sides.forEach(side => {
      if (refs[side].screen.classList.contains('wax-picker-open')) { closePicker(side, true); event.preventDefault(); }
    });
  });
  // Mount the existing stacked waveforms directly into the hardware screen / mix card.
  window.WaxBeatView?.mount(shell.querySelector('.wax-center-screen'));
  function setFaderText(x) {
    fader.setAttribute('aria-valuetext', x === .5 ? 'Equal mix of A and B' :
      `${Math.round((1 - x) * 100)} percent toward A, ${Math.round(x * 100)} percent toward B`);
  }
  listen(fader, 'input', () => {
    const x = Number(fader.value); setFaderText(x);
    latest = { ...latest, x }; visual?.update(latest);
    try { engine().setCrossfader(x); }
    catch (error) { status.hidden = false; statusText.textContent = error.message; }
  });
  function update(snapshot) {
    if (disposed) return;
    if (snapshot) latest = snapshot;
    sides.forEach(side => {
      const state = latest?.[side], ui = refs[side], loading = busy[side] || !!state?.loading;
      const ready = !!state?.ready && !loading;
      for (const el of [ui.play, ui.cue, ui.sync, ui.down, ui.up, ui.pitch, ...ui.loops]) el.disabled = !ready;
      ui.jog.disabled = !ready || !state?.playing || !!state?.waitingForDownbeat;
      ui.jog.setAttribute('aria-pressed', String(!!state?.jogging));
      for (const el of [ui.gridEarlier, ui.gridLater, ui.gridReset]) el.disabled = !ready;
      const gridMs = Math.round(state?.gridOffsetMs || 0);
      ui.gridReset.textContent = `${gridMs > 0 ? '+' : ''}${gridMs} ms`;
      ui.keylock.disabled = !ready || !state?.keylockAvailable;
      ui.keylock.setAttribute('aria-pressed', String(!!state?.keylock));
      ui.keylockBadge.hidden = !state?.keylock;
      ui.scrub.disabled = !ready;
      ui.load.disabled = loading || !ui.select.value;
      ui.load.textContent = loading ? 'Loading…' : 'Load';
      ui.results.querySelectorAll(`[data-control="track-${side}"]`).forEach(el => { el.disabled = loading; });
      ui.panel.setAttribute('aria-busy', String(loading));
      const message = loading ? 'Loading…' : state?.waitingForDownbeat ? 'Waiting for beat 1' : messages[side];
      if (ui.message.textContent !== message) ui.message.textContent = message;
      if (!state) return;
      ui.cue.title = state.playing ? `Stop and return to cue at ${clock(state.cuePoint)}` : 'Save cue at the current position';
      if (!ui.dragging.has('pitch')) ui.pitch.value = state.pitch ?? 0;
      if (!ui.dragging.has('channel')) ui.channel.value = state.channel ?? 1;
      ui.pitch.setAttribute('aria-valuetext', `${(state.pitch || 0).toFixed(2)} percent`);
      ui.channel.setAttribute('aria-valuetext', `${Math.round((state.channel ?? 1) * 100)} percent`);
      for (const [band, knob] of Object.entries(ui.eq)) {
        const db = state.eq?.[band] ?? 0;
        knob.setAttribute('aria-valuenow', db);
        knob.setAttribute('aria-valuetext', `${db > 0 ? '+' : ''}${db} dB`);
        knob.querySelector('.wax-eq-value').textContent = `${db > 0 ? '+' : ''}${db} dB`;
      }
      ui.loops.forEach((el, n) => el.setAttribute('aria-pressed', String(!!state.loop && state.loop.bars === loopBars[n])));
      ui.loopBadge.hidden = !state.loop;
      ui.loopBadge.textContent = state.loop ? `Loop ${state.loop.bars}` : '';
      ui.pitchReadout.textContent = `${state.pitch >= 0 ? '+' : ''}${(state.pitch || 0).toFixed(1)}%`;
      ui.key.textContent = state.track?.key || '—';
      ui.title.textContent = loading ? 'Loading…' : state.track ? state.track.title || 'Untitled' : 'Choose a track';
      ui.artist.textContent = state.track ? state.track.artist || 'Unknown artist' : 'Your library, ready to play.';
      ui.bpm.textContent = Number.isFinite(state.bpm) ? state.bpm.toFixed(1) : '—';
      shell.querySelector(`[data-bpm="${side}"]`).textContent = ui.bpm.textContent;
      if (!ui.overview?.isScrubbing()) ui.elapsed.textContent = `-${clock(state.duration - state.time)}`;
      ui.duration.textContent = ` / ${clock(state.duration)}`;
      ui.play.textContent = '▶/❚❚';
      ui.play.setAttribute('aria-label', state.waitingForDownbeat ? `Cancel queued start, deck ${side}` : `${state.playing ? 'Pause' : 'Play'} deck ${side}`);
      ui.panel.classList.toggle('wax-playing', !!state.playing);
      ui.badge.hidden = !state.synced;
      ui.sync.setAttribute('aria-pressed', String(!!state.synced));
      ui.sync.textContent = state.synced ? 'Unsync' : 'Sync';
      ui.sync.setAttribute('aria-label', `${state.synced ? 'Unsync' : 'Sync'} deck ${side}`);
      ui.beats.setAttribute('aria-label', state.track ? `Beat ${state.beat} of 4` : 'No track loaded');
      [...ui.beats.children].forEach((beat, i) => beat.classList.toggle('wax-current-beat', !!state.track && i + 1 === state.beat));
    });
    if (Number.isFinite(latest?.x)) { fader.value = latest.x; setFaderText(latest.x); }
    visual?.update(latest);
  }
  const view = {
    refresh() {
      try { update({ A: engine().state('A'), B: engine().state('B'), x: latest?.x ?? .5 }); }
      catch { update(); }
    }, update,
    hardware: () => shell.classList.contains('wax-hardware'),
    anchors: () => visual?.anchors() || {}
  };
  views.add(view);
  try {
    if (!subscribed) {
      engine().onState(snapshot => { latestSnapshot = snapshot; views.forEach(item => item.update(snapshot)); });
      subscribed = true;
    }
  } catch (error) { statusText.textContent = error.message; }
  view.refresh();
  async function populate() {
    retry.hidden = true; status.hidden = false; statusText.textContent = 'Getting your tracks…';
    try {
      const tracks = await getLibrary();
      if (disposed) return;
      sides.forEach(side => { refs[side].search.disabled = !tracks.length; filterTracks(side); });
      status.hidden = tracks.length > 0;
      statusText.textContent = 'Your library is empty. Add some tracks to begin.';
    } catch (error) {
      if (disposed) return;
      statusText.textContent = error.message || 'Could not get your tracks.'; retry.hidden = false;
    }
  }
  listen(retry, 'click', populate);
  populate();
  function fallback() {
    failed = true; shell.classList.remove('wax-hardware');
    visual?.setActive(false);
    sides.forEach(side => closePicker(side));
  }
  async function chooseMode() {
    if (disposed) return;
    jogReleases.forEach(release => release());
    if (wide.matches && !failed && !visual && !creating) {
      creating = true;
      try {
        const result = await createController(stage, controller, fallback);
        if (disposed) { result.destroy(); return; }
        visual = result; visual.update(latest);
      } catch { fallback(); }
      finally { creating = false; }
    }
    if (disposed) return;
    const hardware = wide.matches && !!visual && !failed;
    shell.classList.toggle('wax-hardware', hardware);
    sides.forEach(side => closePicker(side));
    visual?.setActive(hardware);
  }
  listen(wide, 'change', chooseMode);
  chooseMode();
  const api = { load, destroy() {
    jogReleases.forEach(release => release());
    disposed = true; events.abort(); visual?.destroy();
    overviews.forEach(item => item.destroy());
    views.delete(view); mounts.delete(rootEl); shell.remove();
  } };
  mounts.set(rootEl, api);
  return api;
}

async function createController(host, controller, onFailure) {
  const [THREE, { RoundedBoxGeometry }, { RoomEnvironment }] = await Promise.all([
    import('three'), import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/environments/RoomEnvironment.js')
  ]);
  // Render directly into a premultiplied transparent canvas; no fullscreen alpha passes.
  const renderer = new THREE.WebGLRenderer({ alpha: true, premultipliedAlpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.useLegacyLights = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .9;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  // Cache shadows until a fader or EQ cap moves; platter markings need no redraws.
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
  const canvas = renderer.domElement;
  const scene = new THREE.Scene();
  // A straight top-down camera. Screen right is +X, screen down is +Z.
  const camera = new THREE.OrthographicCamera(-WIDTH / 2, WIDTH / 2, HEIGHT / 2, -HEIGHT / 2, .1, 60);
  camera.position.set(0, 30, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const resources = new Set(), meshes = {}, decks = {}, meters = [], faderCaps = {}, eqCaps = {}, loopLights = {}, geometryCache = new Map();
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04);
  scene.environment = environment.texture; resources.add(environment);
  room.dispose(); pmrem.dispose();

  // Static surface textures; only the small lava displays update during playback.
  function texture(size, draw, repeat = false) {
    const image = document.createElement('canvas'); image.width = image.height = size;
    draw(image.getContext('2d'), size);
    const t = new THREE.CanvasTexture(image);
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(9, 5); }
    resources.add(t); return t;
  }
  const grain = texture(256, (ctx, size) => {
    const data = ctx.createImageData(size, size); let seed = 71;
    for (let i = 0; i < data.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = 190 + (seed >>> 27);
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v; data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  }, true);
  const anodised = texture(512, (ctx, size) => {
    const light = ctx.createLinearGradient(0, 0, size, size);
    light.addColorStop(0, '#60616a'); light.addColorStop(.48, '#42424b'); light.addColorStop(1, '#272830');
    ctx.fillStyle = light; ctx.fillRect(0, 0, size, size);
    let seed = 193;
    const data = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < data.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed >>> 28) * .34 - 2.5;
      for (let c = 0; c < 3; c++) data.data[i + c] += noise;
    }
    ctx.putImageData(data, 0, 0);
    for (let y = 0; y < size; y += 2) {
      ctx.strokeStyle = `rgba(190,196,210,${.012 + .012 * Math.sin(y * 2.37)})`;
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(size, y + .5); ctx.stroke();
    }
  });
  anodised.colorSpace = THREE.SRGBColorSpace;
  const platterMap = texture(512, (ctx, size) => {
    const sheen = ctx.createRadialGradient(size * .42, size * .35, 0, size * .5, size * .5, size * .5);
    sheen.addColorStop(0, '#49334b'); sheen.addColorStop(.55, '#2e2033');
    sheen.addColorStop(.85, '#201525'); sheen.addColorStop(1, '#110c18');
    ctx.fillStyle = sheen; ctx.fillRect(0, 0, size, size);
    // Broad, low-contrast bands stay smooth at ordinary monitor resolution.
    ctx.strokeStyle = '#c5a5d008'; ctx.lineWidth = size * .008;
    for (const radius of [.31, .39]) {
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size * radius, 0, Math.PI * 2); ctx.stroke();
    }
  });
  platterMap.colorSpace = THREE.SRGBColorSpace;
  function material(color, roughness = .6, metalness = .05, extra = {}) {
    const m = new THREE.MeshPhysicalMaterial({ color, roughness, metalness, envMapIntensity: .18, ...extra });
    resources.add(m); return m;
  }
  const body = material(0x1d1c22, .72, .15, { bumpMap: grain, bumpScale: .009 });
  const edge = material(0x080b0f, .68, .15);
  const panel = material(0x9c9ca3, .72, .18, { map: anodised, bumpMap: grain, bumpScale: .012, clearcoat: .06, clearcoatRoughness: .5 });
  const screen = material(0x050507, .3, 0, { envMapIntensity: .035, clearcoat: .06, clearcoatRoughness: .32 });
  const steel = material(0x87919c, .27, 1, { envMapIntensity: .95, clearcoat: .12 });
  const platter = material(0xffffff, .24, .18, { envMapIntensity: .10, map: platterMap, clearcoat: .5, clearcoatRoughness: .3 });
  const platterEdge = material(0x241629, .27, .3, { clearcoat: .4 });
  const ink = material(0x040609, .87, .02);
  const rubber = material(0x282a31, .48, .02, { envMapIntensity: .16, clearcoat: .24, clearcoatRoughness: .36 });
  const transportRubber = material(0x303139, .28, .01, { envMapIntensity: .48, clearcoat: .65, clearcoatRoughness: .22 });
  const keyRubber = material(0x30323a, .38, .01, { envMapIntensity: .38, clearcoat: .38, clearcoatRoughness: .30 });
  const gripRubber = material(0x0f1115, .76, .01, { bumpMap: grain, bumpScale: .007 });
  const gripRidge = material(0x22252b, .62, .02, { envMapIntensity: .22 });
  const seam = material(0x101116, .88, .02);
  const bevelLight = material(0x51545d, .45, .55, { envMapIntensity: .25 });
  const capMetal = material(0x66717e, .33, .82, { envMapIntensity: .5 });
  const white = material(0xe8ece9, .4, .2);
  function glow(color, intensity = .9) {
    return material(color, .3, .15, { emissive: color, emissiveIntensity: intensity, clearcoat: .65 });
  }
  function geometry(key, make) {
    if (!geometryCache.has(key)) { const g = make(); geometryCache.set(key, g); resources.add(g); }
    return geometryCache.get(key);
  }
  function mesh(g, mat, x, elevation, z, parent = scene) {
    resources.add(g);
    const m = new THREE.Mesh(g, mat); m.position.set(x, elevation, z);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }
  function box(w, h, d, x, y, z, mat, parent = scene, bevel = .045) {
    const radius = Math.min(bevel, h * .45, w * .2, d * .2);
    const g = geometry(`box:${w}:${h}:${d}:${radius}`, () => new RoundedBoxGeometry(w, h, d, 3, radius));
    return mesh(g, mat, x, y, z, parent);
  }
  function cylinder(r, h, x, y, z, mat, parent = scene) {
    const g = geometry(`cylinder:${r}:${h}`, () => new THREE.CylinderGeometry(r, r, h, 96));
    return mesh(g, mat, x, y, z, parent);
  }
  function dome(r, h, x, y, z, mat, parent = scene) {
    const g = geometry(`dome:${r}`, () => new THREE.SphereGeometry(r, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2));
    const cap = mesh(g, mat, x, y, z, parent); cap.scale.y = h / r; return cap;
  }
  function rubberKey(w, h, d, crown, x, y, z, mat) {
    const g = geometry(`rubberKey:${w}:${h}:${d}:${crown}`, () => {
      const cap = new RoundedBoxGeometry(w, h, d, 6, Math.min(h * .44, w * .17, d * .17));
      const p = cap.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i) / (w / 2), v = p.getZ(i) / (d / 2);
        const top = Math.max(0, Math.min(1, p.getY(i) / h + .5));
        p.setY(i, p.getY(i) + crown * Math.max(0, 1 - u * u) * Math.max(0, 1 - v * v) * top);
      }
      p.needsUpdate = true; cap.computeVertexNormals(); return cap;
    });
    return mesh(g, mat, x, y, z);
  }
  // Soft contact decals supplement the directional shadows, including at rest.
  // Black RGB and alpha gradients keep the page transparent outside the hardware.
  const roundContact = texture(128, (ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * .19, size / 2, size / 2, size * .5);
    g.addColorStop(0, '#000c'); g.addColorStop(.55, '#0008'); g.addColorStop(1, '#0000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  });
  const rectContact = texture(256, (ctx, size) => {
    const data = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = Math.max(Math.abs(x / size * 2 - 1) - .70, 0);
      const dy = Math.max(Math.abs(y / size * 2 - 1) - .70, 0);
      const falloff = Math.max(0, 1 - Math.hypot(dx, dy) / .30);
      data.data[(y * size + x) * 4 + 3] = 220 * falloff * falloff * (3 - 2 * falloff);
    }
    ctx.putImageData(data, 0, 0);
  });
  // A broad shadow with a dense centre and feathered edges, below the entire unit.
  const chassisShadow = texture(512, (ctx, size) => {
    const data = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = Math.max(Math.abs(x / size * 2 - 1) - .91, 0) / .09;
      const dy = Math.max(Math.abs(y / size * 2 - 1) - .84, 0) / .16;
      const falloff = Math.max(0, 1 - Math.hypot(dx, dy));
      // Fade before the fixed canvas boundary so the page never shows a clipped rectangle.
      const wx = (x / size - .5) * (LAYOUT.chassis.w * WIDTH + .8) + .13;
      const wz = (y / size - .5) * (LAYOUT.chassis.h * HEIGHT + .66) + (LAYOUT.chassis.y + LAYOUT.chassis.h / 2 - .5) * HEIGHT + .11;
      const margin = Math.max(0, Math.min(1, (WIDTH / 2 - Math.abs(wx)) / .10, (HEIGHT / 2 - Math.abs(wz)) / .10));
      data.data[(y * size + x) * 4 + 3] = 255 * falloff * falloff * (3 - 2 * falloff) * margin * margin * (3 - 2 * margin);
    }
    ctx.putImageData(data, 0, 0);
  });
  function contact(w, d, x, y, z, round = false, opacity = .7, parent = scene) {
    const mat = new THREE.MeshBasicMaterial({ map: round ? roundContact : rectContact,
      transparent: true, opacity, depthWrite: false, toneMapped: false });
    resources.add(mat);
    const decal = mesh(geometry(`contact:${w}:${d}`, () => new THREE.PlaneGeometry(w, d)), mat, x, y, z, parent);
    decal.rotation.x = -Math.PI / 2; decal.castShadow = decal.receiveShadow = false;
    return decal;
  }
  function ring(r, tube, x, y, z, mat, parent = scene) {
    const g = geometry(`ring:${r}:${tube}`, () => new THREE.TorusGeometry(r, tube, 10, 128));
    const m = mesh(g, mat, x, y, z, parent);
    m.rotation.x = -Math.PI / 2;
    if (mat.emissive && mat.emissive.getHex() !== 0) {
      // Local annular halos sit over opaque hardware. Their colour follows the LED
      // material, including sync changes, without a fullscreen bloom/alpha pipeline.
      const extent = r + tube * 5;
      const haloMat = new THREE.ShaderMaterial({
        uniforms: { glowColor: { value: mat.emissive }, radius: { value: r / extent }, width: { value: tube * 2 / extent } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 glowColor; uniform float radius; uniform float width; varying vec2 vUv;
          void main() { float d = (length(vUv * 2.0 - 1.0) - radius) / width;
            float a = exp(-d * d * 2.0) * 0.16;
            gl_FragColor = vec4(glowColor, a);
            #include <colorspace_fragment>
          }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      resources.add(haloMat);
      const halo = mesh(geometry(`halo:${extent}`, () => new THREE.PlaneGeometry(extent * 2, extent * 2)), haloMat, x, y - .008, z, parent);
      halo.rotation.x = -Math.PI / 2; halo.castShadow = false; halo.receiveShadow = false;
    }
    return m;
  }
  // Repeated grip ridges and dial graduations cost one draw call per ring.
  function radialDetails(count, radius, w, h, d, y, mat, parent, start = 0, sweep = Math.PI * 2) {
    const g = geometry(`detail:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
    const details = new THREE.InstancedMesh(g, mat, count), transform = new THREE.Object3D();
    for (let n = 0; n < count; n++) {
      const a = start + n / count * sweep;
      transform.position.set(Math.sin(a) * radius, y, Math.cos(a) * radius);
      transform.rotation.y = a; transform.updateMatrix(); details.setMatrixAt(n, transform.matrix);
    }
    details.instanceMatrix.needsUpdate = true; details.castShadow = details.receiveShadow = true; parent.add(details);
    // Instanced meshes own GPU instance buffers in addition to their shared geometry.
    resources.add(details); return details;
  }
  function roundedPath(path, x, y, w, h, r) {
    path.moveTo(x + r, y); path.lineTo(x + w - r, y);
    path.quadraticCurveTo(x + w, y, x + w, y + r); path.lineTo(x + w, y + h - r);
    path.quadraticCurveTo(x + w, y + h, x + w - r, y + h); path.lineTo(x + r, y + h);
    path.quadraticCurveTo(x, y + h, x, y + h - r); path.lineTo(x, y + r);
    path.quadraticCurveTo(x, y, x + r, y); return path;
  }
  function topPlate(w, d, x, z, screenLayout, elevation = .335) {
    const shape = roundedPath(new THREE.Shape(), -w / 2 + .025, -d / 2 + .025, w - .05, d - .05, .075);
    if (screenLayout) {
      const sw = screenLayout.w * WIDTH + .08, sd = screenLayout.h * HEIGHT + .08;
      const sx = (screenLayout.x + screenLayout.w / 2 - .5) * WIDTH - x;
      const sz = (screenLayout.y + screenLayout.h / 2 - .5) * HEIGHT - z;
      shape.holes.push(roundedPath(new THREE.Path(), sx - sw / 2, -sz - sd / 2, sw, sd, .035));
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: .07, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .012, bevelThickness: .012, curveSegments: 8 });
    // Extruded caps have world-unit UVs; normalise these so the broad light gradient
    // spans each panel once, with its light corner facing the key light.
    const positions = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let i = 0; i < positions.count; i++) uv.setXY(i, positions.getX(i) / w + .5, positions.getY(i) / d + .5);
    uv.needsUpdate = true;
    const plate = mesh(g, panel, x, elevation, z); plate.rotation.x = -Math.PI / 2;
  }
  function bezel(w, d, x, y, z, thickness, mat) {
    // Four rounded rails leave a true opening rather than hiding the screen under a slab.
    box(w + thickness * 2, .075, thickness, x, y, z - d / 2 - thickness / 2, mat);
    box(w + thickness * 2, .075, thickness, x, y, z + d / 2 + thickness / 2, mat);
    box(thickness, .075, d, x - w / 2 - thickness / 2, y, z, mat);
    box(thickness, .075, d, x + w / 2 + thickness / 2, y, z, mat);
  }
  function lavaDisplay(phase) {
    const size = 256;
    const image = document.createElement('canvas'); image.width = image.height = size;
    const ctx = image.getContext('2d');
    function draw(time) {
      const t = time + phase;
      const background = ctx.createRadialGradient(110, 95, 0, 128, 128, 150);
      background.addColorStop(0, '#251329'); background.addColorStop(1, '#09070e');
      ctx.fillStyle = background; ctx.fillRect(0, 0, size, size);
      const cx = 128 + Math.sin(t * .7) * 12, cy = 128 + Math.cos(t * .6) * 14;
      const points = Array.from({ length: 48 }, (_, i) => {
        const a = i / 48 * Math.PI * 2;
        const r = 65 + Math.sin(a * 3 + t) * 12 + Math.cos(a * 2 - t * .8) * 10;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      });
      ctx.beginPath();
      ctx.moveTo((points[47][0] + points[0][0]) / 2, (points[47][1] + points[0][1]) / 2);
      points.forEach(([x, y], i) => {
        const next = points[(i + 1) % points.length];
        ctx.quadraticCurveTo(x, y, (x + next[0]) / 2, (y + next[1]) / 2);
      });
      ctx.closePath();
      const color = ctx.createLinearGradient(cx - 55, cy - 60, cx + 65, cy + 70);
      color.addColorStop(0, '#efffad'); color.addColorStop(.45, '#c6ff3d');   // the site's lime lava gradient
      color.addColorStop(.8, '#97d915'); color.addColorStop(1, '#6f9a0c');
      ctx.fillStyle = color; ctx.shadowColor = '#c6ff3d65'; ctx.shadowBlur = 22; ctx.fill(); ctx.shadowBlur = 0;
      ctx.save(); ctx.clip();
      const gloss = ctx.createRadialGradient(cx - 25, cy - 36, 0, cx - 20, cy - 30, 80);
      gloss.addColorStop(0, '#ffffff50'); gloss.addColorStop(.6, '#ffffff09'); gloss.addColorStop(1, '#ffffff00');
      ctx.fillStyle = gloss; ctx.fillRect(0, 0, size, size); ctx.restore();
    }
    draw(0);
    const map = new THREE.CanvasTexture(image); map.colorSpace = THREE.SRGBColorSpace; resources.add(map);
    // No mipmap regeneration on each small display update.
    map.generateMipmaps = false; map.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map, toneMapped: false }); resources.add(mat);
    return { material: mat, time: 0, painted: 0, advance(dt) {
      this.time += dt;
      if (this.time - this.painted < .08) return;
      draw(this.time * .35); map.needsUpdate = true; this.painted = this.time;
    } };
  }
  let crossKnob;
  for (const [name, p] of Object.entries(LAYOUT)) {
    const w = p.w * WIDTH, d = p.h * HEIGHT, x = (p.x + p.w / 2 - .5) * WIDTH, z = (p.y + p.h / 2 - .5) * HEIGHT;
    let part;
    if (p.kind === 'overlay' || p.kind === 'label') {
      // Non-solid screen regions still have real geometry for projected anchor rects.
      part = box(w, .001, d, x, 1.13, z, ink); part.visible = false;
    } else if (p.kind === 'screenBody') {
      contact(w + .36, d + .35, x + .08, .43, z + .12, false, .9);
      part = box(w, .60, d, x, .66, z, edge, scene, .12);
      topPlate(w, d, x, z, LAYOUT.touchScreen, .94);
      bezel(w - .12, d - .12, x, 1.018, z, .024, seam);
      box(w - .2, .01, .018, x, 1.03, z - d / 2 + .06, bevelLight);
    } else if (p.kind === 'chassis' || p.kind === 'body') {
      const chassis = p.kind === 'chassis';
      part = box(w, chassis ? .48 : .18, d, x, chassis ? -.10 : .24, z, chassis ? edge : body, scene, .12);
      if (chassis) {
        // A dark bevel replaces the bright perimeter; only the light-facing rails glint.
        const shadowMat = new THREE.MeshBasicMaterial({ map: chassisShadow, transparent: true, opacity: .5, depthWrite: false, toneMapped: false });
        resources.add(shadowMat);
        const shadow = mesh(geometry('chassisShadow', () => new THREE.PlaneGeometry(w + .8, d + .66)), shadowMat, x + .13, -.355, z + .11);
        shadow.rotation.x = -Math.PI / 2; shadow.castShadow = shadow.receiveShadow = false;
        bezel(w - .14, d - .14, x, .17, z, .055, edge);
        bezel(w - .27, d - .27, x, .18, z, .04, ink);
        box(w - .24, .012, .021, x, .211, z - d / 2 + .075, bevelLight);
        box(.018, .012, d - .24, x - w / 2 + .075, .211, z, bevelLight);
      } else {
        topPlate(w, d, x, z, p.side ? LAYOUT[`deckScreen-${p.side}`] : null);
        if (!p.side) {
          // Hairline insets sit just above the mixer panel, with a subdued lower lip.
          bezel(w - .14, d - .14, x, .414, z, .017, seam);
          box(w - .24, .004, .009, x, .426, z + d / 2 - .081, bevelLight);
        }
        for (const dx of [-w / 2 + .14, w / 2 - .14]) for (const dz of [-d / 2 + .14, d / 2 - .14]) {
          cylinder(.057, .014, x + dx, .429, z + dz, ink);
          cylinder(.038, .016, x + dx, .438, z + dz, steel);
          const screw = box(.045, .004, .009, x + dx, .449, z + dz, ink); screw.rotation.y = .45;
        }
        box(.016, .008, d - .28, x - w / 2 + .045, .423, z, bevelLight);
        box(w - .25, .008, .014, x, .423, z - d / 2 + .045, bevelLight);
        box(.022, .008, d - .28, x + w / 2 - .045, .423, z, ink);
        box(w - .25, .008, .023, x, .423, z + d / 2 - .045, ink);
      }
    } else if (p.kind === 'deckScreen') {
      box(w + .08, .025, d + .08, x, .350, z, ink);
      part = box(w, .025, d, x, .371, z, screen);
      bezel(w, d, x, .430, z, .042, edge);
      box(w - .06, .008, .012, x, .447, z - d / 2 - .018, capMetal);
    } else if (p.kind === 'screen') {
      box(w + .07, .02, d + .07, x, .987, z, ink);
      part = box(w, .025, d, x, 1.015, z, screen);
      bezel(w, d, x, 1.096, z, .035, edge);
      // A narrow bright upper edge makes the glass recess readable from directly above.
      box(w - .06, .008, .012, x, 1.10, z - d / 2 - .015, steel);
    } else if (p.kind === 'jog') {
      const r = w / 2, rotating = new THREE.Group(); rotating.position.set(x, .7, z); scene.add(rotating);
      contact(w * 1.19, d * 1.19, x + .08, .427, z + .08, true, .95);
      part = cylinder(r, .08, x, .44, z, ink); // fixed silhouette = stable anchor during rotation
      cylinder(r * .975, .12, x, .515, z, steel);
      cylinder(r * .95, .19, x, .63, z, gripRubber);
      ring(r * .958, .026, x, .572, z, edge);
      ring(r * .969, .009, x, .584, z, steel);
      const grip = new THREE.Group(); grip.position.set(x, 0, z); scene.add(grip);
      radialDetails(192, r * .932, .016, .032, r * .043, .733, gripRidge, grip);
      cylinder(r * .88, .10, 0, .035, 0, platterEdge, rotating);
      cylinder(r * .843, .045, 0, .105, 0, platter, rotating);
      ring(r * .854, .022, 0, .118, 0, platterEdge, rotating);
      box(.037, .012, .22, 0, .14, -r * .73, white, rotating);
      const ringMat = glow(0xff4d2e, 1.1);
      const beatRing = ring(r * .902, .021, x, .75, z, ringMat);
      cylinder(r * .465, .07, x, .86, z, edge);
      cylinder(r * .431, .025, x, .905, z, screen);
      ring(r * .448, .018, x, .917, z, ringMat);
      const lava = lavaDisplay(p.side === 'A' ? 0 : 1.8);
      const display = mesh(geometry(`jogDisplay:${r}`, () => new THREE.CircleGeometry(r * .421, 96)), lava.material, x, .925, z);
      display.rotation.x = -Math.PI / 2; display.castShadow = display.receiveShadow = false;
      // One soft highlight on the glossy annulus, fixed under the room light.
      const reflectionMap = texture(256, (ctx, size) => {
        const data = ctx.createImageData(size, size);
        for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
          const u = (px / size - .5) * 2, v = (py / size - .5) * 2, radius = Math.hypot(u, v);
          const streak = Math.exp(-(((u + .43) / .30) ** 2 + ((v + .48) / .40) ** 2) * 2);
          const mask = Math.max(0, Math.min(1, (radius - .49) / .05, (.842 - radius) / .025));
          const i = (py * size + px) * 4;
          data.data[i] = 235; data.data[i + 1] = 216; data.data[i + 2] = 248;
          data.data[i + 3] = 100 * streak * mask;
        }
        ctx.putImageData(data, 0, 0);
      });
      reflectionMap.colorSpace = THREE.SRGBColorSpace;
      const reflectionMat = new THREE.MeshBasicMaterial({ map: reflectionMap, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      resources.add(reflectionMat);
      const reflection = new THREE.Group(); reflection.position.set(x, .837, z); scene.add(reflection);
      const streak = mesh(geometry(`reflection:${w}`, () => new THREE.PlaneGeometry(w, d)), reflectionMat, 0, 0, 0, reflection);
      streak.rotation.x = -Math.PI / 2; streak.castShadow = streak.receiveShadow = false;
      decks[p.side] = { rotating, lava, ringMat, beatRing, pulse: 0, beatKey: '', playMat: null, cueMat: null, syncMat: null, keylockMat: null };
    } else if (p.kind === 'play' || p.kind === 'cue') {
      contact(w * 1.54, d * 1.54, x + .075, .428, z + .065, true, .95);
      part = cylinder(w / 2, .065, x, .461, z, ink);
      cylinder(w * .46, .13, x, .52, z, gripRubber);
      ring(w * .463, .009, x, .555, z, capMetal);
      const m = glow(p.kind === 'play' ? 0xc6ff3d : 0xff4d2e, .8);
      // Keep the LED above the rubber shoulder so its dome cannot shadow the ring.
      ring(w * .440, .026, x, .766, z, m);
      cylinder(w * .383, .20, x, .64, z, transportRubber);
      dome(w * .383, .10, x, .74, z, transportRubber);
      if (p.kind === 'play') decks[p.side].playMat = m;
      else decks[p.side].cueMat = m;
    } else if (p.kind === 'keylock') {
      contact(w * 1.48, d * 1.48, x + .055, .428, z + .065, false, .9);
      part = box(w, .035, d, x, .44, z, ink);
      box(w * .93, .045, d * .91, x, .487, z, edge);
      rubberKey(w * .86, .22, d * .80, .035, x, .609, z, keyRubber);
      const led = glow(0xc6ff3d, 0);
      led.color.setHex(0x0b0d09);
      cylinder(w * .055, .012, x, .756, z - d * .23, ink);
      cylinder(w * .035, .014, x, .766, z - d * .23, led);
      decks[p.side].keylockMat = led;
    } else if (p.kind === 'button' || p.kind === 'loop') {
      contact(w * 1.48, d * 1.62, x + .055, .428, z + .065, false, .9);
      part = box(w, .035, d, x, .44, z, ink);
      const isLoop = p.kind === 'loop', isSync = name.startsWith('sync-');
      const m = glow(isLoop ? 0xc6ff3d : 0xff4d2e, isLoop ? 0 : .3);
      box(w * .92, .045, d * .89, x, .487, z, isLoop ? m : edge, scene, .05);
      rubberKey(w * .84, .22, d * .77, .035, x, .609, z, keyRubber);
      box(w * .67, .009, .012, x, .718, z + d * .28, m);
      if (isSync) decks[p.side].syncMat = m;
      if (isLoop) loopLights[name] = m;
    } else if (p.kind === 'knob') {
      contact(w * 1.65, d * 1.65, x + .055, .429, z + .055, true, .9);
      part = cylinder(w / 2, .075, x, .455, z, ink);
      ring(w * .45, .018, x, .47, z, steel);
      const rotating = new THREE.Group(); rotating.position.set(x, 0, z); scene.add(rotating);
      eqCaps[name] = rotating;
      cylinder(w * .405, .29, 0, .64, 0, rubber, rotating);
      radialDetails(32, w * .40, .024, .23, .035, .65, body, rotating);
      cylinder(w * .38, .04, 0, .803, 0, capMetal, rotating);
      dome(w * .35, .085, 0, .823, 0, rubber, rotating);
      const indicatorPath = new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => {
        const dz = -d * (.04 + i / 8 * .26);
        return new THREE.Vector3(0, .823 + .085 * Math.sqrt(1 - (dz / (w * .35)) ** 2) + .009, dz);
      }));
      mesh(geometry(`indicator:${w}:${d}`, () => new THREE.TubeGeometry(indicatorPath, 12, .013, 6, false)), white, 0, 0, 0, rotating);
      const ticks = new THREE.Group(); ticks.position.set(x, 0, z); scene.add(ticks);
      radialDetails(11, w * .48, .012, .006, .023, .431, steel, ticks, -Math.PI * .77, Math.PI * 1.65);
    } else if (p.kind === 'meter') {
      part = box(w, .02, d, x, .43, z, ink);
      for (let n = 0; n < 16; n++) {
        const m = glow(n > 12 ? 0xff4d2e : n > 9 ? 0xffc34d : 0xc6ff3d, .10);
        const led = box(w * .68, .012, d / 23, x, .451, z + d * (.46 - n / 16), m);
        led.castShadow = false; meters.push({ side: p.side, n, color: m.color.clone(), material: m });
      }
    } else if (p.kind === 'slider') {
      part = box(w, .02, d, x, .43, z, edge);
      box(w * .32, .01, d * .94, x, .446, z, steel);
      box(w * .15, .015, d * .92, x, .455, z, ink);
      const cap = box(w * 1.7, .22, .23, x, .6, z, capMetal, scene, .06);
      contact(w * 2.4, .43, .035, -.126, .045, false, .85, cap);
      faderCaps[name] = cap;
      box(w * 1.54, .055, .17, 0, .126, 0, rubber, cap);
      box(w * 1.35, .01, .015, 0, .159, 0, white, cap);
      box(w * 1.4, .012, .019, 0, .122, -.09, steel, cap);
      for (let n = 0; n < 11; n++) {
        const dz = z + (n / 10 - .5) * d;
        box(n === 5 ? .13 : .075, .007, .012, x - w * .9, .433, dz, steel);
      }
      if (name.startsWith('pitch-')) {
        // A fixed centre detent stays visible on both sides of the moving cap.
        for (const sign of [-1, 1]) box(.12, .008, .022, x + sign * w * 1.17, .444, z, white);
      }
    } else if (p.kind === 'crossfader') {
      part = box(w, .02, d, x, .43, z, edge);
      box(w * .94, .01, .085, x, .448, z, steel);
      box(w * .94, .012, .047, x, .46, z, ink);
      for (let n = 0; n < 17; n++) box(.012, .007, n % 4 ? .07 : .13, x + (n / 16 - .5) * w * .9, .445, z - d * .32, steel);
      crossKnob = box(.42, .24, d * .78, x, .61, z, capMetal, scene, .065);
      contact(.72, d * 1.1, .04, -.13, .04, false, .9, crossKnob);
      box(.33, .06, d * .69, 0, .145, 0, rubber, crossKnob);
      box(.024, .012, d * .59, 0, .181, 0, white, crossKnob);
      box(.018, .012, d * .63, -.17, .133, 0, steel, crossKnob);
    }
    meshes[name] = part;
  }
  scene.add(new THREE.HemisphereLight(0xe3efff, 0x151b24, .24));
  const key = new THREE.DirectionalLight(0xfff0df, 2.8);
  // 40 degrees above the panel, from screen upper-left; shadows fall down-right.
  key.position.set(-12, 12, -8); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -13, right: 13, top: 10, bottom: -10, near: 1, far: 45 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -.00008; key.shadow.normalBias = .012; key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb9d5ff, .15); fill.position.set(9, 6, 3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xf1f6ff, .18); rim.position.set(2, 4, -10); scene.add(rim);
  resources.add(key.shadow);

  // Direct rendering preserves transparent clear pixels and applies tone mapping once.
  host.append(canvas);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let current, frame = 0, last = 0, active = false, visible = true, dead = false;
  const peaks = { A: { count: 0, until: 0 }, B: { count: 0, until: 0 } };
  function destroy() {
    if (dead) return;
    dead = true; cancelAnimationFrame(frame); observer?.disconnect(); sizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', schedule); window.removeEventListener('resize', resize);
    canvas.removeEventListener('webglcontextlost', contextLost);
    scene.environment = null;
    resources.forEach(resource => resource.dispose()); renderer.dispose(); canvas.remove();
  }
  function contextLost(event) { event.preventDefault(); destroy(); onFailure(); }
  function render(now) {
    frame = 0;
    if (dead || !active || !visible || document.hidden) return;
    const dt = last ? Math.min((now - last) / 1000, .06) : 0; last = now;
    sides.forEach(side => {
      const deck = decks[side], state = current?.[side];
      if (state?.playing && !reduced.matches) {
        deck.rotating.rotation.y -= dt * 1.5 * (state.rate || 1);
        deck.lava.advance(dt);
      }
      deck.pulse = Math.max(0, deck.pulse - dt * 5);
      deck.ringMat.emissiveIntensity = 1.05 + (reduced.matches ? 0 : deck.pulse * 1.5);
    });
    const levels = window.DeckEngine?.levels() || { A: 0, B: 0 };
    const counts = {};
    sides.forEach(side => {
      const count = Math.ceil(clamp(levels[side] || 0, 0, 1) * 16), peak = peaks[side];
      counts[side] = count;
      if (count >= peak.count || now >= peak.until) { peak.count = count; peak.until = now + 650; }
    });
    for (const led of meters) {
      const lit = led.n < counts[led.side] || (peaks[led.side].count > 0 && led.n === peaks[led.side].count - 1);
      led.material.color.copy(led.color).multiplyScalar(lit ? 1 : .045);
      led.material.emissiveIntensity = lit ? 1.1 : .015;
    }
    try { renderer.render(scene, camera); }
    catch { destroy(); onFailure(); return; }
    frame = requestAnimationFrame(render);
  }
  function schedule() {
    if (dead) return;
    if (!active || !visible || document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0; }
    else if (!frame) frame = requestAnimationFrame(render);
  }
  function resize() {
    if (dead || !active) return;
    const { width, height } = controller.getBoundingClientRect();
    if (width && height) {
      renderer.setSize(width, height, false);
      Object.assign(camera, { left: -WIDTH / 2, right: WIDTH / 2, top: HEIGHT / 2, bottom: -HEIGHT / 2 });
      camera.updateProjectionMatrix();
    }
    schedule();
  }
  const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting; schedule();
  }) : null;
  observer?.observe(controller);
  const sizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  sizeObserver?.observe(controller);
  document.addEventListener('visibilitychange', schedule); window.addEventListener('resize', resize);
  canvas.addEventListener('webglcontextlost', contextLost);
  return {
    destroy,
    setActive(value) { active = value; resize(); schedule(); },
    // Project actual mesh geometry, not DOM measurements or a second copy of the layout.
    // Coordinates include scroll offsets, so these are page pixels (x/y/w/h).
    anchors() {
      if (dead || !active) return {};
      const bounds = canvas.getBoundingClientRect(), result = {};
      scene.updateMatrixWorld(true);
      for (const [name, part] of Object.entries(meshes)) {
        part.geometry.computeBoundingBox();
        const b = part.geometry.boundingBox, projected = [];
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z])
          projected.push(new THREE.Vector3(x, y, z).applyMatrix4(part.matrixWorld).project(camera));
        const xs = projected.map(p => (p.x + 1) * bounds.width / 2);
        const ys = projected.map(p => (1 - p.y) * bounds.height / 2);
        result[name] = { x: bounds.left + window.scrollX + Math.min(...xs), y: bounds.top + window.scrollY + Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
      return result;
    },
    update(snapshot) {
      if (dead || !snapshot) return;
      current = snapshot;
      const p = LAYOUT.crossfader;
      const nextX = (p.x + p.w * (snapshot.x ?? .5) - .5) * WIDTH;
      if (crossKnob.position.x !== nextX) renderer.shadowMap.needsUpdate = true;
      crossKnob.position.x = nextX;
      sides.forEach(side => {
        const deck = decks[side], state = snapshot[side], color = state?.synced ? 0xc6ff3d : 0xff4d2e;
        deck.ringMat.color.setHex(color); deck.ringMat.emissive.setHex(color);
        deck.ringMat.emissiveIntensity = state?.jogging ? 1.65 : 1.1;
        deck.playMat.emissiveIntensity = state?.playing ? 1.8 : .85;
        deck.cueMat.emissiveIntensity = state?.playing ? .8 : 1.5;
        deck.syncMat.color.setHex(color); deck.syncMat.emissive.setHex(color);
        deck.syncMat.emissiveIntensity = state?.synced ? 1.4 : .3;
        const keylockOn = state?.keylock && state?.keylockAvailable;
        deck.keylockMat.color.setHex(keylockOn ? 0xc6ff3d : state?.keylockAvailable ? 0x202618 : 0x0b0d09);
        deck.keylockMat.emissiveIntensity = keylockOn ? 1.5 : 0;
        for (const name of [`pitch-${side}`, `channel-${side}`]) {
          const p = LAYOUT[name], cap = faderCaps[name];
          const frac = name.startsWith('pitch') ? (clamp((state?.pitch || 0) / (state?.pitchRange || 10), -1, 1) + 1) / 2 : 1 - (state?.channel ?? 1);
          const nextZ = (p.y + p.h * frac - .5) * HEIGHT;
          if (cap.position.z !== nextZ) renderer.shadowMap.needsUpdate = true;
          cap.position.z = nextZ;
        }
        for (const [band] of eqBands) {
          const db = clamp(state?.eq?.[band] ?? 0, -26, 6);
          // Flat at twelve o'clock; cut sweeps left, boost sweeps right.
          const angle = -(db < 0 ? db / 26 : db / 6) * Math.PI * .75;
          const cap = eqCaps[`eq-${band}-${side}`];
          if (cap.rotation.y !== angle) renderer.shadowMap.needsUpdate = true;
          cap.rotation.y = angle;
        }
        loopBars.forEach(bars => {
          const m = loopLights[`loop${bars}-${side}`], on = state?.loop?.bars === bars;
          m.color.setHex(on ? 0xc6ff3d : 0x181d11); m.emissiveIntensity = on ? 1.6 : 0;
        });
        const key = `${state?.track?.id}|${state?.bar}|${state?.beat}`;
        if (key !== deck.beatKey && state?.playing) deck.pulse = 1;
        deck.beatKey = key;
      });
    }
  };
}
