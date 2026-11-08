(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const input = $('photo-input');
  const dropzone = $('dropzone');
  const framing = $('framing');
  const stage = $('frame-stage');
  const sourceView = $('source-canvas');
  const cropBox = $('crop-box');
  const resultView = $('result-canvas');
  const resultWrap = $('result-wrap');
  const emptyPreview = $('empty-preview');
  const status = $('status');
  const saveButton = $('save-jpeg');
  const shareButton = $('share-image');
  const controls = ['exposure', 'contrast', 'red', 'green', 'blue'];

  let source = null;
  let crop = { x: .06, y: .06, w: .88, h: .88 };
  let drag = null;
  let renderTimer = null;
  let outputName = 'positive';

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const filmMode = () => document.querySelector('input[name="film"]:checked').value;
  const settings = () => ({
    film: filmMode(),
    auto: $('auto-levels').checked,
    exposure: Number($('exposure').value),
    contrast: Number($('contrast').value),
    red: Number($('red').value),
    green: Number($('green').value),
    blue: Number($('blue').value)
  });

  function setStatus(message) { status.textContent = message; }

  function fitSourceView() {
    if (!source) return;
    const width = stage.clientWidth;
    const maxHeight = window.innerWidth <= 550 ? 480 : 620;
    const scale = Math.min(width / source.width, maxHeight / source.height);
    sourceView.style.width = `${Math.round(source.width * scale)}px`;
    sourceView.style.height = `${Math.round(source.height * scale)}px`;
    updateCropBox();
  }

  function drawSourceView() {
    if (!source) return;
    const scale = Math.min(1, 1800 / Math.max(source.width, source.height));
    sourceView.width = Math.max(1, Math.round(source.width * scale));
    sourceView.height = Math.max(1, Math.round(source.height * scale));
    sourceView.getContext('2d', { alpha: false }).drawImage(source, 0, 0, sourceView.width, sourceView.height);
    fitSourceView();
  }

  function updateCropBox() {
    if (!source) return;
    const canvasRect = sourceView.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    cropBox.style.left = `${canvasRect.left - stageRect.left + crop.x * canvasRect.width}px`;
    cropBox.style.top = `${canvasRect.top - stageRect.top + crop.y * canvasRect.height}px`;
    cropBox.style.width = `${crop.w * canvasRect.width}px`;
    cropBox.style.height = `${crop.h * canvasRect.height}px`;
  }

  function percentileBounds(histogram, count) {
    const lowTarget = count * .008;
    const highTarget = count * .992;
    let cumulative = 0, low = 0, high = 255;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= lowTarget) { low = i; break; }
    }
    cumulative = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= highTarget) { high = i; break; }
    }
    if (high - low < 28) {
      const mid = (high + low) / 2;
      low = Math.max(0, mid - 14);
      high = Math.min(255, mid + 14);
    }
    return [low, high];
  }

  function processPixels(imageData, options) {
    const data = imageData.data;
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let count = 0;
    if (options.auto) {
      const stride = Math.max(1, Math.ceil((data.length / 4) / 160000));
      for (let p = 0; p < data.length; p += 4 * stride) {
        const r = 255 - data[p], g = 255 - data[p + 1], b = 255 - data[p + 2];
        if (options.film === 'bw') {
          hist[0][Math.round(.2126 * r + .7152 * g + .0722 * b)]++;
        } else {
          hist[0][r]++; hist[1][g]++; hist[2][b]++;
        }
        count++;
      }
    }
    const bounds = options.auto ? hist.map(h => percentileBounds(h, count)) : [[0, 255], [0, 255], [0, 255]];
    const exposure = Math.pow(2, options.exposure);
    const contrast = 1 + options.contrast / 75;
    const shift = [options.red, options.green, options.blue].map(v => v / 255);
    const lookup = bounds.map(([low, high], channel) => {
      const table = new Uint8Array(256);
      for (let n = 0; n < 256; n++) {
        let value = (n - low) / (high - low);
        value = (value - .5) * contrast + .5;
        table[n] = clamp((value * exposure + (options.film === 'color' ? shift[channel] : 0)) * 255, 0, 255);
      }
      return table;
    });
    for (let p = 0; p < data.length; p += 4) {
      if (options.film === 'bw') {
        const gray = .2126 * (255 - data[p]) + .7152 * (255 - data[p + 1]) + .0722 * (255 - data[p + 2]);
        data[p] = data[p + 1] = data[p + 2] = lookup[0][Math.round(gray)];
      } else {
        data[p] = lookup[0][255 - data[p]];
        data[p + 1] = lookup[1][255 - data[p + 1]];
        data[p + 2] = lookup[2][255 - data[p + 2]];
      }
    }
  }

  function renderTo(canvas, maxSide) {
    const sx = Math.round(crop.x * source.width);
    const sy = Math.round(crop.y * source.height);
    const sw = Math.max(1, Math.round(crop.w * source.width));
    const sh = Math.max(1, Math.round(crop.h * source.height));
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    processPixels(pixels, settings());
    ctx.putImageData(pixels, 0, 0);
  }

  function schedulePreview(delay = 130) {
    if (!source) return;
    clearTimeout(renderTimer);
    setStatus('Processing…');
    renderTimer = setTimeout(() => {
      try {
        renderTo(resultView, 1200);
        emptyPreview.classList.add('hidden');
        resultWrap.classList.remove('hidden');
        setStatus(`${resultView.width} × ${resultView.height} preview`);
        saveButton.disabled = false;
        shareButton.disabled = false;
      } catch (error) {
        console.error(error);
        setStatus('Could not process photo');
      }
    }, delay);
  }

  function usePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setStatus('Choose an image file'); return; }
    setStatus('Opening photo…');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 4000 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(img, 0, 0, canvas.width, canvas.height);
        source = canvas;
        crop = { x: .06, y: .06, w: .88, h: .88 };
        outputName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'negative';
        dropzone.classList.add('hidden');
        framing.classList.remove('hidden');
        drawSourceView();
        schedulePreview(0);
      } catch (error) {
        console.error(error);
        setStatus('This photo is too large to open');
      } finally {
        URL.revokeObjectURL(url);
        img.src = '';
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus('This image format could not be opened'); };
    img.src = url;
  }

  cropBox.addEventListener('pointerdown', (event) => {
    if (!source) return;
    event.preventDefault();
    const handle = event.target.dataset.handle || 'move';
    drag = { id: event.pointerId, handle, x: event.clientX, y: event.clientY, original: { ...crop } };
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const rect = sourceView.getBoundingClientRect();
    const dx = (event.clientX - drag.x) / rect.width;
    const dy = (event.clientY - drag.y) / rect.height;
    const o = drag.original;
    const min = .08;
    if (drag.handle === 'move') {
      crop.x = clamp(o.x + dx, 0, 1 - o.w);
      crop.y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
      if (drag.handle.includes('w')) left = clamp(o.x + dx, 0, right - min);
      if (drag.handle.includes('e')) right = clamp(o.x + o.w + dx, left + min, 1);
      if (drag.handle.includes('n')) top = clamp(o.y + dy, 0, bottom - min);
      if (drag.handle.includes('s')) bottom = clamp(o.y + o.h + dy, top + min, 1);
      crop = { x: left, y: top, w: right - left, h: bottom - top };
    }
    updateCropBox();
    schedulePreview(250);
  });

  function endDrag(event) {
    if (drag && drag.id === event.pointerId) {
      drag = null;
      schedulePreview(0);
    }
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  input.addEventListener('change', () => usePhoto(input.files[0]));
  $('change-photo').addEventListener('click', () => { input.value = ''; input.click(); });
  $('reset-crop').addEventListener('click', () => { crop = { x: .06, y: .06, w: .88, h: .88 }; updateCropBox(); schedulePreview(0); });
  $('rotate').addEventListener('click', () => {
    if (!source) return;
    const rotated = document.createElement('canvas');
    rotated.width = source.height; rotated.height = source.width;
    const ctx = rotated.getContext('2d', { alpha: false });
    ctx.translate(rotated.width, 0); ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, 0, 0);
    source = rotated;
    crop = { x: .06, y: .06, w: .88, h: .88 };
    drawSourceView(); schedulePreview(0);
  });

  for (const id of controls) {
    $(id).addEventListener('input', () => {
      $(`${id}-value`).value = id === 'exposure' ? Number($(id).value).toFixed(1) : $(id).value;
      schedulePreview();
    });
  }
  document.querySelectorAll('input[name="film"]').forEach(el => el.addEventListener('change', schedulePreview.bind(null, 0)));
  $('auto-levels').addEventListener('change', () => schedulePreview(0));
  $('reset-adjustments').addEventListener('click', () => {
    for (const id of controls) { $(id).value = 0; $(`${id}-value`).value = id === 'exposure' ? '0.0' : '0'; }
    schedulePreview(0);
  });

  function exportBlob() {
    return new Promise(async (resolve, reject) => {
      try {
        await nextFrame();
        const canvas = document.createElement('canvas');
        renderTo(canvas, 4000);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG export failed')), 'image/jpeg', .94);
      } catch (error) { reject(error); }
    });
  }

  async function saveOrShare(share) {
    if (!source) return;
    saveButton.disabled = shareButton.disabled = true;
    setStatus('Preparing high-resolution image…');
    try {
      const blob = await exportBlob();
      const name = `${outputName}-positive.jpg`;
      if (share && navigator.share) {
        const file = new File([blob], name, { type: 'image/jpeg' });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          setStatus('Ready');
          return;
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus('JPEG ready');
    } catch (error) {
      if (error.name !== 'AbortError') { console.error(error); setStatus('Could not save image'); }
      else setStatus('Ready');
    } finally {
      saveButton.disabled = shareButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', () => saveOrShare(false));
  shareButton.addEventListener('click', () => saveOrShare(true));
  if (navigator.share && typeof File !== 'undefined') shareButton.classList.remove('hidden');
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => usePhoto(e.dataTransfer.files[0]));
  window.addEventListener('resize', fitSourceView);
})();
