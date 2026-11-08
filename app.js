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
  const photosButton = $('save-photos');
  const viewImageButton = $('view-image');
  const editor = window.NegativeEditor;
  const controls = editor.adjustments.flatMap(group => group.controls.map(([id]) => id));
  const adjustmentLabel = (id, value) => id === 'exposure' ? Number(value).toFixed(1) : String(value);
  $('editor-controls').innerHTML = editor.adjustments.map(group => `
    <details class="edit-group" data-group="${group.title.toLowerCase()}" ${group.open ? 'open' : ''}>
      <summary>${group.title}<span class="group-meta">${group.meta}</span><span class="chevron">⌄</span></summary>
      ${group.controls.map(([id, label, min, max, step]) => `<div class="slider"><label for="${id}">${label}<output id="${id}-value">${adjustmentLabel(id, editor.defaults[id])}</output></label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${editor.defaults[id]}"></div>`).join('')}
    </details>`).join('');

  let source = null;
  let crop = { x: .06, y: .06, w: .88, h: .88 };
  let drag = null;
  let renderTimer = null;
  let photoPrepTimer = null;
  let preparationPromise = null;
  let preparationVersion = -1;
  let cachedPhoto = null;
  let editVersion = 0;
  let photoObjectUrl = null;
  let outputName = 'positive';
  let comparing = false;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const filmMode = () => document.querySelector('input[name="film"]:checked').value;
  const settings = () => ({
    film: filmMode(),
    auto: $('auto-levels').checked,
    ...Object.fromEntries(controls.map(id => [id, Number($(id).value)]))
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

  function renderTo(canvas, maxSide, options = settings()) {
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
    editor.processPixels(pixels, canvas.width, canvas.height, options);
    ctx.putImageData(pixels, 0, 0);
  }

  function schedulePreview(delay = 130, invalidate = true) {
    if (!source) return;
    clearTimeout(renderTimer);
    if (invalidate) {
      editVersion++;
      cachedPhoto = null;
      clearTimeout(photoPrepTimer);
      photosButton.disabled = true;
      viewImageButton.disabled = true;
      photosButton.textContent = 'Preparing photo…';
    }
    if (!comparing) setStatus('Processing…');
    renderTimer = setTimeout(() => {
      try {
        renderTo(resultView, 1200, comparing ? { ...settings(), ...editor.defaults } : settings());
        emptyPreview.classList.add('hidden');
        resultWrap.classList.remove('hidden');
        setStatus(comparing ? 'Before adjustments' : `${resultView.width} × ${resultView.height} preview`);
        saveButton.disabled = false;
        $('auto-adjust').disabled = false;
        $('compare').disabled = false;
        if (!comparing && !cachedPhoto) {
          clearTimeout(photoPrepTimer);
          photoPrepTimer = setTimeout(() => preparePhotos(editVersion), 550);
        }
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
        for (const id of controls) setAdjustment(id, editor.defaults[id]);
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
  $('flip').addEventListener('click', () => {
    if (!source) return;
    const flipped = document.createElement('canvas');
    flipped.width = source.width; flipped.height = source.height;
    const ctx = flipped.getContext('2d', { alpha: false });
    ctx.translate(flipped.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(source, 0, 0);
    source = flipped;
    crop.x = 1 - crop.x - crop.w;
    drawSourceView(); schedulePreview(0);
  });

  function setAdjustment(id, value) {
    $(id).value = value;
    $(`${id}-value`).value = adjustmentLabel(id, value);
  }

  for (const id of controls) {
    $(id).addEventListener('input', () => {
      setAdjustment(id, $(id).value);
      schedulePreview();
    });
  }
  function syncFilmControls() {
    $('editor-controls').querySelector('[data-group="color"]').classList.toggle('hidden', filmMode() === 'bw');
  }
  document.querySelectorAll('input[name="film"]').forEach(el => el.addEventListener('change', () => { syncFilmControls(); schedulePreview(0); }));
  syncFilmControls();
  $('auto-levels').addEventListener('change', () => schedulePreview(0));
  $('reset-adjustments').addEventListener('click', () => {
    for (const id of controls) setAdjustment(id, editor.defaults[id]);
    schedulePreview(0);
  });
  $('auto-adjust').addEventListener('click', () => {
    if (!source) return;
    setStatus('Analyzing photo…');
    try {
      const sample = document.createElement('canvas');
      renderTo(sample, 600, { ...settings(), ...editor.defaults });
      const pixels = sample.getContext('2d').getImageData(0, 0, sample.width, sample.height);
      const values = editor.analyzeAuto(pixels, filmMode());
      for (const id of controls) setAdjustment(id, values[id]);
      schedulePreview(0);
    } catch (error) { console.error(error); setStatus('Auto Adjust could not analyze this photo'); }
  });
  const compare = $('compare');
  const startCompare = (event) => { if (compare.disabled) return; event.preventDefault(); comparing = true; schedulePreview(0, false); };
  const stopCompare = () => { if (comparing) { comparing = false; schedulePreview(0, false); } };
  compare.addEventListener('pointerdown', startCompare);
  compare.addEventListener('pointerup', stopCompare);
  compare.addEventListener('pointercancel', stopCompare);
  compare.addEventListener('pointerleave', stopCompare);
  compare.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') startCompare(event); });
  compare.addEventListener('keyup', stopCompare);

  async function exportBlob() {
    await nextFrame();
    const canvas = document.createElement('canvas');
    try {
      renderTo(canvas, 4000);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG export failed')), 'image/jpeg', .94));
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  async function preparePhotos(version) {
    photoPrepTimer = null;
    if (version !== editVersion || cachedPhoto) return;
    if (preparationPromise) {
      try { await preparationPromise; } catch { /* A previous attempt may have failed. */ }
      if (version !== editVersion || cachedPhoto) return;
    }
    const work = exportBlob();
    preparationPromise = work;
    preparationVersion = version;
    try {
      const blob = await work;
      if (version === editVersion) {
        cachedPhoto = blob;
        photosButton.disabled = false;
        viewImageButton.disabled = false;
        photosButton.textContent = 'Save to Photos';
      }
    } catch (error) {
      console.error(error);
      if (version === editVersion) { photosButton.textContent = 'Save to Photos'; setStatus('Could not prepare Photos image'); }
    } finally {
      if (preparationPromise === work) { preparationPromise = null; preparationVersion = -1; }
    }
  }

  async function saveJPEG() {
    if (!source) return;
    saveButton.disabled = true;
    setStatus('Preparing high-resolution image…');
    try {
      clearTimeout(photoPrepTimer);
      photoPrepTimer = null;
      const version = editVersion;
      const blob = cachedPhoto || await (preparationPromise && preparationVersion === version ? preparationPromise : exportBlob());
      if (version === editVersion) {
        cachedPhoto = blob;
        photosButton.disabled = false;
        viewImageButton.disabled = false;
        photosButton.textContent = 'Save to Photos';
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `${outputName}-positive.jpg`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus('JPEG ready');
    } catch (error) { console.error(error); setStatus('Could not save JPEG'); }
    finally { saveButton.disabled = false; }
  }

  function openPhotosDialog(blob) {
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = URL.createObjectURL(blob);
    $('photos-preview').src = photoObjectUrl;
    $('photos-dialog').showModal();
    setStatus('Touch and hold the image to save it');
  }

  function saveToPhotos() {
    if (!cachedPhoto) return;
    const name = `${outputName}-positive.jpg`;
    if (navigator.share && typeof File !== 'undefined') {
      const file = new File([cachedPhoto], name, { type: 'image/jpeg' });
      try {
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          setStatus('Choose Save Image in the share sheet');
          // Call share during this tap; awaiting image conversion first can lose Safari's user activation.
          Promise.resolve(navigator.share({ files: [file] })).then(
            () => setStatus('Share sheet closed'),
            error => {
              if (error.name === 'AbortError') setStatus('Save cancelled');
              else { console.error(error); openPhotosDialog(cachedPhoto); }
            }
          );
          return;
        }
      } catch (error) { console.error(error); }
    }
    openPhotosDialog(cachedPhoto);
  }

  saveButton.addEventListener('click', saveJPEG);
  photosButton.addEventListener('click', saveToPhotos);
  viewImageButton.addEventListener('click', () => { if (cachedPhoto) openPhotosDialog(cachedPhoto); });
  $('close-photos').addEventListener('click', () => $('photos-dialog').close());
  $('photos-dialog').addEventListener('close', () => {
    $('photos-preview').removeAttribute('src');
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = null;
  });
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => usePhoto(e.dataTransfer.files[0]));
  window.addEventListener('resize', fitSourceView);
})();
