/**
 * Three unbranded blade drives: margin sweeps → cap release → CDJ insertion.
 * Tweak COLOURS, PATHS (viewport half-extents + world depth), and PORTS below.
 * Local +Y is the connector, +Z the charcoal face; all motion is real 3D.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const COLOURS = ['#c6ff3d', '#ff2e88', '#ff4d2e'];
const PATHS = [
  [[.78, .66, .4], [.96, .15, -.8], [.82, -.64, .9], [-.12, -.86, .1], [-.91, -.35, -.6], [-.82, .30, .5], [-.70, .50, 0]],
  [[-.83, .52, -.6], [-.94, -.20, .6], [-.80, -.78, -.7], [.18, -.88, .5], [.94, -.23, .8], [.80, .42, -.5], [.18, .02, .4], [.36, -.58, .2], [.74, -.66, 0]],
  [[1.02, .24, -.1], [.87, .66, .7], [.22, .86, -.6], [-.86, .66, .3], [-.95, -.45, .8], [.67, -.72, -.6], [.82, .38, 0]],
];
// The decks' transparent canvas headroom differs from the raised mixer screen.
const PORTS = [{ x: .25, y: .133 }, null, { x: .75, y: .133 }]; // [1] (pink) rests as the set-list button instead
// Collision: a stick spans ~-2.05 (tail) → +2.3 (plug tip, cap on) local units, so a
// sphere of RADIUS×scale covers it (used by layerDepths).
const RADIUS = 2.5;
// Capless stick: tail -2.05 → plug tip ~+2.13 long, 1.75 wide (local units).
const BLADE_LENGTH = 4.2, BLADE_WIDTH = 1.75;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const ease = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// smootherstep: zero speed AND zero acceleration at both ends (no visible "kick" when a phase starts/stops)
const ease5 = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// even cruise with gentle 20% ramps (peak speed 1.25× average instead of smoothstep's 1.5×)
const cruise = t => {
  const a = .2, v = 1 / (1 - a);
  return t < a ? v * t * t / (2 * a) : t > 1 - a ? 1 - v * (1 - t) * (1 - t) / (2 * a) : v * (t - a / 2);
};
// Timeline (scroll progress 0→1). Docking overlaps the end of the flight so the hand-off never stops dead,
// sticks finish turning before they reach the port, and the insert only starts once they've arrived.
const FLY_END = .80;
const DECK = { dock: [.66, .95], turn: [.62, .90], insert: [.955, 1] };
const BENCH = { dock: [.80, .985], turn: [.72, .95] };   // pink: its button only scrolls into view late
// Pace by distance as SEEN on screen: x spans ~1.8× the pixels of y, depth barely moves anything.
const SCREEN_W = [1.8, 1, .25];
function paceTable(curve, n = 400) {
  const lut = new Float32Array(n + 1), a = new THREE.Vector3(), b = new THREE.Vector3();
  curve.getPoint(0, a);
  for (let k = 1; k <= n; k++) {
    curve.getPoint(k / n, b);
    lut[k] = lut[k - 1] + Math.hypot((b.x - a.x) * SCREEN_W[0], (b.y - a.y) * SCREEN_W[1], (b.z - a.z) * SCREEN_W[2]);
    a.copy(b);
  }
  return lut;
}
function paced(lut, u) {          // fraction of on-screen distance -> curve parameter
  const n = lut.length - 1, want = clamp(u, 0, 1) * lut[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lut[m] < want) lo = m; else hi = m; }
  const span = lut[hi] - lut[lo] || 1;
  return (lo + (want - lut[lo]) / span) / n;
}
const bezier = (out, p0, p1, p2, p3, t) => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return out.set(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y, a * p0.z + b * p1.z + c * p2.z + d * p3.z);
};

/** Mount after .bg. Returns a cleanup function; narrow/reduced-motion views omit it. */
export function mountUSBSticks() {
  const background = document.querySelector('body > .bg');
  if (!background) return () => {};
  const wide = matchMedia('(min-width: 760px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const raw = new URLSearchParams(location.search).get('usbt');
  const forced = raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))
    ? clamp(Number(raw), 0, 1) : null;
  let active = null, failed = false;

  function reconcile() {
    if (!wide.matches || reduced.matches || failed) {
      active?.dispose();
      active = null;
    } else if (!active) {
      active = createScene(background, forced, () => { failed = true; active = null; });
      if (!active) failed = true;
    }
  }
  wide.addEventListener('change', reconcile);
  reduced.addEventListener('change', reconcile);
  reconcile();
  return () => {
    wide.removeEventListener('change', reconcile);
    reduced.removeEventListener('change', reconcile);
    active?.dispose();
    active = null;
  };
}

function createScene(background, forced, onFailure) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'wax-usbsticks';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:-1;';
  background.after(canvas);
  const scene = new THREE.Scene();
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 60);
  camera.position.z = 16;
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(19));
  let renderer, environment, observer;
  let dead = false, raf = 0, previous = 0, elapsed = 0;
  let width = 1, height = 1, endpoint = 1, target = 0, scroll = 0, controller = null;
  let hover = 0, hovered = false;
  // The pink stick's click target. Layout (CSS below) places it; the stick follows it.
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'wax-usb-back';
  back.setAttribute('aria-label', 'Back to the set list'); back.title = 'Back to the set list';
  back.addEventListener('pointerenter', () => { hovered = true; });
  back.addEventListener('pointerleave', () => { hovered = false; });
  back.addEventListener('focus', () => { hovered = true; });
  back.addEventListener('blur', () => { hovered = false; });
  back.addEventListener('click', () => {
    const list = document.getElementById('result');
    const to = list && !list.hidden ? list : document.querySelector('.setup') || document.body;
    const nav = document.querySelector('.nav')?.getBoundingClientRect().height || 0;   // sticky header
    window.scrollTo({ top: to.getBoundingClientRect().top + window.scrollY - nav - 16,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  if (!document.getElementById('wax-usb-back-css')) {
    const css = document.createElement('style'); css.id = 'wax-usb-back-css';
    css.textContent = `.wax-usb-back{position:absolute;right:clamp(8px,2%,28px);top:calc(100% + 48px);transform:translateY(-50%);width:clamp(120px,10.5%,180px);aspect-ratio:${(BLADE_LENGTH / BLADE_WIDTH).toFixed(3)};padding:0;border:0;border-radius:999px;background:transparent;cursor:pointer;visibility:hidden}
.wax-usb-back.on{visibility:visible}
.wax-usb-back:focus-visible{outline:3px solid #c6ff3d;outline-offset:4px}`;
    document.head.append(css);
  }
  document.getElementById('decks-sec')?.append(back);
  const flight = new THREE.Vector3(), landing = new THREE.Vector3();
  const tangent = new THREE.Vector3(), from0 = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
  const FROM_ABOVE = new THREE.Vector3(0, 1, 0), FROM_LEFT = new THREE.Vector3(-1, .3, 0).normalize();
  const capOffset = new THREE.Vector3();
  const rotation = new THREE.Euler(), capRotation = new THREE.Euler();
  const spinQuaternion = new THREE.Quaternion();
  const drives = [];

  function geometry(item) { geometries.add(item); return item; }
  function material(options) {
    const item = new THREE.MeshPhysicalMaterial(options);
    materials.add(item);
    return item;
  }
  function mesh(parent, shape, surface, x = 0, y = 0, z = 0) {
    const item = new THREE.Mesh(shape, surface);
    item.position.set(x, y, z);
    parent.add(item);
    return item;
  }
  function roundedShape(w, h, r, x = 0, y = 0, path = new THREE.Shape()) {
    const l = x - w / 2, b = y - h / 2, right = x + w / 2, top = y + h / 2;
    path.moveTo(l + r, b);
    path.lineTo(right - r, b); path.quadraticCurveTo(right, b, right, b + r);
    path.lineTo(right, top - r); path.quadraticCurveTo(right, top, right - r, top);
    path.lineTo(l + r, top); path.quadraticCurveTo(l, top, l, top - r);
    path.lineTo(l, b + r); path.quadraticCurveTo(l, b, l + r, b);
    return path;
  }
  function extrude(shape, depth, bevel = .035) {
    const item = new THREE.ExtrudeGeometry(shape, {
      depth: depth - bevel * 2, steps: 1, curveSegments: 16,
      bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3,
    });
    item.translate(0, 0, -depth / 2 + bevel);
    return geometry(item);
  }
  function bladeShape(inset = 0, hole = true) {
    // Curved waist and a broad rounded tail, rather than a rectangular thumb drive.
    const s = new THREE.Shape();
    s.moveTo(-.59 + inset, 1.03 - inset);
    s.lineTo(.59 - inset, 1.03 - inset);
    s.bezierCurveTo(.61 - inset, .38, .85 - inset, -.15, .875 - inset, -1.27);
    s.bezierCurveTo(.89 - inset, -1.78, .63 - inset, -2.05 + inset, 0, -2.05 + inset);
    s.bezierCurveTo(-.63 + inset, -2.05 + inset, -.89 + inset, -1.78, -.875 + inset, -1.27);
    s.bezierCurveTo(-.85 + inset, -.15, -.61 + inset, .38, -.59 + inset, 1.03 - inset);
    if (hole) s.holes.push(roundedShape(.47, .37, .11, 0, -1.59, new THREE.Path()));
    return s;
  }
  function dispose() {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', fail);
    scene.environment = null;
    environment?.dispose();
    for (const item of geometries) item.dispose();
    for (const item of materials) item.dispose();
    for (const item of textures) item.dispose();
    renderer?.dispose();
    scene.clear();
    canvas.remove();
    back.remove();
  }
  function fail(event) {
    event?.preventDefault();
    dispose();
    onFailure();
  }

  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    try { environment = pmrem.fromScene(room, .04); }
    finally { room.dispose(); pmrem.dispose(); }
    scene.environment = environment.texture;
    scene.add(new THREE.HemisphereLight(0xe8e5ff, 0x461425, 2));
    const key = new THREE.DirectionalLight(0xfff0de, 3.4);
    key.position.set(-4, 6, 8); scene.add(key);
    const rim = new THREE.DirectionalLight(0xc5d3ff, 2.2);
    rim.position.set(6, -1, 3); scene.add(rim);

    // One tiny deterministic data texture shared by every charcoal panel.
    const data = new Uint8Array(128 * 128 * 4);
    let seed = 303;
    for (let i = 0; i < data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const shade = 155 + (seed >>> 26);
      data[i] = data[i + 1] = data[i + 2] = shade; data[i + 3] = 255;
    }
    const grain = new THREE.DataTexture(data, 128, 128, THREE.RGBAFormat);
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
    grain.repeat.set(5, 9); grain.needsUpdate = true; textures.add(grain);
    const charcoal = material({ color: '#29292c', roughness: .91, roughnessMap: grain,
      bumpMap: grain, bumpScale: .009, metalness: 0, envMapIntensity: .8 });
    const black = material({ color: '#090a0d', roughness: .2, clearcoat: 1, clearcoatRoughness: .16 });
    const plugPlastic = material({ color: '#22252a', roughness: .49, metalness: .04 });
    const windowBlack = material({ color: '#040608', roughness: .74 });
    const gold = material({ color: '#bfa363', metalness: .8, roughness: .34 });
    const shellGeometry = extrude(bladeShape(), .58, .055);
    const edgeGeometry = extrude(bladeShape(.035), .46, .035);
    // Inset panel stops before the lanyard eye; the eye cuts right through the shell.
    const panelShape = new THREE.Shape();
    panelShape.moveTo(-.53, 1.01); panelShape.lineTo(.53, 1.01);
    panelShape.bezierCurveTo(.54, .27, .71, -.14, .69, -.98);
    panelShape.bezierCurveTo(.68, -1.52, -.68, -1.52, -.69, -.98);
    panelShape.bezierCurveTo(-.71, -.14, -.54, .27, -.53, 1.01);
    const panelGeometry = extrude(panelShape, .10, .025);
    const plugShape = roundedShape(1.18, 1.10, .045, 0, 1.55);
    for (const x of [-.30, .30])
      plugShape.holes.push(roundedShape(.23, .25, .025, x, 1.62, new THREE.Path()));
    const plugFaceGeometry = extrude(plugShape, .095, .012);
    const plugBaseGeometry = geometry(new RoundedBoxGeometry(1.18, 1.10, .30, 3, .035));
    const windowGeometry = geometry(new THREE.PlaneGeometry(.24, .26));
    const contactGeometry = geometry(new THREE.BoxGeometry(.13, .52, .012));
    const capShape = roundedShape(1.38, .76, .12);
    capShape.holes.push(roundedShape(1.18, .54, .07, 0, 0, new THREE.Path()));
    const capTubeGeometry = extrude(capShape, 1.27, .022);
    const capEndGeometry = geometry(new RoundedBoxGeometry(1.38, .12, .76, 3, .055));

    for (let i = 0; i < 3; i++) {
      const root = new THREE.Group(); scene.add(root);
      const colour = material({ color: COLOURS[i], roughness: .24, metalness: .03,
        clearcoat: 1, clearcoatRoughness: .14 });
      mesh(root, shellGeometry, colour, 0, 0, -.045);
      mesh(root, edgeGeometry, black, 0, .015, .045);
      mesh(root, panelGeometry, charcoal, 0, 0, .31);
      // Pink only: "SETLIST" printed in white on the charcoal panel, fading in as it
      // lands so people know the resting stick is the way back to the set list.
      let labelMaterial = null;
      if (i === 1) {
        const art = document.createElement('canvas'); art.width = 1024; art.height = 300;
        const label = new THREE.CanvasTexture(art);
        label.colorSpace = THREE.SRGBColorSpace; label.anisotropy = 8; textures.add(label);
        const paint = () => {
          const g = art.getContext('2d');
          g.clearRect(0, 0, art.width, art.height);
          g.font = '900 172px Archivo, ui-sans-serif, system-ui, sans-serif';
          if ('fontStretch' in g) g.fontStretch = 'expanded';
          if ('letterSpacing' in g) g.letterSpacing = '10px';
          g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('SETLIST', art.width / 2, art.height / 2 + 8, art.width - 60);
          label.needsUpdate = true;
        };
        paint();
        document.fonts?.load('900 172px Archivo').then(paint, () => {});
        labelMaterial = new THREE.MeshBasicMaterial({ map: label, transparent: true, opacity: 0,
          depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
        materials.add(labelMaterial);
        const plate = new THREE.Mesh(geometry(new THREE.PlaneGeometry(2.1, .615)), labelMaterial);
        // text runs along the stick (local +Y), which points right once it lies flat
        plate.position.set(0, -.22, .365); plate.rotation.z = Math.PI / 2;
        root.add(plate);
      }
      mesh(root, plugBaseGeometry, plugPlastic, 0, 1.55, -.035);
      mesh(root, plugFaceGeometry, plugPlastic, 0, 0, .17);
      for (const x of [-.30, .30]) mesh(root, windowGeometry, windowBlack, x, 1.62, .124);
      for (let c = 0; c < 4; c++) mesh(root, contactGeometry, gold, -.42 + c * .28, 1.65, -.19);
      const cap = new THREE.Group(); scene.add(cap);
      const capMaterial = material({ color: COLOURS[i], roughness: .18, clearcoat: 1,
        clearcoatRoughness: .12, transparent: true });
      const tube = mesh(cap, capTubeGeometry, capMaterial);
      tube.rotation.x = -Math.PI / 2;
      mesh(cap, capEndGeometry, capMaterial, 0, .635, 0);
      const phase = i * 2.094;
      const turn = Math.PI * 2;
      // Equivalent full turns keep the final Euler blend continuous, including
      // when an idle tumble crosses the quaternion shortest-path boundary.
      // Decks take two sticks: lime → deck A, orange → deck B. Pink (i = 1) lands
      // flat in the bottom-right corner under the decks, connector pointing right,
      // and doubles as the "back to the set list" button.
      const bench = i === 1, restZ = bench ? -Math.PI / 2 : Math.PI;
      const dockRotation = new THREE.Euler(bench ? 0 : .10,
        turn * Math.round((phase * .47 + .79 * Math.PI * 3) / turn),
        restZ + turn * Math.round((-.40 + phase + .79 * Math.PI * 4 - restZ) / turn));
      drives.push({ root, cap, capMaterial, dockRotation, bench, labelMaterial,
        path: new THREE.CatmullRomCurve3(PATHS[i].map(p => new THREE.Vector3(...p)), false, 'centripetal'), lut: null,
        release: .35 + i * .045, phase });
    }
    resize();
    scroll = forced ?? target;
    observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', fail);
    start();
    return { dispose };
  } catch {
    dispose();
    return null;
  }

  // Layout reads happen on resize/content changes, never on ordinary flight frames.
  function measure() {
    if (dead) return;
    controller = document.querySelector('#decks-sec .wax-controller');
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - height);
    // The sticks must be plugged in by the time the "Mix it" headline is fully in view. Progress reaches 1 when that headline's bottom edge
    // sits 62% down the screen: the headline is whole, and the CDJ ports just under it are on screen to receive the sticks.
    // (Past this point the live port is the target, so the sticks stay plugged in as the page scrolls on.)
    const head = document.querySelector('#decks-sec h2');
    const want = head ? head.getBoundingClientRect().bottom + window.scrollY - height * .62
      : controller ? controller.getBoundingClientRect().top + window.scrollY - height * .2 : maxScroll;
    endpoint = Math.max(1, Math.min(maxScroll, want));
    onScroll();
  }
  function resize() {
    if (dead) return;
    width = window.innerWidth; height = window.innerHeight;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setSize(width, height, false);
    measure();
  }
  function onScroll() { target = forced ?? clamp(window.scrollY / endpoint, 0, 1); }
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf); raf = 0; previous = 0;
    } else start();
  }
  function start() {
    if (!dead && !raf && !document.hidden) {
      previous = 0;
      raf = requestAnimationFrame(frame);
    }
  }
  // Never let two sticks cut through each other, without moving them on screen:
  // when two get close on screen, the later stick (orange behind pink behind lime)
  // slides back in depth just enough for the bounding spheres to clear. Their scale
  // follows depth, so screen size and position stay exactly the same; only the
  // drawing order changes. Weights ramp smoothly with screen distance: no jumps.
  function layerDepths(weight) {
    for (const d of drives) d.zOff = 0;
    if (weight <= 0) return;
    const rPx = RADIUS * clamp(width * .145, 145, 220) / 4.4;     // screen radius of a stick
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
        const A = drives[a], B = drives[b];
        const d = Math.hypot((A.fx - B.fx) * width * .5, (A.fy - B.fy) * height * .5);
        const near = 1 - ease(2 * rPx, 3.2 * rPx, d);
        if (near <= 0) continue;
        const zA = A.bz + A.zOff, zB = B.bz + B.zOff;
        const upp = 2 * (camera.position.z - (zA + zB) * .5) * tanHalfFov / height;
        const gap = 2 * rPx * upp;                                 // world depth that clears them
        const short = Math.max(0, gap - (zA - zB)) * near * weight * .5;
        A.zOff += short; B.zOff -= short;
      }
    }
  }
  function frame(now) {
    raf = 0;
    if (dead || document.hidden) return;
    const dt = previous ? Math.min((now - previous) / 1000, .05) : 1 / 60;
    previous = now;
    // A forced progress also freezes idle time, making the test hook repeatable.
    if (forced === null) elapsed += dt;
    scroll = forced ?? lerp(scroll, target, 1 - Math.pow(.92, dt * 60));
    const p = scroll;
    // The only per-frame layout read: all three ports share this rectangle.
    const rect = p > DECK.dock[0] - .01 && controller ? controller.getBoundingClientRect() : null;
    const benchRect = rect ? back.getBoundingClientRect() : null;
    hover = lerp(hover, hovered ? 1 : 0, 1 - Math.pow(.85, dt * 60));
    const hasPort = rect && rect.width > 0 && rect.height > 0;
    const insertion = ease5(DECK.insert[0], DECK.insert[1], p);
    const time = elapsed;
    const pathProgress = cruise(clamp(p / FLY_END, 0, 1));
    const motionProgress = pathProgress * .79;
    // screen-space flight positions first (arc-length, so long and short segments move at the same speed)
    for (const drive of drives) {
      const T = drive.bench ? BENCH : DECK;
      drive.dock = hasPort ? ease5(T.dock[0], T.dock[1], p) : 0;
      drive.turn = hasPort ? ease5(T.turn[0], T.turn[1], p) : 0;
      drive.lut ??= paceTable(drive.path);
      drive.t = paced(drive.lut, pathProgress);
      drive.path.getPoint(drive.t, flight);
      const orbit = drive.phase + p * Math.PI * 4 + time * .16;
      drive.fx = flight.x + Math.sin(orbit) * .045 * (1 - drive.turn);
      drive.fy = flight.y + Math.cos(orbit * .9) * .045 * (1 - drive.turn);
      drive.bz = flight.z;
    }
    layerDepths(1 - Math.max(...drives.map(d => d.dock)));
    // Ports keep scrolling up while sticks land. Aim at where each port WILL sit when the scroll finishes
    // (a fixed screen spot, so no drop-then-rise), then hand over to the live port for the last few %.
    // Past the arrival point the live port is the target, so sticks stay plugged in as the page scrolls on.
    const ahead = Math.min(0, window.scrollY - endpoint);   // px the port still has to climb (0 once the page is at/after the arrival point)
    const lock = ease5(.93, 1, p);
    const aimY = top => top + ahead * (1 - lock);
    for (let i = 0; i < 3; i++) {
      const drive = drives[i], root = drive.root, dk = drive.dock, tn = drive.turn;
      const z = lerp(drive.bz + drive.zOff, .1, dk);
      const halfH = (camera.position.z - z) * tanHalfFov;
      const halfW = halfH * camera.aspect;
      const unitsPerPixel = 2 * halfH / height;
      const flightScale = clamp(width * .145, 145, 220) * unitsPerPixel / 4.4;
      const dockScale = !hasPort ? flightScale : drive.bench
        ? benchRect.width * unitsPerPixel / BLADE_LENGTH
        : rect.width * .028 * unitsPerPixel / 1.75;
      const scale = lerp(flightScale, dockScale, dk);
      root.scale.setScalar(scale);
      drive.scale = scale;
      root.position.set(drive.fx * halfW, drive.fy * halfH, z);
      rotation.set(
        lerp(-.50 + Math.sin(motionProgress * 8 + drive.phase + time * .19) * .68, drive.dockRotation.x, tn),
        lerp(drive.phase * .47 + motionProgress * Math.PI * 3 + Math.sin(time * .23) * 1.15 * (1 - tn), drive.dockRotation.y, tn),
        lerp(-.40 + drive.phase + motionProgress * Math.PI * 4 + Math.sin(time * .13) * .55 * (1 - tn), drive.dockRotation.z, tn),
      );
      root.quaternion.setFromEuler(rotation);
      if (hasPort && dk > 0) {
        if (drive.bench) {
          // Rest over the button; while the button is still below the fold, wait at the bottom edge instead of diving off-screen.
          const cy = Math.min(aimY(benchRect.top + benchRect.height * .5), height - benchRect.height * .6 + lock * height);
          landing.set((benchRect.left + benchRect.width * .5 - width * .5) * unitsPerPixel, (height * .5 - cy + hover * 4) * unitsPerPixel, .1);
        } else {
          const port = PORTS[i];
          landing.set(
            (rect.left + rect.width * port.x - width * .5) * unitsPerPixel,
            (height * .5 - aimY(rect.top) - rect.height * port.y) * unitsPerPixel + lerp(2.32, -.50, insertion) * scale,
            .1,
          );
        }
        // Curved hand-off: leave along the flight direction, arrive along the approach (decks: down from above; pink: slides in from the left).
        from0.copy(root.position);
        drive.path.getTangent(Math.min(drive.t, .999), tangent);
        tangent.set(tangent.x * halfW, tangent.y * halfH, tangent.z).normalize();
        const reach = from0.distanceTo(landing) * .42;
        c1.copy(from0).addScaledVector(tangent, reach);
        c2.copy(landing).addScaledVector(drive.bench ? FROM_LEFT : FROM_ABOVE, reach);
        bezier(root.position, from0, c1, c2, landing, dk);
        if (drive.bench && hover > .001) {
          rotation.set(rotation.x - hover * .08, rotation.y + Math.sin(time * 3) * hover * .02, rotation.z);
          root.quaternion.setFromEuler(rotation);
        }
      }
    }
    const benchDock = drives[1].dock;
    for (const drive of drives) if (drive.labelMaterial) drive.labelMaterial.opacity = ease(.82, 1, drive.dock);
    const benchOn = benchDock > .98;
    if (benchOn !== back.classList.contains('on')) back.classList.toggle('on', benchOn);
    for (let i = 0; i < 3; i++) {
      const drive = drives[i], root = drive.root, scale = drive.scale;
      const z = root.position.z;
      const halfH = (camera.position.z - z) * tanHalfFov, halfW = halfH * camera.aspect;
      // Slide straight off +Y, then spin and fall in world space; reversible on scroll-up.
      const release = ease(drive.release, drive.release + .19, p);
      const drift = ease(drive.release + .055, drive.release + .24, p);
      drive.cap.visible = release < 1;
      if (drive.cap.visible) {
        capOffset.set(0, 1.68 + release * 1.85, 0).multiplyScalar(scale).applyQuaternion(root.quaternion);
        drive.cap.position.copy(root.position).add(capOffset);
        drive.cap.position.x += (i === 1 ? -1 : 1) * drift * halfW * .9;
        drive.cap.position.y -= drift * drift * halfH * 2.6;
        drive.cap.position.z += Math.sin(drive.phase) * drift * 1.4;
        drive.cap.scale.setScalar(scale);
        capRotation.set(drift * 5, drift * (i + 2), drift * 6);
        spinQuaternion.setFromEuler(capRotation);
        drive.cap.quaternion.copy(root.quaternion).multiply(spinQuaternion);
        drive.capMaterial.opacity = 1 - ease(.55, 1, release);
      }
    }
    try { renderer.render(scene, camera); }
    catch { fail(); return; }
    raf = requestAnimationFrame(frame);
  }
}
