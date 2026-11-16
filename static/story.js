/* Homepage story layer: a record crate beside the deck, a sleeve that lifts out, the record that drops onto the platter,
   and three USB sticks that fly in and idle. Driven by one number s in 0..3 (0 hero, 1 picks, 2 library, 3 page end).
   Everything lives inside the hero group (hero-local space: +z is "up" off the deck), so it tilts and scales with the deck.
   Models are the app's own: the crate geometry from crates3d.js and the stick blade from usbsticks.js (copied, not shared,
   so the /set and /crates choreography stays untouched). */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { plasticGeometry, logoTexture } from './crates3d.js';

const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const ease = t => { t = clamp(t, 0, 1); return t * .35 + t * t * (3 - 2 * t) * .65; };   // mostly smoothstep, never fully stopped, so chained moves flow
const soft = t => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };   // smootherstep: zero slope at both ends, for blends that must not kink
const seg = (s, a, b) => ease((s - a) / (b - a));          // eased progress of s inside [a, b]

const SC = 0.9;                                             // crate scale
const SLEEVE_IN = 1.06;                                     // sleeves standing in the crate: sized to reach the rim, resting on the floor
const SLEEVE_BIG = 1.3;                                     // the sleeve that leaves is drawn a touch larger so a 3.24 record fits inside it
const CRATE_AT = new THREE.Vector3(4.7, -3.3, -0.39 + 1.65 * SC);   // beside the deck, feet on the same table
const PLATTER_AT = new THREE.Vector3(-0.32, 0, 0.243);      // where the record rests (platter.position + record z)
const HOVER = 1.45;                                         // record height above the platter while it is lowered in
const SLEEVE_COLOURS = ['#252236', '#ddd3b9', '#633849', '#343f49', '#aa7663', '#222725', '#8e86a1', '#3a3350', '#c9b79b'];
const STICK_COLOURS = ['#c6ff3d', '#ff2e88', '#ff7a2e'];

function roundedShape(w, h, r, x = 0, y = 0, path = new THREE.Shape()) {
  const l = x - w / 2, b = y - h / 2, right = x + w / 2, top = y + h / 2;
  path.moveTo(l + r, b); path.lineTo(right - r, b); path.quadraticCurveTo(right, b, right, b + r);
  path.lineTo(right, top - r); path.quadraticCurveTo(right, top, right - r, top);
  path.lineTo(l + r, top); path.quadraticCurveTo(l, top, l, top - r);
  path.lineTo(l, b + r); path.quadraticCurveTo(l, b, l + r, b);
  return path;
}

export function createStory({ hero, deck, tonearm, record, geometries, materials, textures, accent }) {
  const keepG = g => { geometries.add(g); return g; };
  const keepM = m => { materials.add(m); return m; };
  const mesh = (parent, g, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o; };
  function extrude(shape, depth, bevel = .035) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: depth - bevel * 2, steps: 1, curveSegments: 14, bevelEnabled: bevel > 0,
      bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3 });
    g.translate(0, 0, -depth / 2 + bevel); return keepG(g);
  }

  const group = new THREE.Group(); hero.add(group);

  // ---- the record: one holder the story poses; the record inside it keeps spinning about its own axis
  const holder = new THREE.Group(); hero.add(holder);
  record.position.set(0, 0, 0); holder.add(record);

  // ---- the crate (rotated so its "up" is the deck's +z)
  const crate = new THREE.Group(); group.add(crate);
  crate.scale.setScalar(SC); crate.position.copy(CRATE_AT);
  const plastic = keepM(new THREE.MeshPhysicalMaterial({ color: '#7b3fe4', roughness: .32, clearcoat: .65, clearcoatRoughness: .25, metalness: 0, envMapIntensity: .65 }));
  accent(plastic, 'b');
  mesh(crate, keepG(plasticGeometry()), plastic);
  const logoMap = logoTexture('#fff'); textures.add(logoMap);
  const logoMat = keepM(new THREE.MeshBasicMaterial({ map: logoMap, transparent: true, depthWrite: false, toneMapped: false }));
  const logoGeo = keepG(new THREE.PlaneGeometry(2.12, .325));
  mesh(crate, logoGeo, logoMat, 0, -.035, 3.2 / 2 + .063);
  mesh(crate, logoGeo, logoMat, 3.4 / 2 + .063, -.035, 0).rotation.y = Math.PI / 2;
  document.fonts?.ready.then(() => { const fresh = logoTexture('#fff'); textures.add(fresh); logoMat.map = fresh; logoMat.needsUpdate = true; }).catch(() => {});

  const sleeveGeo = keepG(new RoundedBoxGeometry(2.86, 2.86, .055, 2, .018));
  const discGeo = keepG(new THREE.CylinderGeometry(1, 1, .027, 48)); discGeo.rotateX(Math.PI / 2);
  const discMat = keepM(new THREE.MeshStandardMaterial({ color: '#0c0c10', roughness: .37 }));
  const FRONT = 8;                                            // the front-most sleeve is the one that leaves
  const panelGeo = keepG(new RoundedBoxGeometry(2.86, 2.86, .03, 2, .012));
  // the front of the sleeve is printed edge to edge in the site's look: indigo -> pink wash, lava blobs, and the app icon's "w.f" with the lime dot
  const artCanvas = document.createElement('canvas'); artCanvas.width = artCanvas.height = 1024;
  function paintSleeve() {
    const x = artCanvas.getContext('2d'), W = 1024;
    const wash = x.createLinearGradient(0, 0, 0, W);
    wash.addColorStop(0, '#190d3a'); wash.addColorStop(.5, '#2d0f49'); wash.addColorStop(.82, '#5c1450'); wash.addColorStop(1, '#8c1b5d');
    x.fillStyle = wash; x.fillRect(0, 0, W, W);
    const blob = (cx, cy, rx, ry, a, b) => {
      const g = x.createRadialGradient(cx - rx * .3, cy - ry * .35, rx * .1, cx, cy, Math.max(rx, ry));
      g.addColorStop(0, a); g.addColorStop(1, b); x.fillStyle = g;
      x.beginPath(); x.ellipse(cx, cy, rx, ry, -.2, 0, Math.PI * 2); x.fill();
    };
    blob(790, 170, 190, 175, '#cf6af0', '#a23de6'); blob(190, 300, 170, 190, '#b46af5', '#8f3fe9');
    blob(520, 70, 80, 80, '#b563f6', '#9142ec'); blob(900, 620, 85, 90, '#ee4ab9', '#d02fb0'); blob(470, 760, 24, 24, '#b34ae6', '#a03dd9');
    const wave = x.createLinearGradient(0, 760, W, W);
    wave.addColorStop(0, '#b73fe0'); wave.addColorStop(1, '#ff2d8f'); x.fillStyle = wave;
    x.beginPath(); x.moveTo(0, W); x.lineTo(0, 860);
    x.bezierCurveTo(120, 880, 150, 760, 250, 740); x.bezierCurveTo(350, 720, 360, 850, 450, 850);
    x.bezierCurveTo(560, 850, 600, 760, 700, 790); x.bezierCurveTo(800, 820, 820, 900, W, 880); x.lineTo(W, W); x.closePath(); x.fill();
    // the lettering: same size as before (about 54% of the sleeve), w . f
    x.font = '900 300px Archivo, sans-serif'; if ('fontStretch' in x) x.fontStretch = 'expanded';
    x.textBaseline = 'alphabetic';
    const ww = x.measureText('w').width, wf = x.measureText('f').width, gap = 130, total = ww + gap + wf;
    const k = 552 / total, x0 = (W - 552) / 2, base = 618;
    x.save(); x.translate(x0, base); x.scale(k, k);
    x.fillStyle = '#fff'; x.shadowColor = 'rgba(20,5,40,.35)'; x.shadowBlur = 24; x.shadowOffsetY = 8;
    x.fillText('w', 0, 0); x.fillText('f', ww + gap, 0); x.shadowColor = 'transparent';
    const dg = x.createRadialGradient(ww + gap * .5 - 14, -34 - 14, 4, ww + gap * .5, -34, 50);
    dg.addColorStop(0, '#f4ffb0'); dg.addColorStop(.45, '#c6ff3a'); dg.addColorStop(1, '#a7e41a');
    x.fillStyle = dg; x.beginPath(); x.arc(ww + gap * .5, -40, 60, 0, Math.PI * 2); x.fill();
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,.14)'; x.lineWidth = 6; x.strokeRect(26, 26, W - 52, W - 52);
  }
  paintSleeve();
  const sleeveLogoMap = new THREE.CanvasTexture(artCanvas); sleeveLogoMap.colorSpace = THREE.SRGBColorSpace; sleeveLogoMap.anisotropy = 4; textures.add(sleeveLogoMap);
  document.fonts?.ready.then(() => { paintSleeve(); sleeveLogoMap.needsUpdate = true; }).catch(() => {});
  const sleeveLogoMat = keepM(new THREE.MeshBasicMaterial({ map: sleeveLogoMap, toneMapped: false }));
  const sleeveLogoGeo = keepG(new THREE.PlaneGeometry(2.82, 2.82));
  function sleeveAt(i, story) {
    const g = new THREE.Group();
    const m = keepM(new THREE.MeshStandardMaterial({ color: SLEEVE_COLOURS[i % SLEEVE_COLOURS.length], roughness: .87 }));
    if (story) { mesh(g, panelGeo, m, 0, 0, .05); mesh(g, panelGeo, m, 0, 0, -.05); mesh(g, sleeveLogoGeo, sleeveLogoMat, 0, 0, .068); }   // two sheets: the record lives between them
    else { mesh(g, sleeveGeo, m); const edge = mesh(g, discGeo, discMat, 0, .07, -.045); edge.scale.setScalar(1.43); }
    g.position.set(Math.sin(i * 4.1) * .035, .03 + Math.sin(i * 2.4) * .02, lerp(-1.28, 1.21, i / FRONT));   // y: bottom edge sits on the crate floor (-1.54)
    if (!story) g.scale.setScalar(SLEEVE_IN);
    g.rotation.z = Math.sin(i * 3.4) * .035;
    return g;
  }
  for (let i = 0; i < FRONT; i++) crate.add(sleeveAt(i));
  const sleeve = sleeveAt(FRONT, true); group.add(sleeve); sleeve.scale.setScalar(SC * SLEEVE_IN);
  const sleeveLocalRest = sleeve.position.clone();
  sleeve.position.set(0, 0, 0);

  // ---- the USB sticks (blade, plug and charcoal panel copied from usbsticks.js; no cap, no logo)
  const bladeShape = (inset = 0) => {
    const s = new THREE.Shape();
    s.moveTo(-.59 + inset, 1.03 - inset); s.lineTo(.59 - inset, 1.03 - inset);
    s.bezierCurveTo(.61 - inset, .38, .85 - inset, -.15, .875 - inset, -1.27);
    s.bezierCurveTo(.89 - inset, -1.78, .63 - inset, -2.05 + inset, 0, -2.05 + inset);
    s.bezierCurveTo(-.63 + inset, -2.05 + inset, -.89 + inset, -1.78, -.875 + inset, -1.27);
    s.bezierCurveTo(-.85 + inset, -.15, -.61 + inset, .38, -.59 + inset, 1.03 - inset);
    s.holes.push(roundedShape(.47, .37, .11, 0, -1.59, new THREE.Path()));
    return s;
  };
  const shellG = extrude(bladeShape(), .58, .055), edgeG = extrude(bladeShape(.035), .46, .035);
  const panelShape = new THREE.Shape();
  panelShape.moveTo(-.53, 1.01); panelShape.lineTo(.53, 1.01);
  panelShape.bezierCurveTo(.54, .27, .71, -.14, .69, -.98); panelShape.bezierCurveTo(.68, -1.52, -.68, -1.52, -.69, -.98);
  panelShape.bezierCurveTo(-.71, -.14, -.54, .27, -.53, 1.01);
  const panelG = extrude(panelShape, .10, .025);
  const plugShape = roundedShape(1.18, 1.10, .045, 0, 1.55);
  for (const x of [-.30, .30]) plugShape.holes.push(roundedShape(.23, .25, .025, x, 1.62, new THREE.Path()));
  const plugFaceG = extrude(plugShape, .095, .012);
  const plugBaseG = keepG(new RoundedBoxGeometry(1.18, 1.10, .30, 3, .035));
  const windowG = keepG(new THREE.PlaneGeometry(.24, .26)), contactG = keepG(new THREE.BoxGeometry(.13, .52, .012));
  const black = keepM(new THREE.MeshPhysicalMaterial({ color: '#090a0d', roughness: .2, clearcoat: 1, clearcoatRoughness: .16 }));
  const charcoal = keepM(new THREE.MeshStandardMaterial({ color: '#29292c', roughness: .9 }));
  const plugPlastic = keepM(new THREE.MeshPhysicalMaterial({ color: '#22252a', roughness: .49, metalness: .04 }));
  const windowBlack = keepM(new THREE.MeshStandardMaterial({ color: '#040608', roughness: .74 }));
  const gold = keepM(new THREE.MeshPhysicalMaterial({ color: '#bfa363', metalness: .8, roughness: .34 }));
  const sticks = STICK_COLOURS.slice(0, 0).map((c, i) => {
    const root = new THREE.Group(), pose = new THREE.Group(); pose.add(root); group.add(pose);
    const body = keepM(new THREE.MeshPhysicalMaterial({ color: c, roughness: .24, metalness: .03, clearcoat: 1, clearcoatRoughness: .14 }));
    mesh(root, shellG, body, 0, 0, -.045); mesh(root, edgeG, black, 0, .015, .045); mesh(root, panelG, charcoal, 0, 0, .31);
    mesh(root, plugBaseG, plugPlastic, 0, 1.55, -.035); mesh(root, plugFaceG, plugPlastic, 0, 0, .17);
    for (const x of [-.30, .30]) mesh(root, windowG, windowBlack, x, 1.62, .124);
    for (let k = 0; k < 4; k++) mesh(root, contactG, gold, -.42 + k * .28, 1.65, -.19);
    pose.visible = false;
    return { pose, root, i, phase: i * 2.094 };
  });
  // float spots and rest tilts, hero-local; each stick arrives from off the top-right, staggered
  const STICK_AT = [new THREE.Vector3(-3.1, -.1, 1.2), new THREE.Vector3(-4.8, -.1, 1.2), new THREE.Vector3(-6.5, -.1, 1.2)];   // one row, level with the deck, plugs pointing at it
  const STICK_TILT = new THREE.Euler(.3, -.12, -Math.PI / 2);
  const STICK_SCALE = .26;

  // ---- poses
  const qFlat = new THREE.Quaternion(), qWorld = new THREE.Quaternion(), heroInv = new THREE.Quaternion(), crateUp = new THREE.Vector3();
  const restPos = new THREE.Vector3(), tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1), tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpE = new THREE.Euler();
  const HOLD = new THREE.Vector3(PLATTER_AT.x - .2, PLATTER_AT.y - 3.5, PLATTER_AT.z + HOVER);   // where the opened sleeve hangs: flat, below the spot the deck lands in

  // ---- the sleeve's path (one designed move, replacing the stacked fixes of v1-v22):
  // a straight pull out of the crate's mouth, then ONE cubic arc (rise, over to the left, down into HOLD) joined with a matching
  // tangent, walked at constant arc-length speed under a single smootherstep: one swell of speed, zero speed at both ends.
  // Pure function of s (no time springs), preallocated (no garbage per frame).
  const LIFT = 2.6 * SC, PULL = [1.2, 2.4, 3.4], TOP = [3.85, 3.5], OVER = [.15, .44], SET_DOWN = 2.2, Q_END = .34, TWIST = .28, LEAN = .22, GROW_AT = .06, BEND_SLOW = 1.2;
  // LIFT: rise at which the bottom is clear of the rim (the crate's dip adds the rest). PULL: control points on the pull line.
  // TOP/OVER: the two points that carry the turn (height along the pull, fraction of the way across to HOLD). SET_DOWN: height of
  // the point above HOLD. Q_END: q when it lands. TWIST/LEAN: wrist turn and lean into the motion (radians). BEND_SLOW: how much
  // the hand slows through the turn. Change any of these and re-run the corner/rim scan (AGENTS.md).
  // A clamped uniform cubic B-spline: curvature is continuous everywhere (no corner, no sudden bend), and the curve is exactly
  // straight while four control points in a row are on one line. Control points: three on the pull line (straight out of the
  // mouth), one over the top towards HOLD, one straight above HOLD (it is set down from above), then HOLD.
  const CP = Array.from({ length: 12 }, () => new THREE.Vector3());   // rest x3, three on the pull line, two turning over the top, one above HOLD, HOLD x3
  const NSEG = CP.length - 3, PATH_N = NSEG * 16, pathCum = new Float32Array(PATH_N + 1);
  const pPrev = new THREE.Vector3(), dA = new THREE.Vector3(), dB = new THREE.Vector3();
  const horiz = new THREE.Vector3();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), vel = new THREE.Vector3(), leanAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0), qLean = new THREE.Quaternion(), recDir = new THREE.Vector3();
  const TILT = .19;   // the empty sleeve's tip once the record is out (rad, ~11 deg): its record-side edge dips AWAY from the record
  let pathLb = 0, pathLift = 0;
  const spl = (u, out) => {                                   // u in [0, NSEG]
    const k = Math.min(Math.floor(u), NSEG - 1), t = u - k, t2 = t * t, t3 = t2 * t;
    const b0 = (1 - t) * (1 - t) * (1 - t) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6;
    const a = CP[k], b = CP[k + 1], c = CP[k + 2], d = CP[k + 3];
    return out.set(a.x * b0 + b.x * b1 + c.x * b2 + d.x * b3, a.y * b0 + b.y * b1 + c.y * b2 + d.y * b3, a.z * b0 + b.z * b1 + c.z * b2 + d.z * b3);
  };
  function buildPath() {
    horiz.subVectors(HOLD, restPos); horiz.addScaledVector(crateUp, -horiz.dot(crateUp));   // across, ignoring height
    CP[0].copy(restPos); CP[1].copy(restPos); CP[2].copy(restPos);
    CP[3].copy(restPos).addScaledVector(crateUp, PULL[0]);
    CP[4].copy(restPos).addScaledVector(crateUp, PULL[1]);
    CP[5].copy(restPos).addScaledVector(crateUp, PULL[2]);
    CP[6].copy(restPos).addScaledVector(crateUp, TOP[0]).addScaledVector(horiz, OVER[0]);   // the turn is spread over two points
    CP[7].copy(restPos).addScaledVector(crateUp, TOP[1]).addScaledVector(horiz, OVER[1]);
    CP[8].copy(HOLD).addScaledVector(crateUp, SET_DOWN);
    CP[9].copy(HOLD); CP[10].copy(HOLD); CP[11].copy(HOLD);
    // time is spent by curvature, like a hand: slower where the arc bends hardest (w = sqrt(1 + BEND_SLOW * curvature)).
    // pathCum holds this "effort" length, so walking it evenly in time already slows into the turn and speeds out of it.
    spl(0, pPrev); spl(NSEG / PATH_N, pA);
    let eff = 0, liftEff = -1; pathCum[0] = 0;
    for (let i = 1; i <= PATH_N; i++) {
      spl(Math.min(i + 1, PATH_N) * NSEG / PATH_N, pB);
      dA.subVectors(pA, pPrev); dB.subVectors(pB, pA);
      const l = dA.length(), k = (i < PATH_N && l > 1e-6 && dB.lengthSq() > 1e-12) ? dA.angleTo(dB) / Math.max((l + dB.length()) / 2, 1e-6) : 0;
      eff += l * Math.sqrt(1 + BEND_SLOW * k); pathCum[i] = eff;
      if (liftEff < 0 && dA.subVectors(pA, restPos).dot(crateUp) >= LIFT) liftEff = eff;
      pPrev.copy(pA); pA.copy(pB);
    }
    pathLb = eff; pathLift = liftEff < 0 ? 1 : liftEff / eff;
  }
  function pathAt(p, out) {                                   // p = fraction of the path's effort length (see buildPath)
    const db = clamp(p, 0, 1) * pathLb; let lo = 0, hi = PATH_N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pathCum[m] < db) lo = m; else hi = m; }
    return spl((lo + (db - pathCum[lo]) / Math.max(pathCum[hi] - pathCum[lo], 1e-6)) * NSEG / PATH_N, out);
  }
  const pathP = q => soft(q / Q_END);                         // time -> distance: slow draw, one swell, slow landing
  function qAtP(p) { let lo = 0, hi = Q_END; for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (pathP(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

  function update(s, elapsed, reduced, deckStart = 17) {   // deckStart: how far left (hero units) the deck waits so it begins fully off-screen
    if (reduced) s = s < 1 ? s : 3;                            // reduced motion: records are simply on the deck
    const sIn = s;                                             // the sticks keep the page's own pace
    s = s < 1 ? s * 1.1 : 1.1 + (s - 1);                       // hero beats are timed for 0..1.1; squeeze them into the first stretch of scroll
    // crate leaves once the record is down and the deck takes the stage
    const gone = seg(s, .5, .98);   // the crate slides away right after the record is out, so the deck owns Picks
    const idle = reduced ? 0 : 1;
    crate.position.set(CRATE_AT.x + 9 * gone + Math.sin(elapsed * .6) * .08 * idle , CRATE_AT.y + 1.9 * seg(s, 0, .75) - 1.0 * seg(s, .45, .72) + 1.3 * gone + Math.sin(elapsed * .9) * .07 * idle,   // eases up as the camera pushes in, so it is never cropped at the bottom
       CRATE_AT.z + .8 * gone);
    crate.scale.setScalar(SC * (1 - .45 * gone));
    crate.visible = gone < .995;
    // upright like on the crates page; it turns towards us and tips back a little to offer the sleeve, then settles again
    // one continuous turn out and back (a smooth bump, peaking about a third of the way through): it never sits still while the deck slides in
    const tp = clamp((s - .02) / .7, 0, 1), turn = Math.pow(Math.sin(Math.PI * Math.pow(tp, .75)), 2);
    qWorld.setFromEuler(tmpE.set(.24 + .3 * turn + Math.sin(elapsed * .7) * .015 * idle, -.29 + .55 * turn + Math.sin(elapsed * .5) * .03 * idle, Math.sin(elapsed * .8) * .01 * idle + .12 * gone));
    crate.quaternion.copy(heroInv.copy(hero.quaternion).invert().multiply(qWorld));
    crate.updateMatrix();
    crateUp.set(0, 1, 0).applyQuaternion(crate.quaternion);

    // the sleeve's rest and lifted places follow the crate
    restPos.copy(sleeveLocalRest).applyMatrix4(crate.matrix);
    // once the sleeve is clear of the mouth the crate dips a little, so the sleeve's corner passes over the rim instead of through it.
    // The sleeve's path above is worked out from the un-dipped crate, so the dip opens a real gap between them.
    const dip = 2.2 * soft(s / .2);                            // the crate sinks away as the sleeve is drawn up: they part, so the pull can be short
    crate.position.addScaledVector(crateUp, -dip); crate.updateMatrix();   // along the crate's own axis, so the sleeve never slides sideways against a wall
    // Beats (q, after the remap): the sleeve is pulled out and flies to HOLD (0-.34), turning flat a beat after it lands (.37);
    // the record slides out of it towards the platter (.35-.53) while the deck glides in from the left (.45-.88); the empty sleeve
    // leaves to the lower right (.6-1.06); the record lowers (.84-.96) and the needle lands (.96-1.1).
    const slide = seg(s, .35, .53), lower = seg(s, .84, .96), needle = seg(s, .96, 1.1), deckIn = seg(s, .45, .88);
    buildPath();
    const p = pathP(s), pLift = pathLift, qLift = qAtP(pLift);
    pathAt(p, tmp);
    // velocity straight from the path (not frame deltas), so a still frame and a scrolled frame agree
    const h = .002;
    pathAt(pathP(s + h), pA); pathAt(pathP(s - h), pB);
    vel.subVectors(pA, pB).divideScalar(2 * h);
    const vMax = 1.875 * pathLb / Q_END;             // peak speed of a smootherstep
    // while the record is drawn out, the sleeve is tugged a touch after it and eases back: a hand holding it, not a clamp
    recDir.set(PLATTER_AT.x, PLATTER_AT.y, PLATTER_AT.z + HOVER).sub(HOLD).normalize();
    tmp.addScaledVector(recDir, .14 * Math.pow(Math.sin(Math.PI * slide), 2));
    const sg = soft((s - .6) / .46);                           // the empty sleeve leaves the way the crate does: drifting right and sinking
    tmp.x += 11 * sg; tmp.y -= 1.7 * sg;
    sleeve.position.copy(tmp);
    // stands as it does in the crate for the whole pull, then turns flat over the arc, finishing just after it lands (overlapping action)
    const hd = soft((s - qLift) / (Q_END + .03 - qLift));
    tmpQ.copy(crate.quaternion).slerp(qFlat, hd);
    tmpQ.multiply(tmpQ2.setFromAxisAngle(yAxis, Math.sin(Math.PI * hd) * TWIST));   // a turn of the wrist mid-flight: the face catches the light
    tmpQ.multiply(tmpQ2.setFromAxisAngle(up, -.35 * sg));      // and tips a little as it goes
    // once the record is fully out (slide ends .53) the empty sleeve tips slightly before it's carried off, so it doesn't just
    // float away flat; the edge nearest the record goes down, away from the record's plane (clipping scan: clearance grows)
    tmpQ.multiply(tmpQ2.setFromAxisAngle(xAxis, -TILT * soft((s - .54) / .16)));
    // lean: the top edge leads and the bottom trails, in proportion to the sideways speed (none at all during the straight pull)
    // (sideways = across the pull direction, which is fixed; measuring against the sleeve's own up would feed back on its turn and flick)
    leanAxis.crossVectors(crateUp, vel);
    const side = Math.min(leanAxis.length() / vMax, 1), lean = LEAN * side * side;   // squared: eases in from nothing as the pull bends into the arc
    if (lean > 1e-5) tmpQ.premultiply(qLean.setFromAxisAngle(leanAxis.normalize(), lean));
    sleeve.quaternion.copy(tmpQ);
    // it grows to wrap a full-size 12" mid-swing, where the speed hides it, once it is well clear of the rim
    const grow = soft((p - pLift - GROW_AT) / .4);
    sleeve.scale.setScalar(SC * lerp(SLEEVE_IN, SLEEVE_BIG, grow) * (1 - .45 * sg));
    sleeve.visible = sg < .995;

    // the record rides between the sleeve's two sheets (peeking over the top while it stands), slides UP out of the open edge, hangs,
    // then drops on the platter; the deck floats in from the left underneath it
    holder.visible = true;   // the record stays on the platter after the crate has left
    const k = sleeve.scale.x / (SC * SLEEVE_BIG * (1 - .45 * sg));        // record is drawn to fit its sleeve
    tmp.set(0, .07 * (1 - hd) * sleeve.scale.x, 0).applyQuaternion(sleeve.quaternion).add(sleeve.position);   // home: inside the sleeve
    holder.position.set(lerp(tmp.x, PLATTER_AT.x, slide), lerp(tmp.y, PLATTER_AT.y, slide), lerp(tmp.z, PLATTER_AT.z + HOVER, slide) - HOVER * lower);
    const wait = slide * (1 - lower) * (reduced ? 0 : 1);          // while it hangs waiting for the deck it floats gently
    holder.position.y += Math.sin(elapsed * 1.3) * .07 * wait;
    holder.quaternion.copy(sleeve.quaternion).slerp(qFlat, slide);
    holder.quaternion.multiply(tmpQ2.setFromAxisAngle(up, Math.sin(elapsed * .9) * .05 * wait));
    holder.scale.setScalar(lerp(k, 1, slide));
    // deck: a long slow glide in from the left (it is tilted and levels out as it arrives)
    // it leaves to the left behind the Picks list and glides back in from off-screen as Library arrives (the record travels with it)
    const away = 0;
    const dx = -22 * away;
    deck.visible = deckIn > .001;
    deck.position.set(-Math.max(17, deckStart) * (1 - deckIn) + dx, -1.7 * (1 - deckIn), 0);   // comes in from low-left, rising as it arrives: the opposite slant to the sleeve, which leaves to the lower right
    deck.rotation.z = .22 * (1 - deckIn) + .22 * away;
    holder.position.x += dx;
    const th = .5 * (1 - needle), cs = Math.cos(th), sn = Math.sin(th), PX = 1.7, PY = 1.23;   // rotate the arm about its pivot
    tonearm.rotation.z = th;
    tonearm.position.set(PX - (PX * cs - PY * sn), PY - (PX * sn + PY * cs), 0);
    const landed = needle;

    // sticks: fly in during the library beat, then float
    for (const st of sticks) {
      const t = seg(sIn, 1.3 + st.i * .12, 2.0 + st.i * .12);
      st.pose.visible = t > .001;
      if (!st.pose.visible) continue;
      const rest = STICK_AT[st.i], tilt = STICK_TILT;
      const bob = reduced ? 0 : 1;
      const run = 1 - Math.pow(1 - t, 3);                      // a plain slide in from the left that eases to a stop (no arc, no tumble)
      st.pose.position.set(rest.x - 14 * (1 - run), rest.y + Math.sin(elapsed * .9 + st.phase) * .06 * bob * t, rest.z);
      st.pose.rotation.set(tilt.x + Math.sin(elapsed * .5 + st.phase) * .04 * bob * t, tilt.y + Math.cos(elapsed * .43 + st.phase) * .05 * bob * t, tilt.z + Math.sin(elapsed * .6 + st.phase) * .03 * bob * t);
      st.pose.scale.setScalar(STICK_SCALE);
    }
    return landed;
  }

  // Pre-build everything (shaders, buffers, textures) in one hidden frame at load, so nothing stalls the first time it scrolls into view.
  function warm(on) {
    for (const root of [group, holder, deck]) root.traverse(o => { o.frustumCulled = !on; });
    if (on) { crate.visible = sleeve.visible = holder.visible = deck.visible = true; for (const st of sticks) st.pose.visible = true; }
  }

  function dispose() { hero.remove(group); hero.remove(holder); }
  if (typeof window !== 'undefined') window.__storyDebug = { crate, sleeve, holder, deck, sticks };   // read-only handle for motion tests
  return { update, dispose, group, warm };
}
