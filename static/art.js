/* Waxfinder liquid gear. ES5, deterministic seeds, no dependencies.
 * Insert svg(type, seed) inside .art.art-TYPE; inherit --h from the tile.
 * Returns two SVG layers so CSS perspective can lift the motif above the hull.
 * Add .playing to an ancestor to wake the gear. The hull morphs at rest.
 */
(function (root) {
  'use strict';
  var serial = 0;
  var types = ['vinyl', 'jog', 'headphones', 'cassette', 'eq', 'speaker',
    'knob', 'wave', 'faders', 'cd', 'mixer', 'mic'];

  function random(seed) {
    var s = 2166136261, text = String(seed == null ? 0 : seed), i;
    for (i = 0; i < text.length; i++) {
      s ^= text.charCodeAt(i);
      s = (s + (s << 1) + (s << 4) + (s << 7) + (s << 8) + (s << 24)) >>> 0;
    }
    return function () {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  function pair(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }

  // The count pills' eight-point Catmull-Rom outline, scaled for the art.
  function shape(r) {
    var points = [], i, a, radius, p0, p1, p2, p3, d;
    for (i = 0; i < 6; i++) {
      a = i / 6 * Math.PI * 2 + (r() - 0.5) * 0.35;
      radius = 0.86 + r() * 0.16;
      points.push([80 + Math.cos(a) * radius * 76,
        80 + Math.sin(a) * radius * 75]);
    }
    d = 'M' + pair(points[0]);
    for (i = 0; i < 6; i++) {
      p0 = points[(i + 5) % 6]; p1 = points[i];
      p2 = points[(i + 1) % 6]; p3 = points[(i + 2) % 6];
      d += 'C' + pair([p1[0] + (p2[0] - p0[0]) / 4.6, p1[1] + (p2[1] - p0[1]) / 4.6])
        + ' ' + pair([p2[0] - (p3[0] - p1[0]) / 4.6, p2[1] - (p3[1] - p1[1]) / 4.6])
        + ' ' + pair(p2);
    }
    return d + 'Z';
  }

  function circle(x, y, radius, cls) {
    return '<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" class="' + cls + '"/>';
  }
  function path(d, cls) { return '<path d="' + d + '" class="' + cls + '"/>'; }
  function capsule(x, y, w, h, cls, delay) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h
      + '" rx="' + Math.min(w, h) / 2 + '" class="' + cls + '"'
      + (delay == null ? '' : ' style="--art-delay:-' + delay.toFixed(2) + 's"') + '/>';
  }
  function reel(x, y) {
    return '<g class="art-reel">' + circle(x, y, 17, 'art-face')
      + circle(x, y, 11, 'art-reel-groove')
      + path('M' + x + ' ' + (y - 8) + 'v16M' + (x - 8) + ' ' + y + 'h16', 'art-reel-spokes')
      + circle(x, y, 3, 'art-ink') + '</g>';
  }
  function motif(type, r) {
    var out = '', i, x, y, heights, angle;
    if (type === 'vinyl' || type === 'jog' || type === 'cd') {
      out = '<g class="art-spin">' + circle(80, 80, 49, type === 'cd' ? 'art-face' : 'art-ink');
      for (i = 0; i < 4; i++) out += circle(80, 80, 28 + i * 5, 'art-groove');
      if (type === 'jog') {
        out += circle(80, 80, 44, 'art-jog-dots') + circle(80, 80, 25, 'art-face')
          + capsule(77, 42, 6, 14, 'art-white');
      } else if (type === 'cd') {
        out += path('M48 44Q60 34 73 33M111 112Q98 125 86 127', 'art-cd-glint')
          + circle(80, 80, 19, 'art-ink') + circle(80, 80, 11, 'art-face');
      } else {
        out += circle(80, 80, 22, 'art-face')
          + path('M67 76Q77 64 92 73M68 85Q80 74 92 82', 'art-label-mark');
      }
      out += path('M43 64A40 40 0 0 1 64 43', 'art-etch') + circle(80, 80, 4, 'art-hole') + '</g>';
      return out;
    }
    if (type === 'headphones') {
      return '<g class="art-bob">'
        + path('M41 91C32 20 130 17 120 91', 'art-band-shadow')
        + path('M41 88C34 24 126 22 120 88', 'art-band')
        + path('M43 65C48 32 101 27 115 62', 'art-band-glint')
        + path('M42 75C23 72 21 100 31 117C41 134 58 122 57 105C56 89 58 78 42 75Z', 'art-ink')
        + path('M119 75C138 72 140 100 130 117C120 134 103 122 104 105C105 89 103 78 119 75Z', 'art-ink')
        + path('M39 84C31 86 31 112 41 116C52 120 49 99 49 93C49 87 47 81 39 84Z', 'art-face')
        + path('M122 84C130 86 130 112 120 116C109 120 112 99 112 93C112 87 114 81 122 84Z', 'art-face')
        + path('M37 89Q33 99 38 107M119 89Q115 99 120 107', 'art-etch') + '</g>';
    }
    if (type === 'cassette') {
      return '<g class="art-bob">'
        + path('M45 42C57 38 103 38 115 42C131 46 134 58 132 81L129 103C127 118 116 122 99 121L59 122C40 122 29 113 29 97L28 66C28 51 34 45 45 42Z', 'art-ink')
        + path('M49 50Q80 45 111 50', 'art-etch')
        + path('M55 61C35 61 35 99 55 99H105C125 99 125 61 105 61Z', 'art-tape-well')
        + reel(55, 80) + reel(105, 80)
        + capsule(76, 77, 8, 6, 'art-face')
        + path('M61 119Q62 104 70 104H90Q98 104 99 119Z', 'art-tape-well')
        + capsule(70, 112, 20, 3, 'art-muted') + '</g>';
    }
    if (type === 'eq' || type === 'wave') {
      heights = type === 'eq' ? [28, 52, 78, 60, 39] : [23, 46, 66, 93, 69, 44, 25];
      for (i = 0; i < heights.length; i++) {
        x = type === 'eq' ? 39 + i * 17 : 30 + i * 15;
        y = type === 'eq' ? 119 - heights[i] : 80 - heights[i] / 2;
        if (type === 'wave') {
          // A little belly and an uneven tip keep these closer to liquid drips.
          out += '<path class="' + (i === 3 ? 'art-face' : 'art-ink')
            + ' art-drip" style="--art-delay:-' + (r() * 2).toFixed(2) + 's" d="M'
            + (x + 5) + ' ' + y + 'C' + (x + 12) + ' ' + (y - 1) + ' '
            + (x + 8) + ' ' + (y + heights[i] * 0.33) + ' ' + (x + 11) + ' ' + (y + heights[i] * 0.62)
            + 'C' + (x + 14) + ' ' + (y + heights[i] + 5) + ' ' + (x - 2) + ' ' + (y + heights[i] + 5)
            + ' ' + x + ' ' + (y + heights[i] * 0.72) + 'C' + (x + 2) + ' ' + (y + heights[i] * 0.37)
            + ' ' + (x - 3) + ' ' + y + ' ' + (x + 5) + ' ' + y + 'Z"/>';
        } else {
          out += capsule(x, y, 13, heights[i],
            (i === 2 ? 'art-face' : 'art-ink') + ' art-meter', r() * 2);
        }
      }
      return out;
    }
    if (type === 'speaker') {
      return path('M54 28C70 22 99 23 111 36C124 51 120 75 124 99C128 125 108 135 83 134C60 134 39 132 37 110L36 61C36 43 40 33 54 28Z', 'art-ink')
        + path('M48 49Q50 35 66 34', 'art-etch')
        + circle(80, 52, 12, 'art-cone-well') + circle(80, 52, 6, 'art-face')
        + '<g class="art-cone">' + circle(81, 98, 28, 'art-cone-well')
        + circle(81, 98, 21, 'art-speaker-ring') + circle(81, 98, 11, 'art-face')
        + path('M61 91Q64 81 74 78', 'art-etch') + '</g>';
    }
    if (type === 'knob') {
      for (i = 0; i < 9; i++) {
        angle = (-135 + i * 33.75) * Math.PI / 180;
        x = 80 + Math.sin(angle) * 55; y = 80 - Math.cos(angle) * 55;
        out += circle(x.toFixed(2), y.toFixed(2), i === 6 ? 3 : 2, i === 6 ? 'art-white' : 'art-tick');
      }
      return out + '<g class="art-turn">' + circle(80, 80, 43, 'art-ink')
        + circle(80, 80, 34, 'art-knob-face') + circle(80, 80, 25, 'art-face')
        + path('M53 65Q58 53 70 50', 'art-etch')
        + capsule(77, 51, 6, 19, 'art-hole') + '</g>';
    }
    if (type === 'faders') {
      for (i = 0; i < 3; i++) {
        x = 49 + i * 31; y = [51, 86, 63][i];
        out += capsule(x - 4, 37, 8, 88, 'art-rail')
          + '<g class="art-slider" style="--art-delay:-' + (i * 0.63).toFixed(2) + 's">'
          + capsule(x - 12, y, 24, 20, 'art-ink')
          + capsule(x - 9, y + 2, 18, 11, 'art-face')
          + path('M' + (x - 5) + ' ' + (y + 7) + 'h10', 'art-label-mark') + '</g>';
      }
      return out;
    }
    if (type === 'mixer') {
      out = path('M50 33Q80 27 110 34C125 37 129 48 128 64L125 113Q124 129 106 130L51 128Q33 127 33 109L32 56Q33 37 50 33Z', 'art-ink')
        + path('M45 49Q46 40 62 39', 'art-etch');
      for (i = 0; i < 3; i++) {
        x = 56 + i * 24;
        out += '<g class="art-mini-turn" style="--art-delay:-' + (i * 0.7).toFixed(2) + 's">'
          + circle(x, 59, 8, 'art-face') + path('M' + x + ' 54v5', 'art-label-mark') + '</g>'
          + capsule(x - 2.5, 77, 5, 25, 'art-muted')
          + capsule(x - 6, [82, 91, 77][i], 12, 8, 'art-face art-slider', i * 0.7);
      }
      return out + capsule(53, 112, 54, 4, 'art-muted')
        + capsule(76, 107, 15, 13, 'art-face');
    }
    // Microphone: a pill-like head and a continuous, curved cradle.
    return '<g class="art-bob">'
      + path('M57 77C54 114 109 114 105 77', 'art-mic-cradle')
      + path('M81 105V124M66 126Q81 121 96 126', 'art-mic-cradle')
      + path('M80 30C62 29 60 44 60 61V75C60 103 102 103 102 75V55C102 41 98 31 80 30Z', 'art-ink')
      + path('M73 38Q65 41 66 56', 'art-etch')
      + path('M74 50H89M73 60H90M73 70H90M76 80H87', 'art-mic-grille') + '</g>';
  }

  function svg(type, seed) {
    if (types.indexOf(type) < 0) type = 'vinyl';
    var id = 'l2ta-' + (++serial) + '-', r = random(type + ':' + seed), frames = [], i;
    for (i = 0; i < 4; i++) frames.push(shape(r));
    frames.push(frames[0]);
    var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var motion = reduced ? '' : '<animate attributeName="d" dur="' + (17 + r() * 10).toFixed(2)
      + 's" begin="-' + (r() * 20).toFixed(2) + 's" repeatCount="indefinite" calcMode="spline"'
      + ' keyTimes="0;.25;.5;.75;1" keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1"'
      + ' values="' + frames.join(';') + '"/>';
    var paint = '--art-body:url(#' + id + 'body);--art-ink:url(#' + id + 'ink);'
      + '--art-face:url(#' + id + 'face);--art-rim:url(#' + id + 'rim);'
      + '--art-glow:url(#' + id + 'glow);--art-bevel:url(#' + id + 'bevel)';
    var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"'
      + ' class="art-svg art-kind-' + type + '" aria-hidden="true" focusable="false"'
      + ' style="' + paint + '">'
      + '<defs>'
      + '<radialGradient id="' + id + 'body" cx="27%" cy="17%" r="100%">'
      + '<stop offset="0" class="art-body-light"/><stop offset=".32" class="art-body-mid"/>'
      + '<stop offset=".68" class="art-body-color"/><stop offset="1" class="art-body-shade"/></radialGradient>'
      + '<radialGradient id="' + id + 'glow" cx="66%" cy="91%" r="66%">'
      + '<stop offset="0" class="art-glow-light"/><stop offset="1" class="art-clear"/></radialGradient>'
      + '<radialGradient id="' + id + 'ink" cx="27%" cy="8%" r="95%">'
      + '<stop offset="0" class="art-ink-light"/><stop offset=".55" class="art-ink-mid"/>'
      + '<stop offset="1" class="art-ink-dark"/></radialGradient>'
      + '<linearGradient id="' + id + 'face" x1="0" y1="0" x2=".7" y2="1">'
      + '<stop offset="0" class="art-face-light"/><stop offset=".48" class="art-face-mid"/>'
      + '<stop offset="1" class="art-face-shade"/></linearGradient>'
      + '<linearGradient id="' + id + 'rim" x1=".1" y1="0" x2=".8" y2="1">'
      + '<stop offset="0" class="art-rim-light"/><stop offset=".45" class="art-rim-clear"/>'
      + '<stop offset="1" class="art-rim-low"/></linearGradient>'
      + '<linearGradient id="' + id + 'bevel" x1="0" y1="0" x2=".3" y2="1">'
      + '<stop offset="0" stop-color="#fff" stop-opacity=".65"/>'
      + '<stop offset=".4" stop-color="#fff" stop-opacity=".08"/>'
      + '<stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient>'
      // One soft blur serves the contact shadow and the curved wet highlight.
      + '<filter id="' + id + 'soft" x="-35%" y="-100%" width="170%" height="300%" color-interpolation-filters="sRGB">'
      + '<feGaussianBlur stdDeviation="2"/></filter>'
      + '<filter id="' + id + 'inner" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">'
      + '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/>'
      + '<feOffset in="blur" dx="-2" dy="-3" result="offset"/>'
      + '<feComposite in="SourceAlpha" in2="offset" operator="out" result="edge"/>'
      + '<feFlood flood-color="#180629" flood-opacity=".48" result="shade"/>'
      + '<feComposite in="shade" in2="edge" operator="in" result="shadow"/>'
      + '<feComposite in="shadow" in2="SourceGraphic" operator="over"/></filter>'
      + '<filter id="' + id + 'raised" x="-15%" y="-15%" width="130%" height="140%" color-interpolation-filters="sRGB">'
      + '<feGaussianBlur in="SourceAlpha" stdDeviation="1.4" result="blur"/>'
      + '<feOffset in="blur" dx="1" dy="3" result="offset"/>'
      + '<feFlood flood-color="#10071d" flood-opacity=".55" result="shade"/>'
      + '<feComposite in="shade" in2="offset" operator="in" result="shadow"/>'
      + '<feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<path id="' + id + 'moving" d="' + frames[0] + '">' + motion + '</path>'
      + '<path id="' + id + 'still" d="' + frames[0] + '"/>'
      + '<clipPath id="' + id + 'clip-moving"><use href="#' + id + 'moving"/></clipPath>'
      + '<clipPath id="' + id + 'clip-still"><use href="#' + id + 'still"/></clipPath></defs>';
    function hull(name, cls) {
      // Every use references the same animated path, including the underside.
      return '<g class="art-hull ' + cls + '">'
        + '<use href="#' + id + name + '" class="art-extrusion" transform="translate(3 6)"/>'
        + '<use href="#' + id + name + '" class="art-body" filter="url(#' + id + 'inner)"/>'
        + '<use href="#' + id + name + '" class="art-inner-glow"/>'
        + '<use href="#' + id + name + '" class="art-rim"/>'
        + '<g clip-path="url(#' + id + 'clip-' + name + ')">'
        + '<path d="M29 59C30 35 52 22 73 26C55 29 40 40 36 59Q32 64 29 59Z"'
        + ' class="art-wet" filter="url(#' + id + 'soft)"/></g></g>';
    }
    out += '<ellipse cx="85" cy="151" rx="48" ry="5" class="art-contact" filter="url(#' + id + 'soft)"/>'
      + hull('moving', 'art-morphing') + hull('still', 'art-still') + '</svg>';
    // Sibling SVG viewports avoid flattening translateZ inside an SVG group.
    return out + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"'
      + ' class="art-svg art-motif-layer art-kind-' + type + '" aria-hidden="true" focusable="false"'
      + ' style="' + paint + '"><g class="art-motif" filter="url(#' + id + 'raised)">'
      + motif(type, r) + '</g></svg>';
  }

  root.L2TArt = { types: types, svg: svg };
}(window));
