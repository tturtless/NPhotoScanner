/* Pixel processing shared by the preview and exported image. No network or libraries. */
window.NegativeEditor = (() => {
  'use strict';

  const adjustments = [
    { title: 'Light', meta: 'tone and contrast', open: true, controls: [
      ['exposure', 'Exposure', -2, 2, .1], ['brilliance', 'Brilliance', -100, 100, 1],
      ['highlights', 'Highlights', -100, 100, 1], ['shadows', 'Shadows', -100, 100, 1],
      ['contrast', 'Contrast', -100, 100, 1], ['brightness', 'Brightness', -100, 100, 1],
      ['blackPoint', 'Black point', -100, 100, 1], ['whites', 'Whites', -100, 100, 1]
    ]},
    { title: 'Color', meta: 'balance and intensity', controls: [
      ['saturation', 'Saturation', -100, 100, 1], ['vibrance', 'Vibrance', -100, 100, 1],
      ['warmth', 'Warmth', -100, 100, 1], ['tint', 'Tint', -100, 100, 1],
      ['red', 'Red', -50, 50, 1], ['green', 'Green', -50, 50, 1], ['blue', 'Blue', -50, 50, 1]
    ]},
    { title: 'Detail', meta: 'texture and grain', controls: [
      ['definition', 'Definition', 0, 100, 1], ['sharpness', 'Sharpness', 0, 100, 1],
      ['noiseReduction', 'Noise reduction', 0, 100, 1]
    ]},
    { title: 'Finish', meta: 'final look', controls: [
      ['vignette', 'Vignette', -100, 100, 1], ['fade', 'Fade', 0, 100, 1]
    ]}
  ];
  // A modest warm/magenta starting balance offsets the cool cast common in phone photos of color negatives.
  const defaults = Object.fromEntries(adjustments.flatMap(group => group.controls.map(([id]) => [id, id === 'warmth' ? 35 : id === 'tint' ? 12 : 0])));
  const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  function percentile(histogram, count, fraction) {
    if (!count) return 0;
    const target = count * fraction;
    let sum = 0;
    for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= target) return i; }
    return 255;
  }

  function convertNegative(data, options) {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let count = 0;
    if (options.auto) {
      const stride = Math.max(1, Math.ceil(data.length / 4 / 160000));
      for (let p = 0; p < data.length; p += 4 * stride) {
        const r = 255 - data[p], g = 255 - data[p + 1], b = 255 - data[p + 2];
        if (options.film === 'bw') hist[0][Math.round(.2126 * r + .7152 * g + .0722 * b)]++;
        else { hist[0][r]++; hist[1][g]++; hist[2][b]++; }
        count++;
      }
    }
    const lut = hist.map((h) => {
      let low = options.auto ? percentile(h, count, .008) : 0;
      let high = options.auto ? percentile(h, count, .992) : 255;
      if (high - low < 28) { const mid = (high + low) / 2; low = Math.max(0, mid - 14); high = Math.min(255, mid + 14); }
      const table = new Uint8Array(256);
      for (let v = 0; v < 256; v++) table[v] = Math.round(clamp((v - low) / (high - low)) * 255);
      return table;
    });
    for (let p = 0; p < data.length; p += 4) {
      if (options.film === 'bw') {
        const gray = Math.round(.2126 * (255 - data[p]) + .7152 * (255 - data[p + 1]) + .0722 * (255 - data[p + 2]));
        data[p] = data[p + 1] = data[p + 2] = lut[0][gray];
      } else {
        data[p] = lut[0][255 - data[p]];
        data[p + 1] = lut[1][255 - data[p + 1]];
        data[p + 2] = lut[2][255 - data[p + 2]];
      }
    }
  }

  function toneAndColor(data, width, height, o) {
    const exposure = Math.pow(2, o.exposure);
    const brilliance = o.brilliance / 100;
    const highlights = o.highlights / 100;
    const shadows = o.shadows / 100;
    const contrast = 1 + o.contrast / 100;
    const brightness = o.brightness / 250;
    const blackPoint = o.blackPoint / 100;
    const whites = o.whites / 100;
    const saturation = o.saturation / 100;
    const vibrance = o.vibrance / 100;
    const warmth = o.warmth / 100 * .12;
    const tint = o.tint / 100 * .10;
    const shiftR = o.red / 50 * .12;
    const shiftG = o.green / 50 * .12;
    const shiftB = o.blue / 50 * .12;
    const fade = o.fade / 100;
    const vignette = o.vignette / 100;
    const color = o.film === 'color';
    const toneCurve = new Float32Array(4097);
    for (let i = 0; i < toneCurve.length; i++) {
      const lum = i / 1024;
      let tone = (lum - .5) * contrast + .5 + brightness;
      tone += brilliance * .24 * Math.sin(Math.PI * clamp(tone)) * (.55 - tone);
      tone += shadows * .38 * (1 - smoothstep(.05, .55, tone)) * clamp(tone);
      tone += highlights * .42 * smoothstep(.45, .95, tone) * (1 - clamp(tone));
      tone -= blackPoint * .18 * Math.pow(1 - clamp(tone), 3);
      tone += whites * .18 * Math.pow(clamp(tone), 3);
      toneCurve[i] = tone - lum;
    }
    for (let y = 0; y < height; y++) {
      const ny = (y + .5) / height - .5;
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        let r = data[p] / 255 * exposure;
        let g = data[p + 1] / 255 * exposure;
        let b = data[p + 2] / 255 * exposure;
        const lum = .2126 * r + .7152 * g + .0722 * b;
        const delta = toneCurve[Math.min(4096, Math.round(lum * 1024))];
        r += delta; g += delta; b += delta;
        if (color) {
          const l = .2126 * r + .7152 * g + .0722 * b;
          const currentSat = clamp(Math.max(r, g, b) - Math.min(r, g, b));
          const factor = 1 + saturation + vibrance * (1 - currentSat) * .75;
          r = l + (r - l) * factor + warmth + tint * .35 + shiftR;
          g = l + (g - l) * factor + warmth * .15 - tint + shiftG;
          b = l + (b - l) * factor - warmth + tint * .35 + shiftB;
        }
        if (fade) { r = r * (1 - fade * .22) + fade * .08; g = g * (1 - fade * .22) + fade * .08; b = b * (1 - fade * .22) + fade * .08; }
        if (vignette) {
          const nx = (x + .5) / width - .5;
          const edge = Math.pow(clamp((Math.sqrt(nx * nx + ny * ny) / .7071 - .35) / .65), 2);
          const factor = 1 - vignette * .7 * edge;
          r *= factor; g *= factor; b *= factor;
        }
        data[p] = clamp(r) * 255;
        data[p + 1] = clamp(g) * 255;
        data[p + 2] = clamp(b) * 255;
      }
    }
  }

  function detail(data, width, height, o) {
    if (!o.definition && !o.sharpness && !o.noiseReduction) return;
    const original = new Uint8ClampedArray(data);
    const sharp = o.sharpness / 100 * 1.35;
    const define = o.definition / 100 * .8;
    const denoise = o.noiseReduction / 100 * .72;
    const radius = Math.max(2, Math.min(8, Math.round(Math.max(width, height) / 450)));
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);
      const yf0 = Math.max(0, y - radius), yf1 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
        const p = (y * width + x) * 4;
        let ar = 0, ag = 0, ab = 0, samples = 0;
        if (sharp || denoise) {
          for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
            const q = (yy * width + xx) * 4;
            ar += original[q]; ag += original[q + 1]; ab += original[q + 2]; samples++;
          }
          ar /= samples; ag /= samples; ab /= samples;
        }
        let fr = 0, fg = 0, fb = 0;
        if (define) {
          const xf0 = Math.max(0, x - radius), xf1 = Math.min(width - 1, x + radius);
          const corners = [(yf0 * width + xf0) * 4, (yf0 * width + xf1) * 4, (yf1 * width + xf0) * 4, (yf1 * width + xf1) * 4];
          for (const q of corners) { fr += original[q]; fg += original[q + 1]; fb += original[q + 2]; }
          fr = (fr + original[p] * 4) / 8; fg = (fg + original[p + 1] * 4) / 8; fb = (fb + original[p + 2] * 4) / 8;
        }
        const lum = (.2126 * original[p] + .7152 * original[p + 1] + .0722 * original[p + 2]) / 255;
        const avgLum = (.2126 * ar + .7152 * ag + .0722 * ab) / 255;
        const smooth = denoise * clamp(1 - Math.abs(lum - avgLum) / .12);
        const mid = clamp(1 - Math.abs(lum - .5) * 1.2);
        for (let c = 0; c < 3; c++) {
          const base = original[p + c];
          const near = c === 0 ? ar : c === 1 ? ag : ab;
          const far = c === 0 ? fr : c === 1 ? fg : fb;
          data[p + c] = clamp(base + smooth * (near - base) + sharp * (base - near) + define * mid * (base - far), 0, 255);
        }
      }
    }
  }

  function processPixels(imageData, width, height, options) {
    convertNegative(imageData.data, options);
    toneAndColor(imageData.data, width, height, options);
    detail(imageData.data, width, height, options);
  }

  function analyzeAuto(imageData, film) {
    const data = imageData.data;
    const hist = new Uint32Array(256);
    let count = 0, sat = 0;
    const stride = Math.max(1, Math.ceil(data.length / 4 / 90000));
    for (let p = 0; p < data.length; p += 4 * stride) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      hist[Math.round(.2126 * r + .7152 * g + .0722 * b)]++;
      sat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      count++;
    }
    const p10 = percentile(hist, count, .10), p50 = percentile(hist, count, .50), p90 = percentile(hist, count, .90);
    return {
      ...defaults,
      exposure: Math.round(clamp(Math.log2(.48 / Math.max(.08, p50 / 255)), -.5, .5) * 10) / 10,
      brilliance: 18,
      contrast: Math.round(clamp((170 - (p90 - p10)) * .15, -8, 20)),
      shadows: p10 < 35 ? 16 : p10 < 55 ? 8 : 0,
      highlights: p90 > 225 ? -14 : 0,
      vibrance: film === 'color' ? Math.round(clamp((.22 - sat / count) * 80, 0, 18)) : 0,
      definition: 10,
      sharpness: 12
    };
  }

  return { adjustments, defaults, processPixels, analyzeAuto };
})();
