import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createStory } from './story.js';

const TAU = Math.PI * 2;
const DEFAULT_PALETTE = { a: '#ff2e88', b: '#6a3bff', c: '#c6ff3d' };

// The scroll choreography. heroPos x/y use viewport HALF extents at the hero's
// depth; z, cameraPos and cameraTarget use world units. Rotations are radians.
// Adjust these four poses to change the composition without editing animation.
//     p       placement             viewing angle / scale
const KEYFRAMES = [
  // s=0 hero: the crate on the right, nipping the end of the headline (a little overlap, not a lot)
  { p: 0, heroPos: [0.28, 0.3, 0], heroRot: [-0.62, -0.2, -0.12], heroScale: 0.58,
    cameraPos: [0, 0.15, 12.2], cameraTarget: [0, 0, 0], fov: 37 },
  // s=0.5 mid-story: sleeve out, record sliding free, deck arriving. Staged low and right, under the download form, so the
  // busy part never crosses the headline or the buttons. (Whole-group moves only: nothing moves relative to anything else.)
  { p: 1 / 6, heroPos: [0.25, -0.24, 0.1], heroRot: [-0.56, -0.04, -0.08], heroScale: 0.6,
    cameraPos: [0.12, 0.22, 12.0], cameraTarget: [0, 0.02, 0], fov: 37.5 },
  // s=1 picks: the record is on the platter; the deck sits right of centre, clear of the form
  { p: 1 / 3, heroPos: [0.24, -0.12, 0.2], heroRot: [-0.5, 0.12, -0.04], heroScale: 0.82,
    cameraPos: [0.25, 0.3, 11.8], cameraTarget: [0, 0.05, 0], fov: 38 },
  // s=2 library: crate gone, sticks arrive
  { p: 2 / 3, heroPos: [0.42, 0.3, 0.1], heroRot: [-0.7, -0.22, 0.04], heroScale: 0.88,
    cameraPos: [-0.2, 0.0, 12], cameraTarget: [0, 0, 0], fov: 37 },
  // s=3 end: the deck, playing, with the sticks floating
  { p: 1, heroPos: [0.38, -0.5, 0], heroRot: [-0.6, 0.12, 0.06], heroScale: 0.74,
    cameraPos: [0.1, 0.2, 12.4], cameraTarget: [0, 0, 0], fov: 36 },
];

// x/y are viewport half extents at EACH prop's depth, so the scatter also fits
// portrait screens. Most opening positions leave the headline's left half clear.
// type, opening x/y, final x/y, depth, scale, deterministic animation seed.
const PROP_LAYOUT = [
  ['record', 0.91, 0.93, -0.85, 0.88, -5.8, 0.5, 13],
  ['record', 1.03, -0.58, 0.88, -0.68, 2.8, 0.35, 29],
  ['record', 0.25, 1.17, -0.19, 1.05, -2.4, 0.42, 43],
  ['record', 0.42, -1.04, -0.9, -0.85, -4.6, 0.47, 61],
  ['record', -1.04, -0.84, -0.86, 0.16, 1.9, 0.26, 79],
  ['glass', 0.99, 0.3, 0.9, 0.55, -3.4, 0.5, 97],
  ['headphones', 0.64, 0.79, -0.8, -0.58, -2.1, 0.69, 113],
  ['headphones', 0.74, -0.78, 0.91, 0.12, 2.6, 0.48, 137],
  ['knob', 0.15, -0.94, 0.43, -0.93, 3, 1.05, 151],
  ['knob', 0.91, -0.07, -0.24, -0.84, -4.1, 1.34, 173],
  ['knob', -0.91, 0.91, -0.96, 0.72, -5.2, 1.4, 191],
  ['knob', 0.44, 1.08, 0.52, 0.9, 1.4, 0.86, 211],
  ['fader', 0.12, 0.98, -0.62, 0.96, -3.5, 0.72, 233],
  ['fader', 1.02, -0.97, 0.87, -0.95, 2.2, 0.72, 251],
  ['jog', 1.02, 0.83, 0.94, -0.26, -5.4, 0.94, 277],
];

const STORY_MODE = true;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = (t) => t * t * (3 - 2 * t);

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function drawingSurface(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The DJ scene needs Canvas 2D texture support.');
  return { canvas, context };
}

/**
 * Procedural DJ sculpture for an existing, CSS-sized, full-viewport canvas.
 * Optional opts: onReady(), palette: {a,b,c}, postprocessing: false.
 * The host page owns canvas positioning, pointer-events and the gradient.
 */
export function initScene(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('initScene requires a canvas element.');
  }

  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometryCache = new Map();
  const accentBindings = [];
  const palette = {};
  const paletteTargets = {};
  for (const key of ['a', 'b', 'c']) {
    palette[key] = new THREE.Color(DEFAULT_PALETTE[key]);
    paletteTargets[key] = palette[key].clone();
  }

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  canvas.style.opacity = '0'; canvas.style.transition = 'opacity .35s ease'; setTimeout(() => { if (canvas.style.opacity === '0') { canvas.style.opacity = '1'; canvas.style.visibility = ''; } }, 4000);   // fades in once the warm-up is done and a real frame is on the canvas
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 60);
  const hero = new THREE.Group();
  scene.add(hero);
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionPreference.matches;
  let disposed = false;
  let contextLost = false;
  let raf = 0;
  let previousTime = 0;
  let elapsed = 0;
  let scroll = 0;
  let scrollTarget = 0;
  let storyTarget = 0;   // 0 hero, 1 picks, 2 library, 3 end: which beat of the story we are in (page.html works it out from the section positions)
  let storyS = 0, storyV = 0, scrollV = 0;   // values + velocities of the two springs (see spring())
  let warmFrames = 2, hiddenForWarm = false;
  let storyLanded = 0;   // 1 once the record is down on the platter: only then does it spin
  let spinning = false;
  let spinSpeed = 0;
  let spinAngle = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerTargetX = 0;
  let pointerTargetY = 0;
  let width = 1;
  let height = 1;
  let hasSize = false;
  let ready = false;
  let degraded = false;
  let averageFrameMs = 16.67;
  let slowFrames = 0;
  let composer = null;
  let renderPass = null;
  let bokeh = null;
  let outputPass = null;
  let environmentTarget = null;
  let postTarget = null;

  const cameraTarget = new THREE.Vector3();
  const cameraRight = new THREE.Vector3();
  const cameraUp = new THREE.Vector3();
  const cameraBack = new THREE.Vector3();
  const focusPoint = new THREE.Vector3();
  const instanceTransform = new THREE.Object3D();

  function geometry(key, create) {
    if (!geometryCache.has(key)) {
      const item = create();
      geometryCache.set(key, item);
      geometries.add(item);
    }
    return geometryCache.get(key);
  }

  function material(options, physical = false) {
    const item = physical
      ? new THREE.MeshPhysicalMaterial(options)
      : new THREE.MeshStandardMaterial(options);
    materials.add(item);
    return item;
  }

  function accent(item, key, property = 'color') {
    item[property].copy(palette[key]);
    accentBindings.push({ material: item, key, property });
    return item;
  }

  function canvasTexture(surface, color = true) {
    const texture = new THREE.CanvasTexture(surface.canvas);
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
    textures.add(texture);
    return texture;
  }

  function mesh(parent, shape, surface, x = 0, y = 0, z = 0) {
    const item = new THREE.Mesh(shape, surface);
    item.position.set(x, y, z);
    parent.add(item);
    return item;
  }

  function cylinder(parent, radius, depth, surface, x = 0, y = 0, z = 0, segments = 48, open = false) {
    const shape = geometry(`c:${radius}:${depth}:${segments}:${open}`, () =>
      new THREE.CylinderGeometry(radius, radius, depth, segments, 1, open));
    const item = mesh(parent, shape, surface, x, y, z);
    item.rotation.x = Math.PI / 2;
    return item;
  }

  function box(parent, xSize, ySize, zSize, surface, x = 0, y = 0, z = 0) {
    const shape = geometry(`b:${xSize}:${ySize}:${zSize}`, () =>
      new THREE.BoxGeometry(xSize, ySize, zSize));
    return mesh(parent, shape, surface, x, y, z);
  }

  function ring(parent, inner, outer, surface, z = 0, segments = 96) {
    return mesh(parent, geometry(`r:${inner}:${outer}:${segments}`, () =>
      new THREE.RingGeometry(inner, outer, segments)), surface, 0, 0, z);
  }

  function torus(parent, radius, tube, surface, x = 0, y = 0, z = 0, arc = TAU) {
    return mesh(parent, geometry(`t:${radius}:${tube}:${arc}`, () =>
      new THREE.TorusGeometry(radius, tube, 8, 64, arc)), surface, x, y, z);
  }

  function roundedBox(parent, w, h, d, radius, surface, x = 0, y = 0, z = 0) {
    const shape = geometry(`round:${w}:${h}:${d}:${radius}`, () => {
      const outline = new THREE.Shape();
      const left = -w / 2;
      const bottom = -h / 2;
      outline.moveTo(left + radius, bottom);
      outline.lineTo(-left - radius, bottom);
      outline.quadraticCurveTo(-left, bottom, -left, bottom + radius);
      outline.lineTo(-left, -bottom - radius);
      outline.quadraticCurveTo(-left, -bottom, -left - radius, -bottom);
      outline.lineTo(left + radius, -bottom);
      outline.quadraticCurveTo(left, -bottom, left, -bottom - radius);
      outline.lineTo(left, bottom + radius);
      outline.quadraticCurveTo(left, bottom, left + radius, bottom);
      const bevel = Math.min(d * 0.18, 0.045);
      const result = new THREE.ExtrudeGeometry(outline, {
        depth: d - bevel * 2, steps: 1, curveSegments: 5,
        bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2,
      });
      result.translate(0, 0, -d / 2 + bevel);
      return result;
    });
    return mesh(parent, shape, surface, x, y, z);
  }

  // One 2048px colour map, one shared 1024px data map. All seven records share
  // these textures, including the jog-wheel grooves; no per-prop texture copies.
  function createVinylMaps() {
    const color = drawingSurface(2048);
    const data = drawingSurface(1024);
    const random = seededRandom(303);
    const ctx = color.context;
    const dc = data.context;
    ctx.fillStyle = '#101116';
    ctx.fillRect(0, 0, 2048, 2048);
    dc.fillStyle = '#858585';
    dc.fillRect(0, 0, 1024, 1024);
    for (let radius = 310; radius < 1008; radius += 2.35) {
      const gap = (radius > 540 && radius < 557) || (radius > 778 && radius < 794);
      const shade = gap ? 15 : 21 + Math.floor(random() * 14);
      ctx.strokeStyle = `rgb(${shade},${shade + 1},${shade + 4})`;
      ctx.lineWidth = gap ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.arc(1024, 1024, radius, 0, TAU);
      ctx.stroke();
      const rough = gap ? 118 : 116 + Math.floor(random() * 38);
      dc.strokeStyle = `rgb(${rough},${rough},${rough})`;
      dc.lineWidth = 0.65;
      dc.beginPath();
      dc.arc(512, 512, radius / 2, 0, TAU);
      dc.stroke();
    }
    // Broad directional wedges simulate anisotropic groove reflections. A linear
    // gradient fallback keeps the same sheen on browsers without conic gradients.
    const sheen = typeof ctx.createConicGradient === 'function'
      ? ctx.createConicGradient(-0.65, 1024, 1024)
      : ctx.createLinearGradient(0, 0, 2048, 2048);
    sheen.addColorStop(0, 'rgba(148,167,202,0)');
    sheen.addColorStop(0.12, 'rgba(148,167,202,0.03)');
    sheen.addColorStop(0.2, 'rgba(185,202,227,0.22)');
    sheen.addColorStop(0.29, 'rgba(148,167,202,0)');
    sheen.addColorStop(0.61, 'rgba(148,167,202,0)');
    sheen.addColorStop(0.7, 'rgba(185,202,227,0.15)');
    sheen.addColorStop(0.8, 'rgba(148,167,202,0)');
    sheen.addColorStop(1, 'rgba(148,167,202,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, 2048, 2048);
    return { color: canvasTexture(color), data: canvasTexture(data, false) };
  }

  function createLabelMap() {
    const surface = drawingSurface(512);
    const ctx = surface.context;
    ctx.fillStyle = '#fffdf5';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = 'rgba(14,13,25,0.75)';
    ctx.lineWidth = 3;
    for (const radius of [211, 221, 78]) {
      ctx.beginPath();
      ctx.arc(256, 256, radius, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = '#161321';
    ctx.textAlign = 'center';
    ctx.font = 'bold 39px sans-serif';
    ctx.fillText('SIDE A', 256, 146);
    ctx.font = '14px monospace';
    ctx.fillText('33 ⅓ RPM  •  STEREO', 256, 179);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('AFTER HOURS', 256, 369);
    ctx.font = '11px monospace';
    ctx.fillText('CUT 001 / KEEP IT MOVING', 256, 393);
    const random = seededRandom(808);
    for (let i = 0; i < 18; i++) {
      ctx.fillRect(91 + i * 4, 247, 2, 10 + random() * 20);
    }
    return canvasTexture(surface);
  }

  function createBrushedMap() {
    const surface = drawingSurface(256);
    const ctx = surface.context;
    const random = seededRandom(909);
    ctx.fillStyle = '#8b8b8b';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 950; i++) {
      const shade = 105 + Math.floor(random() * 56);
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.34)`;
      ctx.lineWidth = 0.5;
      const y = random() * 256;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }
    return canvasTexture(surface, false);
  }

  const vinylMaps = createVinylMaps();
  const labelMap = createLabelMap();
  const brushedMap = createBrushedMap();
  const chrome = material({ color: '#d7e0ef', metalness: 1, roughness: 0.17, envMapIntensity: 1.8 });
  const darkMetal = material({ color: '#20232c', metalness: 0.88, roughness: 0.38,
    roughnessMap: brushedMap, bumpMap: brushedMap, bumpScale: 0.009 });
  const plastic = material({ color: '#14151c', metalness: 0.14, roughness: 0.36 });
  const rubber = material({ color: '#080910', metalness: 0, roughness: 0.85 });
  const porcelain = material({ color: '#f2f1ec', metalness: 0.25, roughness: 0.28 });
  const vinylMaterial = material({ color: '#b7becb', map: vinylMaps.color,
    metalness: 0.32, roughness: 0.31, roughnessMap: vinylMaps.data,
    bumpMap: vinylMaps.data, bumpScale: 0.007, side: THREE.DoubleSide,
    clearcoat: 0.9, clearcoatRoughness: 0.21, envMapIntensity: 1.3 }, true);
  const labelMaterials = {};
  const accentMaterials = {};
  const ledMaterials = {};
  for (const key of ['a', 'b', 'c']) {
    labelMaterials[key] = accent(material({ map: labelMap, roughness: 0.34,
      metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.24,
      side: THREE.DoubleSide }, true), key);
    accentMaterials[key] = accent(material({ metalness: 0.4, roughness: 0.25,
      clearcoat: 0.7, clearcoatRoughness: 0.19 }, true), key);
    ledMaterials[key] = accent(material({ color: '#ffffff', metalness: 0.1,
      roughness: 0.3, emissiveIntensity: 2.3 }), key, 'emissive');
  }
  const coloredVinyl = accent(material({ color: '#6a3bff', metalness: 0.12,
    roughness: 0.22, roughnessMap: vinylMaps.data, bumpMap: vinylMaps.data,
    bumpScale: 0.006, transparent: true, opacity: 0.66, depthWrite: false,
    side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.14 }, true), 'b');

  function createRecord(key, translucent = false) {
    const group = new THREE.Group();
    const surface = translucent ? coloredVinyl : vinylMaterial;
    cylinder(group, 1.62, 0.052, translucent ? coloredVinyl : plastic, 0, 0, 0, 96, true);
    ring(group, 0.055, 1.62, surface, 0.027);
    const reverse = ring(group, 0.055, 1.62, surface, -0.027);
    reverse.rotation.x = Math.PI;
    ring(group, 0.055, 0.49, labelMaterials[key], 0.031, 64);
    const reverseLabel = ring(group, 0.055, 0.49, labelMaterials[key], -0.031, 64);
    reverseLabel.rotation.x = Math.PI;
    return group;
  }

  let tonearmGroup = null;
  function createTonearm(parent) {
    const group = new THREE.Group();
    parent.add(group);
    cylinder(group, 0.25, 0.12, darkMetal, 1.7, 1.23, 0.27);
    cylinder(group, 0.15, 0.22, chrome, 1.7, 1.23, 0.38);
    torus(group, 0.155, 0.026, plastic, 1.7, 1.23, 0.48);
    // Tubes are used instead of a high-resolution sweep or an imported model.
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.7, 1.26, 0.51),
      new THREE.Vector3(1.62, 0.7, 0.55),
      new THREE.Vector3(1.36, -0.3, 0.5),
      new THREE.Vector3(1.05, -0.68, 0.42),
    ]);
    mesh(group, geometry('tonearm-tube', () => new THREE.TubeGeometry(path, 28, 0.041, 8, false)), chrome);
    const counterweight = cylinder(group, 0.14, 0.23, chrome, 1.72, 1.57, 0.51, 32);
    counterweight.rotation.x = 0;
    roundedBox(group, 0.22, 0.43, 0.07, 0.035, darkMetal, 1.02, -0.76, 0.43)
      .rotation.z = -0.27;
    box(group, 0.14, 0.22, 0.095, accentMaterials.a, 1.01, -0.86, 0.365);
    cylinder(group, 0.014, 0.09, chrome, 0.99, -0.92, 0.28, 8);
    box(group, 0.08, 0.17, 0.12, plastic, 1.62, 0.27, 0.33);
    return group;
  }

  function createHero() {
    roundedBox(hero, 4.52, 3.8, 0.28, 0.23, darkMetal, 0, 0, -0.18);
    roundedBox(hero, 4.38, 3.66, 0.07, 0.18, plastic, 0, 0, -0.015);
    for (const x of [-1.7, 1.7]) {
      for (const y of [-1.4, 1.4]) cylinder(hero, 0.21, 0.15, rubber, x, y, -0.39, 24);
    }
    const platter = new THREE.Group();
    platter.position.set(-0.32, 0, 0.09);
    hero.add(platter);
    cylinder(platter, 1.75, 0.19, chrome, 0, 0, 0, 96);
    cylinder(platter, 1.7, 0.025, rubber, 0, 0, 0.108, 96);
    torus(platter, 1.734, 0.019, darkMetal, 0, 0, -0.04);
    torus(platter, 1.74, 0.012, chrome, 0, 0, 0.057);
    const dots = new THREE.InstancedMesh(
      geometry('strobe-dot', () => new THREE.SphereGeometry(0.018, 6, 4)), porcelain, 96);
    for (let i = 0; i < 96; i++) {
      const angle = i / 96 * TAU;
      instanceTransform.position.set(Math.cos(angle) * 1.744, Math.sin(angle) * 1.744, 0.01);
      instanceTransform.rotation.set(0, 0, 0);
      instanceTransform.scale.setScalar(1);
      instanceTransform.updateMatrix();
      dots.setMatrixAt(i, instanceTransform.matrix);
    }
    dots.instanceMatrix.needsUpdate = true;
    platter.add(dots);
    const record = createRecord('a');
    record.position.z = 0.153;
    platter.add(record);
    // the spindle peg stays; the wide chrome cap under it showed as a stray grey circle on the label once the record was down, so it is not drawn
    cylinder(platter, 0.046, 0.15, chrome, 0, 0, 0.23, 24);
    cylinder(platter, 0.1, 0.012, chrome, 0, 0, 0.194, 32).visible = false;
    tonearmGroup = createTonearm(hero);
    roundedBox(hero, 0.41, 0.24, 0.045, 0.035, chrome, -1.82, -1.55, 0.047);
    box(hero, 0.22, 0.025, 0.013, ledMaterials.c, -1.82, -1.56, 0.078);
    box(hero, 0.045, 1.02, 0.018, rubber, 1.89, -0.66, 0.04);
    roundedBox(hero, 0.17, 0.28, 0.1, 0.025, chrome, 1.89, -0.59, 0.09);
    box(hero, 0.12, 0.014, 0.012, plastic, 1.89, -0.59, 0.147);
    for (let i = 0; i < 9; i++) {
      box(hero, i === 4 ? 0.1 : 0.05, 0.012, 0.012, chrome, 1.73, -1.08 + i * 0.1, 0.04);
    }
    return record;
  }

  function createHeadphones(key) {
    const group = new THREE.Group();
    torus(group, 0.72, 0.07, plastic, 0, 0.05, 0, Math.PI);
    torus(group, 0.72, 0.032, accentMaterials[key], 0, 0.05, 0.06, Math.PI);
    torus(group, 0.66, 0.048, rubber, 0, 0.05, -0.015, Math.PI);
    for (const side of [-1, 1]) {
      roundedBox(group, 0.09, 0.42, 0.045, 0.02, chrome, side * 0.715, -0.13, 0);
      cylinder(group, 0.092, 0.11, darkMetal, side * 0.7, -0.34, 0.02, 24);
      const cup = new THREE.Group();
      cup.position.set(side * 0.68, -0.48, 0.035);
      cup.rotation.y = side * -0.22;
      group.add(cup);
      cylinder(cup, 0.31, 0.24, plastic, 0, 0, 0, 40);
      cylinder(cup, 0.28, 0.025, accentMaterials[key], 0, 0, -0.136, 40);
      torus(cup, 0.289, 0.016, chrome, 0, 0, -0.13);
      cylinder(cup, 0.215, 0.012, rubber, 0, 0, 0.13, 32);
      torus(cup, 0.235, 0.068, rubber, 0, 0, 0.16);
      box(cup, 0.045, 0.12, 0.02, chrome, 0, 0, -0.159);
    }
    return group;
  }

  function createKnob(key) {
    const group = new THREE.Group();
    cylinder(group, 0.28, 0.07, rubber, 0, 0, -0.16, 40);
    cylinder(group, 0.245, 0.33, plastic, 0, 0, 0, 40);
    const ridges = new THREE.InstancedMesh(
      geometry('knob-ridge', () => new THREE.BoxGeometry(0.033, 0.055, 0.26)), darkMetal, 24);
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * TAU;
      instanceTransform.position.set(Math.cos(angle) * 0.242, Math.sin(angle) * 0.242, 0);
      instanceTransform.rotation.set(0, 0, angle);
      instanceTransform.scale.setScalar(1);
      instanceTransform.updateMatrix();
      ridges.setMatrixAt(i, instanceTransform.matrix);
    }
    ridges.instanceMatrix.needsUpdate = true;
    group.add(ridges);
    cylinder(group, 0.224, 0.027, chrome, 0, 0, 0.173, 40);
    torus(group, 0.222, 0.018, accentMaterials[key], 0, 0, 0.19);
    box(group, 0.025, 0.13, 0.014, plastic, 0, 0.115, 0.195);
    return group;
  }

  function createFader(key) {
    const group = new THREE.Group();
    roundedBox(group, 0.15, 1.25, 0.035, 0.04, darkMetal, 0, 0, -0.1);
    box(group, 0.035, 1.12, 0.012, chrome, 0, 0, -0.075);
    roundedBox(group, 0.38, 0.62, 0.21, 0.07, plastic);
    roundedBox(group, 0.29, 0.51, 0.024, 0.04, accentMaterials[key], 0, 0, 0.11);
    for (const y of [-0.13, 0, 0.13]) box(group, 0.22, 0.022, 0.014, rubber, 0, y, 0.13);
    return group;
  }

  function createJogWheel() {
    const group = new THREE.Group();
    cylinder(group, 0.78, 0.21, darkMetal, 0, 0, 0, 64);
    torus(group, 0.76, 0.035, chrome, 0, 0, 0.035);
    torus(group, 0.709, 0.022, ledMaterials.b, 0, 0, 0.125);
    ring(group, 0.18, 0.675, vinylMaterial, 0.112, 64);
    cylinder(group, 0.4, 0.018, darkMetal, 0, 0, 0.135, 64);
    torus(group, 0.4, 0.011, chrome, 0, 0, 0.149);
    cylinder(group, 0.125, 0.022, accentMaterials.c, 0, 0, 0.15, 32);
    for (let i = 0; i < 16; i++) {
      const angle = i / 16 * TAU;
      const tick = box(group, 0.017, 0.055, 0.009, chrome,
        Math.sin(angle) * 0.73, Math.cos(angle) * 0.73, 0.149);
      tick.rotation.z = -angle;
    }
    return group;
  }

  const spinningRecord = createHero();
  const deck = new THREE.Group();   // everything built so far is the deck; the story floats it in and out
  for (const child of [...hero.children]) deck.add(child);
  hero.add(deck);
  const story = createStory({ hero, deck, tonearm: tonearmGroup, record: spinningRecord, geometries, materials, textures, accent: (m, k) => accent(m, k) });
  const props = [];
  for (let i = 0; i < PROP_LAYOUT.length; i++) {
    const layout = PROP_LAYOUT[i];
    const [type, x0, y0, x1, y1, depth, scale, seed] = layout;
    const random = seededRandom(seed);
    const key = ['a', 'b', 'c'][i % 3];
    let object;
    if (type === 'record' || type === 'glass') object = createRecord(key, type === 'glass');
    else if (type === 'headphones') object = createHeadphones(key);
    else if (type === 'knob') object = createKnob(key);
    else if (type === 'fader') object = createFader(key);
    else object = createJogWheel();
    const pivot = new THREE.Group();
    pivot.add(object);
    scene.add(pivot);
    props.push({ pivot, object, x0, y0, x1, y1, depth, scale,
      phase: random() * TAU, rate: 0.16 + random() * 0.17,
      rx: -0.6 + random() * 1.3, ry: -0.65 + random() * 1.3,
      rz: random() * TAU, turn: (random() - 0.5) * 0.17,
    });
    pivot.scale.setScalar(scale);
  }

  // Room reflections provide the large softbox highlights that make dark gear
  // readable. Lights are deliberately shadow-free for integrated GPUs.
  const keyLight = new THREE.DirectionalLight('#ffe6c7', 4.2);
  keyLight.position.set(-3, 5, 7);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight('#a2b7ff', 3.8);
  rimLight.position.set(5, 1, -2);
  scene.add(rimLight);
  scene.add(new THREE.HemisphereLight('#cbd8ff', '#302036', 0.65));
  function rebuildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    try {
      const next = pmrem.fromScene(room, 0.04);
      environmentTarget?.dispose();
      environmentTarget = next;
      scene.environment = next.texture;
    } catch (error) {
      console.warn('DJ scene: environment reflections unavailable.', error);
    } finally {
      room.dispose();
      pmrem.dispose();
    }
  }
  rebuildEnvironment();

  // A very small, shared texture gives extreme-depth props a soft silhouette
  // when postprocessing is unavailable. Never haze or replace the hero.
  function createHazeMap() {
    const surface = drawingSurface(128);
    const ctx = surface.context;
    const gradient = ctx.createRadialGradient(64, 64, 18, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(0.58, 'rgba(255,255,255,0.38)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    return canvasTexture(surface);
  }

  const hazeMap = createHazeMap();
  let hazeEnabled = false;
  function enableHaze() {
    if (hazeEnabled) return;
    hazeEnabled = true;
    const clones = new Map();
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      const haze = clamp((Math.abs(prop.depth) - 1.4) / 5, 0, 0.7);
      if (haze < 0.2) continue;
      prop.object.traverse((item) => {
        if (!item.isMesh) return;
        const source = item.material;
        // Material instances remain shared within a depth band, including
        // palette bindings. This work happens once when quality changes.
        const cacheKey = `${source.uuid}:${Math.round(haze * 4)}`;
        let faded = clones.get(cacheKey);
        if (!faded) {
          faded = source.clone();
          faded.transparent = true;
          faded.opacity = source.opacity * (1 - haze * 0.38);
          faded.depthWrite = false;
          faded.roughness = Math.max(source.roughness, 0.5 + haze * 0.3);
          faded.envMapIntensity = 0.65;
          materials.add(faded);
          clones.set(cacheKey, faded);
          const count = accentBindings.length;
          for (let j = 0; j < count; j++) {
            const binding = accentBindings[j];
            if (binding.material === source) accent(faded, binding.key, binding.property);
          }
        }
        item.material = faded;
      });
      const glow = new THREE.SpriteMaterial({ map: hazeMap,
        color: palette[['a', 'b', 'c'][i % 3]], opacity: haze * 0.12,
        transparent: true, depthWrite: false, toneMapped: false });
      materials.add(glow);
      accent(glow, ['a', 'b', 'c'][i % 3]);
      const sprite = new THREE.Sprite(glow);
      sprite.scale.setScalar(prop.object.children.length > 8 ? 1.5 : 3.7);
      sprite.position.z = -0.1;
      prop.pivot.add(sprite);
    }
  }

  function releasePostprocessing() {
    // EffectComposer.dispose only frees its own targets/copy pass in r160.
    bokeh?.dispose();
    outputPass?.dispose();
    renderPass?.dispose();
    composer?.dispose();
    if (!composer) postTarget?.dispose();
    composer = bokeh = outputPass = renderPass = postTarget = null;
  }

  function restoreRenderState() {
    scene.overrideMaterial = null;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
  }

  function setupPostprocessing() {
    if (opts.postprocessing === false) {
      enableHaze();
      return;
    }
    try {
      const hdr = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
      postTarget = new THREE.WebGLRenderTarget(1, 1, {
        format: THREE.RGBAFormat, type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false,
        samples: renderer.capabilities.isWebGL2 ? 2 : 0,
      });
      composer = new EffectComposer(renderer, postTarget);
      renderPass = new RenderPass(scene, camera);
      renderPass.clearAlpha = 0;
      bokeh = new BokehPass(scene, camera, { focus: 12, aperture: 0.0009, maxblur: 0.006 });   // gentler than before: the crate and sticks sit at different depths and should stay readable
      bokeh.renderTargetDepth.texture.type = THREE.UnsignedByteType;
      bokeh.renderTargetDepth.texture.format = THREE.RGBAFormat;

      // r160 explicitly overwrites the 41-tap alpha average with 1.0:
      // https://github.com/mrdoob/three.js/blob/r160/examples/jsm/shaders/BokehShader.js
      const opaqueAlpha = /gl_FragColor\.a\s*=\s*1\.0\s*;/;
      if (!opaqueAlpha.test(bokeh.materialBokeh.fragmentShader)) {
        throw new Error('Unsupported Bokeh shader; preserving canvas transparency takes priority.');
      }
      bokeh.materialBokeh.fragmentShader = bokeh.materialBokeh.fragmentShader.replace(opaqueAlpha, '');
      bokeh.materialBokeh.blending = THREE.NoBlending;
      outputPass = new OutputPass();

      // Blurred RGBA is premultiplied. Convert to straight colour before ACES /
      // sRGB, then premultiply again for the browser's transparent canvas.
      const sample = 'gl_FragColor = texture2D( tDiffuse, vUv );';
      let shader = outputPass.material.fragmentShader;
      if (!shader.includes(sample)) throw new Error('Unsupported Output shader.');
      shader = shader.replace(sample, `${sample}
        gl_FragColor.rgb /= max(gl_FragColor.a, 0.00001);`);
      const end = shader.lastIndexOf('}');
      outputPass.material.fragmentShader = `${shader.slice(0, end)}
        gl_FragColor.rgb *= gl_FragColor.a;
        ${shader.slice(end)}`;
      outputPass.material.blending = THREE.NoBlending;
      composer.addPass(renderPass);
      composer.addPass(bokeh);
      composer.addPass(outputPass);
      // Depth-of-field off (2026-11-04, Brian: "the crate is blurry, I'd like it sharper"). It focused on the deck, so the
      // crate beside it was always soft; it was also a full-screen pass every frame. Kept in place, so it's one line to restore.
      bokeh.enabled = false;
    } catch (error) {
      releasePostprocessing();
      restoreRenderState();
      enableHaze();
      console.warn('DJ scene: using depth haze instead of postprocessing.', error);
    }
  }

  function resize() {
    if (disposed || contextLost) return;
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    hasSize = canvas.clientWidth > 0 && canvas.clientHeight > 0;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    }
    averageFrameMs = 16.67;
    slowFrames = 0;
    previousTime = 0;
  }

  function setScroll(p, immediate = false) {
    if (!disposed && Number.isFinite(p)) { scrollTarget = clamp(p, 0, 1); if (immediate) { scroll = scrollTarget; scrollV = 0; } }
  }

  function setStory(value, immediate = false) {
    if (disposed || !Number.isFinite(value)) return;
    storyTarget = clamp(value, 0, 3);
    if (immediate) { storyS = storyTarget; storyV = 0; scrollV = 0; }
  }

  function setSpinning(value) {
    if (!disposed) spinning = Boolean(value);
  }

  function setPointer(x, y) {
    if (disposed) return;
    if (Number.isFinite(x)) pointerTargetX = clamp(x, -1, 1);
    if (Number.isFinite(y)) pointerTargetY = clamp(y, -1, 1);
  }

  function setPalette(next, immediate = false) {
    if (disposed || !next || typeof next !== 'object') return;
    for (const key of ['a', 'b', 'c']) {
      const value = next[key];
      if (typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) {
        paletteTargets[key].set(value);
        if (immediate) palette[key].copy(paletteTargets[key]);
      }
    }
  }

  function placeInView(object, x, y, depth, halfHeight, halfWidth) {
    object.position.copy(cameraTarget)
      .addScaledVector(cameraRight, x * halfWidth)
      .addScaledVector(cameraUp, y * halfHeight)
      .addScaledVector(cameraBack, depth);
  }

  // The story and camera follow the scroll through a critically damped spring, not a plain lag: a lag jumps to full speed
  // the instant a wheel notch lands and stops dead, which read as robotic. A spring eases into each move, glides, and
  // settles without overshoot. Every pose it passes through is still a pose of the scroll-driven story (no new poses).
  const SPRING_W = 6.2;   // stiffness (rad/s): ~0.75 s to settle
  function spring(x, v, target, dt) {   // one implicit (unconditionally stable) step; returns the new value, velocity in springOut
    const f = 1 + 2 * dt * SPRING_W, oo = SPRING_W * SPRING_W, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo);
    springOut = (v + hoo * (target - x)) * det;
    return (f * x + dt * v + hhoo * target) * det;
  }
  let springOut = 0;
  // camera + framing glide THROUGH the keyframes (monotone cubic, matching slopes), instead of easing to a stop at each one
  const keyVal = (get, p) => {
    const K = KEYFRAMES, n = K.length;
    let i = 0; while (i < n - 2 && p > K[i + 1].p) i++;
    const p0 = K[i].p, p1 = K[i + 1].p, h = p1 - p0, t = clamp((p - p0) / h, 0, 1);
    const v0 = get(K[i]), v1 = get(K[i + 1]);
    const slope = (a, b) => (get(K[b]) - get(K[a])) / (K[b].p - K[a].p);
    const tan = k => { if (k <= 0 || k >= n - 1) return 0; const d0 = slope(k - 1, k), d1 = slope(k, k + 1); return d0 * d1 <= 0 ? 0 : 2 / (1 / d0 + 1 / d1); };
    const m0 = tan(i), m1 = tan(i + 1), t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * h * m1;
  };

  function updatePose(dt) {
    const smoothing = 1 - Math.pow(0.92, dt * 60);
    const ds = Math.min(dt, 1 / 20);
    scroll = spring(scroll, scrollV, scrollTarget, ds); scrollV = springOut;
    storyS = spring(storyS, storyV, storyTarget, ds); storyV = springOut;
    scroll = clamp(scroll, 0, 1); storyS = clamp(storyS, 0, 3);
    pointerX = lerp(pointerX, reducedMotion ? 0 : pointerTargetX, smoothing);
    pointerY = lerp(pointerY, reducedMotion ? 0 : pointerTargetY, smoothing);
    if (!reducedMotion) elapsed += dt;
    spinSpeed = lerp(spinSpeed, spinning && storyLanded > 0.98 && !reducedMotion ? 1.2 : 0, 1 - Math.exp(-dt * 5));
    if (reducedMotion) spinSpeed = 0;
    spinAngle = (spinAngle + spinSpeed * dt) % TAU;
    spinningRecord.rotation.z = -spinAngle;

    const K = get => keyVal(get, scroll);   // framing at this point of the page (glides through keyframes)
    camera.position.set(
      K(k => k.cameraPos[0]),
      K(k => k.cameraPos[1]),
      K(k => k.cameraPos[2]));
    cameraTarget.set(
      K(k => k.cameraTarget[0]),
      K(k => k.cameraTarget[1]),
      K(k => k.cameraTarget[2]));
    const fov = K(k => k.fov);
    if (Math.abs(camera.fov - fov) > 0.0001) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(cameraTarget);
    camera.updateMatrixWorld();
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
    cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
    cameraBack.setFromMatrixColumn(camera.matrixWorld, 2);
    const distance = camera.position.distanceTo(cameraTarget);
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const heroDepth = K(k => k.heroPos[2]);
    const halfHeight = (distance - heroDepth) * tangent;
    const halfWidth = halfHeight * camera.aspect;
    const narrow = camera.aspect < 0.8;
    const heroX = narrow ? 0 : K(k => k.heroPos[0]);
    // 2.65 conservatively bounds the rotated deck in screen-space world units.
    // Cap its width as it moves toward an edge; portrait keeps 32% of the
    // viewport width clear and shifts the sculpture below the headline.
    const availableWidth = narrow ? 0.68 : Math.min(0.68, 0.96 - Math.abs(heroX));
    const heroScale = Math.min(K(k => k.heroScale) * (narrow ? 0.87 : 1),
      halfWidth * availableWidth / 2.65);
    const idle = reducedMotion ? 0 : 1;
    placeInView(hero,
      heroX,
      (narrow ? -0.3 : K(k => k.heroPos[1]))
        + Math.sin(elapsed * 0.48) * 0.015 * idle,
      heroDepth, halfHeight, halfWidth);
    hero.scale.setScalar(heroScale);
    hero.rotation.set(
      K(k => k.heroRot[0]) + pointerY * 0.045 + Math.sin(elapsed * 0.33) * 0.015 * idle,
      K(k => k.heroRot[1]) + pointerX * 0.06,
      K(k => k.heroRot[2]));

    // The deck waits just beyond the left screen edge (its whole width, plus margin, off-screen) so it slides in from outside the
    // frame instead of appearing already on screen. Edge distance is measured from the hero centre at the hero's depth.
    const deckStart = (halfWidth * (1 + heroX) * 1.2) / Math.max(heroScale, 0.05) + 2.65 + 1.5;
    storyLanded = story.update(storyS, elapsed, reducedMotion, deckStart);
    const spread = smoothstep(scroll);
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      if (STORY_MODE) { prop.pivot.visible = false; continue; }   // the scattered props gave way to the story (set STORY_MODE false to bring them back)
      const phase = prop.phase + elapsed * prop.rate;
      const x = lerp(prop.x0, prop.x1, spread)
        + Math.sin(phase) * 0.025 * idle + pointerX * 0.016 * (prop.depth + 3);
      const y = lerp(prop.y0, prop.y1, spread)
        + Math.cos(phase * 0.8) * 0.04 * idle - pointerY * 0.011 * (prop.depth + 3);
      const depth = prop.depth + Math.sin(scroll * Math.PI + prop.phase) * 0.35 * scroll;
      const propHalfHeight = (distance - depth) * tangent;
      placeInView(prop.pivot, x, y, depth, propHalfHeight, propHalfHeight * camera.aspect);
      prop.pivot.scale.setScalar(prop.scale * (narrow ? Math.max(0.38, camera.aspect * 0.8) : 1));
      prop.object.rotation.set(prop.rx + Math.sin(phase) * 0.13 * idle + scroll * 0.6,
        prop.ry + Math.cos(phase * 0.7) * 0.1 * idle - scroll * 0.35,
        prop.rz + elapsed * prop.turn * idle + scroll * (i % 2 ? -0.7 : 0.7));
    }

    palette.a.lerp(paletteTargets.a, smoothing);
    palette.b.lerp(paletteTargets.b, smoothing);
    palette.c.lerp(paletteTargets.c, smoothing);
    for (let i = 0; i < accentBindings.length; i++) {
      const binding = accentBindings[i];
      binding.material[binding.property].copy(palette[binding.key]);
    }
    if (bokeh) {
      focusPoint.copy(hero.position).sub(camera.position);
      bokeh.uniforms.focus.value = -focusPoint.dot(cameraBack);
    }
  }

  function dropQuality() {
    degraded = true;
    renderer.setPixelRatio(1);
    if (bokeh) bokeh.enabled = false;
    releasePostprocessing();
    restoreRenderState();
    enableHaze();
    resize();
  }

  function frame(now) {
    raf = 0;
    if (disposed || contextLost || document.hidden) return;
    const frameMs = previousTime ? now - previousTime : 16.67;
    previousTime = now;
    const dt = Math.min(frameMs / 1000, 0.05);
    // A hidden/collapsed canvas has no useful frame to draw or report as ready.
    if (hasSize) {
      updatePose(dt);
      const warming = warmFrames > 0;
      if (warming) { canvas.style.visibility = 'hidden'; hiddenForWarm = true; story.warm(true); }   // first frames: draw every story piece once (even off-screen) so shaders/textures are ready before they are needed
      if (composer) {
        try {
          composer.render(dt);
        } catch (error) {
          releasePostprocessing();
          restoreRenderState();
          enableHaze();
          renderer.render(scene, camera);
          console.warn('DJ scene: postprocessing failed; depth haze enabled.', error);
        }
      } else renderer.render(scene, camera);
      if (warming) { story.warm(false); warmFrames--; slowFrames = 0; averageFrameMs = 16.67; }
      else if (hiddenForWarm) { canvas.style.visibility = ''; canvas.style.opacity = '1'; hiddenForWarm = false; }   // un-hide only after a REAL frame has replaced the warm-up frame (which has every piece drawn at once)

      if (!degraded && ready && frameMs < 250 && !warming) {
        averageFrameMs = lerp(averageFrameMs, frameMs, 0.08);
        slowFrames = averageFrameMs > 28 ? slowFrames + 1 : 0;
        if (slowFrames >= 60) dropQuality();
      }
      if (!ready) {
        ready = true;
        // Queue the host callback after scheduling the next frame, so a host
        // exception cannot leave the scene's animation loop stopped.
        if (typeof opts.onReady === 'function') queueMicrotask(() => {
          if (!disposed) opts.onReady();
        });
      }
    }
    if (!disposed && !contextLost && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!disposed && !contextLost && !document.hidden && !raf) {
      previousTime = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      previousTime = 0;
      slowFrames = 0;
      averageFrameMs = 16.67;
    } else start();
  }

  function onMotionChange(event) {
    reducedMotion = event.matches;
    if (reducedMotion) {
      pointerX = pointerY = 0;
      spinSpeed = 0;
    }
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function onContextRestored() {
    contextLost = false;
    restoreRenderState();
    // Render-target contents are lost with the context, unlike canvas textures.
    rebuildEnvironment();
    resize();
    start();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisibility);
    motionPreference.removeEventListener('change', onMotionChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    releasePostprocessing();
    scene.environment = null;
    environmentTarget?.dispose();
    for (const item of geometries) item.dispose();
    for (const item of materials) item.dispose();
    for (const item of textures) item.dispose();
    scene.traverse((item) => {
      if (item.isInstancedMesh) item.dispose();
    });
    scene.clear();
    geometries.clear();
    geometryCache.clear();
    materials.clear();
    textures.clear();
    accentBindings.length = 0;
    props.length = 0;
    renderer.dispose();
  }

  setPalette(opts.palette);
  palette.a.copy(paletteTargets.a);
  palette.b.copy(paletteTargets.b);
  palette.c.copy(paletteTargets.c);
  setupPostprocessing();
  resize();
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  motionPreference.addEventListener('change', onMotionChange);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  start();

  return { setScroll, setStory, setSpinning, setPointer, setPalette, resize, dispose };
}
