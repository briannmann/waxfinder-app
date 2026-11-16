/** Moulded milk crates and screen-tracked vinyl flights. All dimensions are local units. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const COLOURS = { purple: '#7b3fe4', sky: '#8ec5f0', sage: '#79b47e',
  pink: '#ff5fa8', amber: '#ffb23d', lime: '#c6ff3d' };
const CRATE_WIDTH = 3.4, CRATE_DEPTH = 3.2;
const CELL_WIDTH = 280, ROW_HEIGHT = 340, MODEL_HEIGHT = 5.15;
const TABLE_ROW = 68, TABLE_MODEL = 56;   // table view: a slim row per crate with its small 3D crate on the left
const REST_X = .24, REST_Y = -.29, HOVER_LIFT = 14;
// While hovered a crate keeps floating: bob (px), sway/roll (radians) and their speeds (rad/s).
const FLOAT_BOB = 6, FLOAT_SWAY = .07, FLOAT_ROLL = .025, FLOAT_SPEED = 1.7, HOVER_GROW = .035;
// Hover pop (2026-11-08): the records rise out of the crate a bit more while it is hovered, front ones first, back ones a little higher,
// so more of each record/cover shows. ROLLBACK: set HOVER_POP = false (or restore tools/ref/crates3d.before-hover-pop-2026-11-08.js).
// Top headroom (2026-11-08): the 3D drawing area starts TOP_ROOM px above the first row (pulled up with a negative margin, so the crates
// sit exactly where they did), so a hovered first-row crate can rise without its sleeves being cut off at the edge. 0 = old behaviour.
const TOP_ROOM = 60;
const HOVER_POP = true, POP_FRONT = .30, POP_BACK = .62, POP_SPREAD = .35;   // heights in sleeve units (a sleeve is 2.86 tall)
const FLIGHT_MS = 1250, STAGGER_MS = 52, MAX_STAGGER_MS = 650, FLY_MAX = 24;   // FLY_MAX: records that fly per open (the visible cards)
// Drag to reorder: mouse/pen starts after DRAG_PX of movement (so a click still opens); touch needs a HOLD_MS press first (so swipes still scroll).
const DRAG_PX = 6, HOLD_MS = 320, SETTLE = 14, DRAG_LIFT = 1.06;
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function roundedShape(w, h, r, x = 0, y = 0, path = new THREE.Shape()) {
  const l = x - w / 2, b = y - h / 2, right = x + w / 2, top = y + h / 2;
  path.moveTo(l + r, b); path.lineTo(right - r, b);
  path.quadraticCurveTo(right, b, right, b + r); path.lineTo(right, top - r);
  path.quadraticCurveTo(right, top, right - r, top); path.lineTo(l + r, top);
  path.quadraticCurveTo(l, top, l, top - r); path.lineTo(l, b + r);
  path.quadraticCurveTo(l, b, l + r, b);
  return path;
}

function extrude(shape, depth = .09, bevel = .012) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * bevel, steps: 1,
    curveSegments: 12, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2 });
  g.translate(0, 0, -depth / 2 + bevel);
  return g;
}

// Build one reusable wall with actual openings, then turn it onto all four sides.
function wallGeometry(width) {
  const parts = [];
  function box(w, h, d, x, y, z = 0, angle = 0) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.rotateZ(angle); g.translate(x, y, z); parts.push(g);
  }
  function panel(shape) { parts.push(extrude(shape)); }
  const header = roundedShape(width, .69, .045, 0, 1.285);
  header.holes.push(roundedShape(1.23, .37, .18, 0, 1.17, new THREE.Path()));
  panel(header);
  // Raised oval lip, leaving the handle completely open.
  const handle = roundedShape(1.39, .53, .26, 0, 1.17);
  handle.holes.push(roundedShape(1.23, .37, .18, 0, 1.17, new THREE.Path()));
  const lip = extrude(handle, .12); lip.translate(0, 0, .046); parts.push(lip);
  const skirt = roundedShape(width, .48, .04, 0, -1.39);
  for (let x = -width / 2 + .54; x < width / 2 - .3; x += .59)
    skirt.holes.push(roundedShape(.32, .085, .014, x, -1.25, new THREE.Path()));
  panel(skirt);
  box(width, .43, .10, 0, -.035);
  for (const x of [-width / 2 + .16, width / 2 - .16]) {
    box(.29, 2.77, .10, x, -.025);
    for (const dx of [-.13, .13]) box(.037, 3.16, .19, x + dx, 0, .045);
    for (const y of [-1.12, -.24, .2, .95, 1.42]) box(.32, .035, .20, x, y, .05);
  }
  for (const y of [-1.62, -1.12, -.255, .185, .95, 1.43, 1.62])
    box(width, .035, .18, 0, y, .045);
  // Clip each diagonal to its panel rectangle: no lattice sticking through the rails.
  const half = width / 2 - .32;
  for (const [bottom, top] of [[-1.10, -.27], [.21, .94]]) {
    for (const slope of [-1, 1]) {
      for (let intercept = bottom - half - .5; intercept < top + half + .5; intercept += .43) {
        const points = [];
        for (const x of [-half, half]) {
          const y = slope * x + intercept;
          if (y >= bottom && y <= top) points.push([x, y]);
        }
        for (const y of [bottom, top]) {
          const x = (y - intercept) / slope;
          if (x > -half && x < half) points.push([x, y]);
        }
        if (points.length !== 2) continue;
        const [[ax, ay], [bx, by]] = points;
        box(Math.hypot(bx - ax, by - ay), .036, .065,
          (ax + bx) / 2, (ay + by) / 2, .015, Math.atan2(by - ay, bx - ax));
      }
    }
  }
  const merged = mergeGeometries(parts); parts.forEach(g => g.dispose());
  return merged;
}

export function plasticGeometry() {
  const parts = [];
  for (let side = 0; side < 4; side++) {
    const g = wallGeometry(side % 2 ? CRATE_DEPTH : CRATE_WIDTH);
    g.translate(0, 0, (side % 2 ? CRATE_WIDTH : CRATE_DEPTH) / 2);
    g.rotateY(side * Math.PI / 2); parts.push(g);
  }
  function rail(w, h, d, x, y, z) {
    const g = new RoundedBoxGeometry(w, h, d, 2, .035);
    g.translate(x, y, z); parts.push(g);
  }
  for (const y of [-1.64, 1.65]) {
    for (const z of [-CRATE_DEPTH / 2, CRATE_DEPTH / 2]) rail(3.54, .105, .15, 0, y, z);
    for (const x of [-CRATE_WIDTH / 2, CRATE_WIDTH / 2]) rail(.15, .105, 3.25, x, y, 0);
  }
  // Open grid floor, visible through the lower lattice.
  for (let n = -1.4; n <= 1.4; n += .28) {
    rail(.035, .06, 3.1, n, -1.54, 0); rail(3.25, .06, .035, 0, -1.54, n);
  }
  const g = mergeGeometries(parts); parts.forEach(p => p.dispose()); return g;
}

export function logoTexture(ink = '#fff') {
  const art = document.createElement('canvas'); art.width = 1024; art.height = 160;
  const ctx = art.getContext('2d');
  ctx.clearRect(0, 0, 1024, 160); ctx.font = '900 116px Archivo, sans-serif';
  if ('fontStretch' in ctx) ctx.fontStretch = 'expanded';
  ctx.textBaseline = 'middle';
  const wax = ctx.measureText('wax').width, finder = ctx.measureText('finder').width;
  const total = wax + finder + 37;
  ctx.save(); ctx.translate(512, 84); ctx.scale(Math.min(1.2, 970 / total), 1);
  ctx.fillStyle = ink; ctx.fillText('wax', -total / 2, 0);
  const dot = -total / 2 + wax + 18;
  ctx.fillStyle = COLOURS.lime; ctx.beginPath();
  ctx.ellipse(dot, 14, 14, 13, -.18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = ink; ctx.fillText('finder', -total / 2 + wax + 37, 0); ctx.restore();
  const t = new THREE.CanvasTexture(art); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function shadowTexture() {
  const art = document.createElement('canvas'); art.width = art.height = 128;
  const c = art.getContext('2d'), gradient = c.createRadialGradient(64, 64, 12, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,.65)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gradient; c.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(art);
}

function configureRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  return renderer;
}

function lightScene(scene) {
  scene.add(new THREE.HemisphereLight(0xe8e5ff, 0x391021, 1.6));
  const key = new THREE.DirectionalLight(0xfff4e8, 3.1); key.position.set(-4, 7, 8); scene.add(key);
  const rim = new THREE.DirectionalLight(0xd6e7ff, 1.8); rim.position.set(5, 3, -2); scene.add(rim);
}

export function mountCrates(stageEl, { crates = [], onOpen, onReorder, onContext, mode: startMode = 'grid', draggable = true } = {}) {   // draggable:false = no reorder, no 'Drag to move' (home page foot crate)
  let mode = startMode === 'table' ? 'table' : 'grid';
  const originalMinHeight = stageEl.style.minHeight;
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  const overlays = document.createElement('div');
  overlays.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  const flightCanvas = document.createElement('canvas'); flightCanvas.setAttribute('aria-hidden', 'true');
  flightCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;display:none;';
  const scene = new THREE.Scene(), flightScene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 2000);
  const flightCamera = new THREE.PerspectiveCamera(38, 1, .1, 2000); flightCamera.position.z = 1000;
  camera.position.z = 1000;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const params = new URLSearchParams(location.search), raw = params.get('flyt');
  const forced = raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)) ? clamp(+raw, 0, 1) : null;
  const geometries = new Set(), materials = new Set(), textures = new Set();
  let renderer, flightRenderer, environment, observer, entries = [], flight = null;
  let dead = false, dirty = true, raf = 0, previous = 0, width = 1, height = 1, viewW = 1, viewH = 1, activeId = null;
  let slots = [], drag = null;
  let crateGeo, sleeveGeo, artGeo, logoGeo, discGeo, labelGeo, holeGeo, groovesGeo, shadowGeo, shadowMap, logoMaterial;
  const keepG = g => { geometries.add(g); return g; };
  const keepM = m => { materials.add(m); return m; };
  // Album art on the sleeves: each cover is loaded once, shrunk to 128px (only a strip of each sleeve shows above the crate wall;
  // ~50 crates of full-size textures would cost hundreds of MB of GPU memory) and shared by every sleeve that uses it.
  const artTex = new Map(), ART_PER_CRATE = 6;
  // Reload shuffle: a new random seed each time the page loads picks a different set of covers per crate; within one page load the
  // order is stable (a data refresh never makes the sleeves change under you).
  const shuffleSeed = String(Math.random());
  const shuffleKey = name => { let h = 2166136261; for (const ch of shuffleSeed + name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  function whenArt(name, apply) {
    const have = artTex.get(name);
    if (have?.tex) { apply(have.tex); return; }
    if (have) { have.waiting.push(apply); return; }
    const entry = { tex: null, waiting: [apply] }; artTex.set(name, entry);
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      const c = document.createElement('canvas'); c.width = c.height = 128; c.getContext('2d').drawImage(img, 0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; textures.add(t); entry.tex = t;
      for (const f of entry.waiting.splice(0)) f(t);
      invalidate();
    };
    img.onerror = () => artTex.delete(name);
    img.src = '/art/' + name + '.jpg';
  }
  const mesh = (parent, g, m, x = 0, y = 0, z = 0) => {
    const item = new THREE.Mesh(g, m); item.position.set(x, y, z); parent.add(item); return item;
  };

  function reveal(cards) { cards.forEach(card => card.classList.remove('pending')); }
  // The flying records: FLY_MAX of them, built once and reused by every open (own materials each, so each can fade
  // on its own). Before: every open built new materials (~40 ms of shader setup) and the end of each flight cleared the
  // scene's LIGHTS too, so every later flight compiled a fresh unlit shader (~90 ms stall) and flew flat records.
  let pool = null;
  function records() {
    if (!pool) pool = Array.from({ length: FLY_MAX }, () => {
      const surfaces = [new THREE.MeshStandardMaterial({ color: '#0c0c10', roughness: .31, metalness: .14, transparent: true }),
        // forceSinglePass: a transparent double-sided label is otherwise drawn in two passes that rebuild its shader
        // settings twice a frame; the label is flat, so one pass looks the same
        new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, transparent: true, forceSinglePass: true }),
        new THREE.MeshBasicMaterial({ color: '#060609', transparent: true }),
        new THREE.LineBasicMaterial({ color: '#77747e', transparent: true, opacity: .2 })].map(keepM);
      const root = new THREE.Group();
      mesh(root, discGeo, surfaces[0]); mesh(root, labelGeo, surfaces[1], 0, 0, .019);
      mesh(root, holeGeo, surfaces[2], 0, 0, .02);
      root.add(new THREE.LineSegments(groovesGeo, surfaces[3]));
      root.visible = false; flightScene.add(root);
      return { root, surfaces };
    });
    return pool;
  }
  // While the page is idle, draw every record once (the canvas is hidden): shaders compile and buffers upload then,
  // not on the first frame of the first flight.
  function warmFlight() {
    if (dead || flight) return;
    const all = records();
    all.forEach(r => { r.root.visible = true; r.root.position.set(0, 0, 0); r.root.scale.setScalar(20); });
    flightRenderer.compile(flightScene, flightCamera); flightRenderer.render(flightScene, flightCamera);
    all.forEach(r => { r.root.visible = false; });
  }
  function finishFlight() {
    if (!flight) return;
    const old = flight; flight = null;
    reveal(old.cards); old.records.forEach(r => { r.root.visible = false; });
    flightCanvas.style.display = 'none'; old.resolve();
  }
  function clearEntries() {
    for (const entry of entries) {
      scene.remove(entry.root, entry.shadow); entry.materials.forEach(m => m.dispose());
    }
    entries = []; overlays.replaceChildren();
  }
  function dispose() {
    if (dead) return; dead = true; cancelAnimationFrame(raf); finishFlight(); clearEntries();
    observer?.disconnect(); window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll); document.removeEventListener('visibilitychange', visibility);
    reduced.removeEventListener('change', motionChange); canvas.removeEventListener('webglcontextlost', lost);
    flightCanvas.removeEventListener('webglcontextlost', lost);
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    environment?.dispose(); renderer?.dispose(); flightRenderer?.dispose(); scene.clear(); flightScene.clear();
    canvas.remove(); overlays.remove(); flightCanvas.remove(); stageEl.style.minHeight = originalMinHeight; stageEl.style.marginTop = ''; stageEl.style.pointerEvents = '';
  }
  function lost(event) { event.preventDefault(); finishFlight(); dispose(); }
  // sceneChanged=false: only the flight overlay needs another frame, so the (large) crate canvas is left as drawn.
  function invalidate(sceneChanged = true) { if (sceneChanged) dirty = true; if (!dead && !raf && !document.hidden) raf = requestAnimationFrame(frame); }
  function onScroll() { invalidate(); }
  function visibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; finishFlight(); } else invalidate(); }
  function motionChange() { if (reduced.matches) finishFlight(); invalidate(); }

  try {
    // Construct both renderers before touching the stage so unsupported WebGL throws cleanly.
    renderer = configureRenderer(canvas); flightRenderer = configureRenderer(flightCanvas);
    const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    try { environment = pmrem.fromScene(room, .04); } finally { room.dispose(); pmrem.dispose(); }
    scene.environment = environment.texture; lightScene(scene); lightScene(flightScene);
    crateGeo = keepG(plasticGeometry()); sleeveGeo = keepG(new RoundedBoxGeometry(2.86, 2.86, .055, 2, .018));
    logoGeo = keepG(new THREE.PlaneGeometry(2.12, .325));
    discGeo = keepG(new THREE.CylinderGeometry(1, 1, .027, 64)); discGeo.rotateX(Math.PI / 2);
    artGeo = keepG(new THREE.PlaneGeometry(2.8, 2.8));
    labelGeo = keepG(new THREE.RingGeometry(.035, .224, 48));
    holeGeo = keepG(new THREE.CircleGeometry(.033, 16));
    const grooveVertices = [];
    for (let r = .33; r < .96; r += .055) for (let i = 0; i < 96; i++) {
      const a = i / 96 * Math.PI * 2, b = (i + 1) / 96 * Math.PI * 2;
      grooveVertices.push(Math.cos(a) * r, Math.sin(a) * r, .016,
        Math.cos(b) * r, Math.sin(b) * r, .016);
    }
    groovesGeo = keepG(new THREE.BufferGeometry());
    groovesGeo.setAttribute('position', new THREE.Float32BufferAttribute(grooveVertices, 3));
    shadowGeo = keepG(new THREE.PlaneGeometry(1, 1)); shadowMap = shadowTexture(); textures.add(shadowMap);
    stageEl.append(canvas, overlays); document.body.append(flightCanvas);
    canvas.addEventListener('webglcontextlost', lost); flightCanvas.addEventListener('webglcontextlost', lost);
    window.addEventListener('resize', resize, { passive: true }); window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', motionChange);
    update(crates); observer = new ResizeObserver(resize); observer.observe(stageEl);
    (window.requestIdleCallback || (f => setTimeout(f, 400)))(warmFlight, { timeout: 2500 });
    // Font readiness only affects the printed logo; layout is independent of font metrics.
    Promise.resolve(document.fonts?.ready).then(() => {
      if (dead) return;
      const print = ink => { const logo = logoTexture(ink); textures.add(logo);
        return keepM(new THREE.MeshBasicMaterial({ map: logo, transparent: true, depthWrite: false, toneMapped: false })); };
      const white = print('#fff');   // same white logo on every crate, even pale ones (user: keep it uniform)
      for (const entry of entries) addLogo(entry, white);
      logoMaterial = white; invalidate();
    }).catch(() => {});
    // Defer until the caller has assigned the returned API to its scene variable.
    const openId = params.get('open');
    if (openId !== null) requestAnimationFrame(() => { if (!dead && entries.some(e => String(e.crate.id) === openId)) onOpen?.(entries.find(e => String(e.crate.id) === openId).crate.id); });
    return { update, flyOut, close, dispose, fronts: () => entries.map(e => e.frontCover), setMode(m) { m = m === 'table' ? 'table' : 'grid'; if (m !== mode) { mode = m; resize(); } }, rectOf: id => entries.find(e => e.crate.id === id)?.button.getBoundingClientRect() };
  } catch (error) { dispose(); throw error; }

  // Table-row stats: total length, BPM range, energy spread, top two listing genres (confirmed tags only).
  function crateStats(tracks) {
    const here = tracks.filter(t => !t.missing), secs = here.reduce((n, t) => n + (t.dur || 0), 0);
    const bpms = here.filter(t => t.bpm).map(t => Math.round(t.bpm)), parts = [];
    if (secs) { const m = Math.round(secs / 60), h = Math.floor(m / 60); parts.push(['cst-t', (h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`) + (here.some(t => !t.dur) ? '+' : '')]); }
    if (bpms.length) { const lo = Math.min(...bpms), hi = Math.max(...bpms); parts.push(['cst-b', lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`]); }
    const tally = new Map();
    for (const t of here) for (const g of t.styles || []) tally.set(g, (tally.get(g) || 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(x => x[0]);
    for (const g of top) parts.push(['cst-g', g]);
    const spread = [0, 0, 0];
    for (const t of here) if (t.energy != null) { const e = Math.round(t.energy); spread[e <= 4 ? 0 : e <= 7 ? 1 : 2]++; }
    return { parts, spread };
  }
  function energyChart(spread) {
    const box = document.createElement('span'), most = Math.max(...spread), names = ['Mellow', 'Medium', 'High'];
    box.className = 'cspread'; box.style.display = 'none';
    box.title = `Energy: ${spread.map((n, i) => `${n} ${names[i].toLowerCase()}`).join(', ')}`;
    if (!most) return box;
    const head = document.createElement('b'); head.textContent = 'Energy'; box.append(head);
    spread.forEach((n, i) => {
      const col = document.createElement('span'), num = document.createElement('em'), well = document.createElement('span'), bar = document.createElement('i'), cap = document.createElement('small');
      col.className = 'csp-c csp-' + i; well.className = 'csp-w';
      num.textContent = n; bar.style.width = n ? `${Math.max(18, Math.round(100 * n / most))}%` : '0';
      cap.append(names[i], num); well.append(bar); col.append(well, cap); box.append(col);
    });
    return box;
  }
  function addLogo(entry, surface) {
    mesh(entry.root, logoGeo, surface, 0, -.035, CRATE_DEPTH / 2 + .063);
    const side = mesh(entry.root, logoGeo, surface, CRATE_WIDTH / 2 + .063, -.035, 0); side.rotation.y = Math.PI / 2;
  }
  function update(list) {
    if (dead) return; finishFlight(); clearEntries();
    const coverUse = new Map();   // how often each cover is already on a sleeve in an earlier crate: the fronts must not repeat crate after crate
    for (const [index, crate] of list.entries()) {
      const root = new THREE.Group(); scene.add(root);
      const owned = [], own = m => { owned.push(m); return m; };
      const colour = COLOURS[crate.colour] || crate.colour || COLOURS.purple;
      const plastic = own(new THREE.MeshPhysicalMaterial({ color: colour, roughness: .32,
        clearcoat: .65, clearcoatRoughness: .25, metalness: 0, envMapIntensity: .65 }));
      mesh(root, crateGeo, plastic);
      const records = [], count = crate.tracks?.length || 0;
      const sleeveColours = ['#252236', '#ddd3b9', '#633849', '#343f49', '#aa7663', '#222725', '#8e86a1'];
      const shown = count ? clamp(count, 3, 14) : 0;
      // Distinct covers from this crate's tracks, least-used-so-far first (ties broken by the per-load shuffle), so the FRONT sleeve of a crate
      // only repeats another crate's front when this crate has no other cover to offer. The front counts extra.
      const covers = [...new Set((crate.tracks || []).map(t => t.art).filter(Boolean))].sort((a, b) => (coverUse.get(a) || 0) - (coverUse.get(b) || 0) || shuffleKey(a) - shuffleKey(b));
      covers.slice(0, ART_PER_CRATE).forEach((c, k) => coverUse.set(c, (coverUse.get(c) || 0) + (k ? 1 : 6)));
      for (let i = 0; i < shown; i++) {
        const record = new THREE.Group(); root.add(record);
        const sleeve = own(new THREE.MeshStandardMaterial({ color: sleeveColours[(i + index) % sleeveColours.length], roughness: .87 }));
        mesh(record, sleeveGeo, sleeve);
        // The frontmost sleeves wear real covers (distinct covers from this crate's tracks, once they have been found).
        const cover = covers[shown - 1 - i];
        if (cover && i >= shown - ART_PER_CRATE) {
          const face = own(new THREE.MeshStandardMaterial({ roughness: .8, transparent: false })); face.visible = false;
          const plate = mesh(record, artGeo, face, 0, 0, .0285); plate.visible = false;
          whenArt(cover, tex => { if (dead || !plate.parent) return; face.map = tex; face.needsUpdate = true; plate.visible = true; face.visible = true; invalidate(); });
        }
        // A contrasting printed spine and a visible black vinyl edge among the sleeves.
        const spine = own(new THREE.MeshBasicMaterial({ color: i % 3 ? '#e0d7c7' : colour }));
        const line = mesh(record, logoGeo, spine, 0, 1.435, 0); line.rotation.x = -Math.PI / 2; line.scale.set(.8, .12, 1);
        const edge = mesh(record, discGeo, own(new THREE.MeshStandardMaterial({ color: '#0c0c10', roughness: .37 })), 0, .12, -.045);
        edge.scale.setScalar(1.43);
        record.position.set(Math.sin(i * 4.1) * .035, .72 + Math.sin(i * 2.4) * .13,
          shown === 1 ? 0 : lerp(-1.28, 1.21, i / (shown - 1)));
        record.rotation.z = Math.sin(i * 3.4) * .035;
        records.push({ root: record, y: record.position.y, angle: record.rotation.z });
      }
      const shadowMat = own(new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false, opacity: .8 }));
      const shadow = mesh(scene, shadowGeo, shadowMat);
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'wax-crate-button'; button.setAttribute('aria-label', `Open ${crate.name}, ${count} ${count === 1 ? "track" : "tracks"}`);
      button.style.cssText = 'position:absolute;border:0;padding:0;border-radius:18px;background:transparent;pointer-events:auto;cursor:pointer;touch-action:manipulation;';
      const label = document.createElement('span');
      label.style.cssText = 'position:absolute;left:0;right:0;bottom:0;display:grid;gap:3px;text-align:center;padding:0 8px;';
      const name = document.createElement('b'); name.textContent = crate.name;
      name.style.cssText = 'font:900 19px/1.2 Archivo,system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const number = document.createElement('small'); number.textContent = `${count} ${count === 1 ? 'track' : 'tracks'}`;
      number.style.cssText = 'font-size:12px;font-weight:600;opacity:.65;';
      const st = crateStats(crate.tracks || []), stats = document.createElement('span'); stats.className = 'cstats';
      const tn = document.createElement('span'); tn.className = 'cst-n'; tn.textContent = number.textContent; stats.append(tn);
      for (const [cls, text] of st.parts) { const c = document.createElement('span'); c.className = 'cst ' + cls; c.textContent = text; stats.append(c); }
      const spread = energyChart(st.spread); label.append(name, number, stats, spread); button.append(label); overlays.append(button);
      if (st.parts.length) button.setAttribute('aria-label', `Open ${crate.name}, ${[number.textContent, ...st.parts.map(p => p[1])].join(', ')}. ${spread.title}`);
      const entry = { frontCover: covers[0] || '', crate, root, records, button, shadow, label, name, number, stats, spread, materials: owned, hover: 0, pointer: false, focus: false, x: 0, y: 0, scale: 1 };
      const over = () => { entry.pointer = true; invalidate(); }, out = () => { entry.pointer = false; invalidate(); };
      button.addEventListener('pointerenter', over); button.addEventListener('pointerleave', out);
      button.addEventListener('focus', () => { entry.focus = true; invalidate(); });
      button.addEventListener('blur', () => { entry.focus = false; invalidate(); });
      button.addEventListener('click', () => { if (entry.noClick) { entry.noClick = false; return; } onOpen?.(crate.id); });
      if (draggable) dragHandlers(entry);
      entries.push(entry); if (logoMaterial) addLogo(entry, logoMaterial);
    }
    resize();
  }

  function resize() {
    if (dead) return;
    width = Math.max(1, stageEl.clientWidth);
    const table = mode === 'table', inset = table ? Math.abs(parseFloat(getComputedStyle(stageEl).marginLeft)) || 0 : 0;   // table rows line up with the page margin
    const columns = table ? 1 : Math.max(1, Math.min(entries.length || 1, Math.floor(width / (width <= 430 ? 175 : CELL_WIDTH))));
    const rows = Math.ceil(entries.length / columns), cell = table ? width - inset * 2 : Math.min(CELL_WIDTH, width / columns);
    const rowHeight = table ? TABLE_ROW : Math.min(ROW_HEIGHT, cell * 1.16 + 38), padding = table ? 8 : 20;
    const minHeight = entries.length ? (table ? rows * rowHeight + padding * 2 : Math.max(clamp(innerHeight * .58, 340, 620), rows * rowHeight + padding * 2)) : 0;
    const room = entries.length ? TOP_ROOM : 0;
    stageEl.style.marginTop = room ? `-${room}px` : '';
    stageEl.style.pointerEvents = room ? 'none' : '';   // the stage now reaches up over the toolbar edge: clicks fall through (crate buttons and the canvas overlay still take their own)
    stageEl.style.minHeight = `${Math.ceil(minHeight + room)}px`; height = Math.max(1, stageEl.clientHeight);
    camera.left = -width / 2; camera.right = width / 2; camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(width, height, false);
    viewW = innerWidth; viewH = innerHeight; flightCamera.aspect = viewW / viewH; flightCamera.updateProjectionMatrix();
    flightRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); flightRenderer.setSize(viewW, viewH, false);
    slots = [];
    for (let i = 0; i < entries.length; i++) {
      const row = Math.floor(i / columns), inRow = Math.min(columns, entries.length - row * columns);
      const left = table ? inset : (width - inRow * cell) / 2 + i % columns * cell;
      const top = room + (height - room - rows * rowHeight) / 2 + row * rowHeight;
      const modelPixels = table ? TABLE_MODEL : Math.min(cell * 1.08, rowHeight - 55);
      slots.push({ left, top, cell, rowHeight, scale: modelPixels / MODEL_HEIGHT,
        x: table ? left + 14 + TABLE_MODEL * .62 - width / 2 : left + cell / 2 - width / 2, y: table ? height / 2 - top - rowHeight / 2 : height / 2 - top - modelPixels * .54 });
    }
    layout(true);
  }
  // Put each crate in its slot (entries order = page order). Crates glide there in frame(); snap on first layout.
  function layout(snap = false) {
    for (const [i, entry] of entries.entries()) {
      const s = slots[i]; if (!s) continue;
      entry.scale = s.scale; entry.x = s.x; entry.y = s.y;
      if (snap && entry.dx === undefined || !Number.isFinite(entry.dx)) { entry.dx = s.x; entry.dy = s.y; }
      const table = mode === 'table', b = entry.button.style;
      b.left = `${s.left + (table ? 0 : 6)}px`; b.top = `${s.top}px`;
      b.width = `${s.cell - (table ? 0 : 12)}px`; b.height = `${s.rowHeight - (table ? 0 : 12)}px`;
      b.borderRadius = table ? '14px' : '18px'; b.borderBottom = table ? '1px solid rgba(255,255,255,.18)' : '0';
      const narrow = s.cell < 560;
      entry.label.style.cssText = table
        ? `position:absolute;left:104px;right:22px;top:0;bottom:0;display:grid;grid-template-columns:minmax(0,1fr)${narrow ? '' : ' auto'};align-content:center;column-gap:20px;row-gap:3px;text-align:left;padding:0;`
        : 'position:absolute;left:0;right:0;bottom:0;display:grid;gap:3px;text-align:center;padding:0 8px;';
      entry.name.style.gridColumn = table ? '1' : ''; entry.number.style.display = table ? 'none' : ''; entry.stats.style.display = table ? '' : 'none';
      entry.spread.style.display = table && !narrow && entry.spread.childElementCount ? 'flex' : 'none';
      entry.name.style.fontSize = table ? '18px' : '19px'; entry.number.style.fontSize = table ? '13px' : '12px';
      entry.shadow.scale.set(table ? TABLE_MODEL * 1.05 : s.cell * .93, table ? TABLE_MODEL * .24 : s.cell * .22, 1);
    }
    invalidate();
  }
  // ---- drag to reorder ----
  function stagePoint(e) {   // pointer -> scene units (origin at stage centre, +y up), same space as entry.x/y
    const r = stageEl.getBoundingClientRect();
    return { x: e.clientX - r.left - width / 2, y: height / 2 - (e.clientY - r.top) };
  }
  function nearestSlot(x, y) {
    let best = 0, bd = Infinity;
    slots.forEach((s, i) => { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function beginDrag(entry, e) {
    const p = stagePoint(e);
    drag = { entry, offX: entry.dx - p.x, offY: entry.dy - p.y, from: entries.map(x => x.crate.id).join() };
    entry.dragging = true; entry.noClick = true; entry.pointer = true;
    entry.button.style.cursor = 'grabbing'; stageEl.style.cursor = 'grabbing';
    if (navigator.vibrate && e.pointerType === 'touch') try { navigator.vibrate(8); } catch {}
    invalidate();
  }
  function moveDrag(e) {
    if (!drag) return;
    const p = stagePoint(e), entry = drag.entry;
    entry.dx = p.x + drag.offX; entry.dy = p.y + drag.offY;
    const to = nearestSlot(entry.dx, entry.dy), at = entries.indexOf(entry);
    if (to !== at) { entries.splice(at, 1); entries.splice(to, 0, entry); layout(); }
    invalidate();
  }
  function endDrag() {
    if (!drag) return;
    const entry = drag.entry, changed = entries.map(x => x.crate.id).join() !== drag.from;
    entry.dragging = false; entry.button.style.cursor = 'pointer'; stageEl.style.cursor = '';
    drag = null;
    const focused = document.activeElement;
    overlays.append(...entries.map(x => x.button));   // DOM (tab) order follows the new visual order
    if (focused && focused.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
    if (changed) onReorder?.(entries.map(x => x.crate.id));
    setTimeout(() => { entry.noClick = false; }, 60);   // only the click that ends THIS drag is swallowed
    invalidate();
  }
  function moveBy(entry, step) {   // keyboard: Alt + arrow keys
    const at = entries.indexOf(entry), to = clamp(at + step, 0, entries.length - 1);
    if (to === at) return;
    entries.splice(at, 1); entries.splice(to, 0, entry); layout();
    overlays.append(...entries.map(x => x.button)); entry.button.focus({ preventScroll: true });
    onReorder?.(entries.map(x => x.crate.id));
  }
  function dragHandlers(entry) {
    const b = entry.button; let down = null, hold = 0;
    const cancelHold = () => { clearTimeout(hold); hold = 0; };
    b.title = 'Drag to move';
    b.addEventListener('pointerdown', e => {
      if (e.button !== 0 || flight) return;
      down = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === 'touch', armed: e.pointerType !== 'touch' };
      if (down.touch) hold = setTimeout(() => { if (down) { down.armed = true; try { b.setPointerCapture(down.id); } catch {} beginDrag(entry, e); } }, HOLD_MS);
    });
    b.addEventListener('pointermove', e => {
      if (!down || e.pointerId !== down.id) return;
      if (drag?.entry === entry) { moveDrag(e); return; }
      const far = Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX;
      if (down.touch) { if (far) { cancelHold(); down = null; } return; }   // a swipe: let the page scroll
      if (far && down.armed) { try { b.setPointerCapture(e.pointerId); } catch {} beginDrag(entry, e); moveDrag(e); }
    });
    const up = () => { cancelHold(); down = null; if (drag?.entry === entry) endDrag(); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', () => { if (drag?.entry === entry) endDrag(); });
    b.addEventListener('touchmove', e => { if (drag?.entry === entry) e.preventDefault(); }, { passive: false });   // no scrolling mid-drag
    b.addEventListener('contextmenu', e => {
      if (down?.touch) { e.preventDefault(); return; }   // long-press is ours
      if (onContext) { e.preventDefault(); cancelHold(); down = null; onContext(entry.crate.id, e); }   // right-click menu (Export...)
    });
    b.addEventListener('keydown', e => {
      if (!e.altKey) return;
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (step) { e.preventDefault(); moveBy(entry, step); }
    });
  }

  function flyOut(crateId, cards, clip) {   // clip: scrolling panel the cards sit in; cards scrolled out of it land at once, no flight
    finishFlight(); activeId = crateId;
    const entry = entries.find(e => e.crate.id === crateId), targets = Array.from(cards || []);
    if (dead || reduced.matches || document.hidden || !entry || !targets.length) { reveal(targets); return Promise.resolve(); }
    // Only cards you can see inside the panel get a record (the first FLY_MAX of them); the rest are just shown.
    // A 217-track crate used to build 217 records with 868 materials and read 217 positions every frame.
    const seen = clip ? targets.filter(c => {
      let y = 0, n = c; while (n && n !== clip && n !== clip.offsetParent) { y += n.offsetTop; n = n.offsetParent; }
      if (n !== clip) y -= clip.offsetTop;
      return y < clip.scrollTop + clip.clientHeight && y + c.offsetHeight > clip.scrollTop;
    }) : targets;
    const flyers = seen.slice(0, FLY_MAX), flying = new Set(flyers);
    reveal(targets.filter(c => !flying.has(c)));
    if (!flyers.length) return Promise.resolve();
    return new Promise(resolve => {
      const pool = records(), labelColour = COLOURS[entry.crate.colour] || entry.crate.colour || COLOURS.purple;
      // Last record lands by 1.9s even for very large crates.
      const stagger = flyers.length > 1 ? Math.min(STAGGER_MS, MAX_STAGGER_MS / (flyers.length - 1)) : 0;
      entry.root.updateMatrixWorld(true); scene.updateMatrixWorld(true);
      const origin = new THREE.Vector3(0, 1.8, 0).applyMatrix4(entry.root.matrixWorld).project(camera);
      const bounds = stageEl.getBoundingClientRect();
      const start = { x: bounds.left + (origin.x + 1) * width / 2, y: bounds.top + (1 - origin.y) * height / 2 };
      const list = flyers.map((card, i) => {
        const { root, surfaces } = pool[i]; surfaces[1].color.set(labelColour); root.visible = false;
        return { root, surfaces, card, disc: card.querySelector('.disc'), delay: i * stagger, landed: false, index: i, rect: null };
      });
      flight = { cards: flyers, records: list, resolve, start, entry, t: 0, last: null, duration: FLIGHT_MS + stagger * (flyers.length - 1) };
      flightCanvas.style.display = 'block'; invalidate();
    });
  }

  function close() { activeId = null; finishFlight(); invalidate(); }

  function drawFlight(now) {
    if (!flight) return false;
    // Flight time moves by at most ~2 frames per frame: a slow frame (GPU busy) pauses the records for a moment
    // instead of making them jump ahead.
    const f = flight;
    if (forced === null) { f.t += f.last == null ? 0 : Math.min(now - f.last, 34); f.last = now; }
    const elapsed = forced === null ? f.t : forced * f.duration;
    let unfinished = false;
    // Read every landing rectangle first, then change anything: a class change between two reads forced a fresh
    // layout of the whole panel for each record.
    for (const record of f.records) record.rect = record.disc?.isConnected && record.card.isConnected ? record.disc.getBoundingClientRect() : null;
    for (const record of f.records) {
      const { root, card, index, rect } = record;
      if (!rect) { root.visible = false; if (!record.landed) card.classList.remove('pending'); record.landed = true; continue; }
      const p = clamp((elapsed - record.delay) / FLIGHT_MS, 0, 1);
      root.visible = elapsed >= record.delay;
      // The live landing rectangle, including the pending card's CSS transform.
      const targetX = rect.left + rect.width / 2, targetY = rect.top + rect.height / 2;
      const travel = 1 - (1 - p) ** 2, arc = Math.sin(Math.PI * p);
      const x = lerp(f.start.x, targetX, travel) + Math.sin(index * 2.4) * arc * 55;
      const y = lerp(f.start.y, targetY, travel) - arc * Math.min(240, viewH * .3);
      const z = arc * (80 + index % 3 * 18), distance = flightCamera.position.z - z;
      const upp = 2 * distance * Math.tan(THREE.MathUtils.degToRad(19)) / viewH;
      root.position.set((x - viewW / 2) * upp, (viewH / 2 - y) * upp, z);
      // Screen-sized at every depth; exactly the HTML circle's diameter on arrival.
      const radius = lerp(clamp(f.entry.scale * 1.1, 30, 65), rect.width / 2, smooth(p));
      root.scale.setScalar(radius * upp);
      root.rotation.set((1 - smooth(p)) * (.75 + Math.sin(p * 5) * .5),
        arc * Math.sin(index * 1.7) * .7, (1 - smooth(p)) * (index * .8 + p * 4.3));
      if (p >= 1 && !record.landed) { card.classList.remove('pending'); record.landed = true; }
      // The card fades in beneath a full-size disc before the 3D disc recedes.
      const fade = smooth((elapsed - record.delay - FLIGHT_MS) / 200);
      record.surfaces.forEach((m, i) => { m.opacity = (1 - fade) * (i === 3 ? .2 : 1); });
      root.scale.multiplyScalar(1 - fade * .1); root.visible &&= fade < 1;
      if (fade < 1) unfinished = true;
    }
    flightRenderer.render(flightScene, flightCamera);
    if (!unfinished) finishFlight();
    return forced === null && unfinished;
  }

  function frame(now) {
    raf = 0; if (dead) return;
    const redraw = dirty; dirty = false;
    // Only the slice of the (very tall) stage near the viewport is drawn; crates outside it are hidden.
    const sr = stageEl.getBoundingClientRect(), bandTop = clamp(-sr.top - 240, 0, height), bandBottom = clamp(-sr.top + innerHeight + 240, 0, height);
    const dt = previous ? Math.min((now - previous) / 1000, .05) : 1 / 60; previous = now;
    let moving = false;
    for (const entry of entries) {
      const target = reduced.matches ? 0 : Number(entry.pointer || entry.focus);
      entry.hover = lerp(entry.hover, target, 1 - Math.exp(-dt * 15));
      if (Math.abs(target - entry.hover) < .001) entry.hover = target; else moving = true;
      const h = entry.hover;
      if (h > 0) { entry.floatT = (entry.floatT || 0) + dt * FLOAT_SPEED; moving = true; } else entry.floatT = 0;   // keep floating while held over
      const kk = mode === 'table' ? .35 : 1;
      const t = entry.floatT || 0, bob = Math.sin(t) * FLOAT_BOB * kk * h * (entry.dragging ? 0 : 1);
      if (!entry.dragging) {   // glide to its slot (after a reorder or a drop)
        const k = 1 - Math.exp(-dt * SETTLE);
        entry.dx = lerp(entry.dx ?? entry.x, entry.x, k); entry.dy = lerp(entry.dy ?? entry.y, entry.y, k);
        if (Math.abs(entry.dx - entry.x) < .3 && Math.abs(entry.dy - entry.y) < .3) { entry.dx = entry.x; entry.dy = entry.y; } else moving = true;
      }
      const half = entry.scale * 3.2 + HOVER_LIFT + 24, sy = height / 2 - entry.dy;
      entry.root.visible = entry.shadow.visible = sy + half > bandTop && sy - half < bandBottom;
      entry.root.position.set(entry.dx, entry.dy + h * HOVER_LIFT * kk + bob, entry.dragging ? 300 : 0);   // dragged crate draws on top
      entry.root.scale.setScalar(entry.scale * (1 + h * HOVER_GROW) * (entry.dragging ? DRAG_LIFT : 1));
      entry.shadow.position.set(entry.dx, entry.dy - entry.scale * 1.92 - (entry.dragging ? 10 : 0), -500);
      entry.shadow.material.opacity = entry.dragging ? .5 : .8;
      // the name/count label (and the hit area) travel with the crate while it's dragged or gliding home
      const ox = entry.dx - entry.x, oy = entry.y - entry.dy, tf = Math.abs(ox) + Math.abs(oy) > .5 ? `translate(${ox.toFixed(1)}px,${oy.toFixed(1)}px)` : '';
      if (entry.button.style.transform !== tf) entry.button.style.transform = tf;
      entry.button.style.zIndex = entry.dragging ? '2' : '';
      const bg = mode === 'table' && h > .01 ? `rgba(255,255,255,${(.1 * h).toFixed(3)})` : 'transparent';
      if (entry.bg !== bg) { entry.bg = bg; entry.button.style.background = bg; }
      entry.root.rotation.set(REST_X - h * .06 + Math.sin(t * .8) * FLOAT_ROLL * h, REST_Y + h * .09 + Math.sin(t * .65 + 1) * FLOAT_SWAY * h, -h * .02 + Math.sin(t * .9 + 2) * FLOAT_ROLL * h);
      for (const [i, record] of entry.records.entries()) {   // records jostle a little in the crate as it floats
        let pop = 0;
        if (HOVER_POP && !entry.dragging) {
          const n = entry.records.length, rank = n > 1 ? (n - 1 - i) / (n - 1) : 0;   // 0 = frontmost sleeve, 1 = backmost
          const q = clamp((h - rank * POP_SPREAD) / (1 - POP_SPREAD), 0, 1);          // front sleeves start first: a quick cascade
          pop = q * q * (3 - 2 * q) * lerp(POP_FRONT, POP_BACK, rank);
        }
        record.root.position.y = record.y + pop + h * (.035 + i % 3 * .022) + Math.sin(t * 1.9 + i * 1.3) * .018 * h;
        record.root.rotation.z = record.angle + h * Math.sin(i * 2.1) * .03 + Math.sin(t * 1.4 + i) * .012 * h;
      }
      entry.button.setAttribute('aria-expanded', String(entry.crate.id === activeId));
    }
    if ((redraw || moving) && bandBottom > bandTop) {
      renderer.setScissorTest(true); renderer.setScissor(0, height - bandBottom, width, bandBottom - bandTop);
      renderer.render(scene, camera);
    }
    const flying = drawFlight(now);
    if (moving) invalidate(); else if (flying) invalidate(false);
  }
}
