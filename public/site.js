const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function setupFrames() {
  const scene = document.querySelector('[data-scene]');
  if (!scene) return;
  const hero = scene.closest('.hero');
  const frames = [...hero.querySelectorAll('template')];
  const controls = hero.querySelector('.frame-controls');
  const caption = hero.querySelector('[data-caption]');
  const play = controls.querySelector('[data-play]');
  const status = hero.querySelector('[data-frame-status]');
  const poster = scene.firstElementChild;
  let current = poster;
  let index = 0;
  let paused = false;
  let visible = true;
  let timer;
  let version = 0;

  function describe(manual = false) {
    const name = frames[index].dataset.frameName;
    caption.textContent = name;
    caption.href = frames[index].dataset.frameUrl;
    hero.querySelector('[data-counter]').textContent = String(index + 1).padStart(2, '0') + ' / ' + String(frames.length).padStart(2, '0');
    if (manual) status.textContent = 'Featured stay ' + (index + 1) + ' of ' + frames.length + '. ' + name;
  }

  function schedule() {
    clearTimeout(timer);
    const playing = !paused && visible && !document.hidden && document.activeElement !== caption && !reducedMotion.matches;
    hero.classList.toggle('playing', playing);
    const action = paused ? 'Play' : 'Pause';
    play.dataset.cursor = action;
    play.setAttribute('aria-label', action + ' slideshow');
    play.querySelector('[data-glyph]').textContent = paused ? '▶' : 'Ⅱ';
    if (playing) timer = setTimeout(() => advance(false), 6800);
  }

  async function advance(manual) {
    const request = ++version;
    const next = (index + 1) % frames.length;
    const shot = frames[next].content.firstElementChild.cloneNode(true);
    shot.setAttribute('aria-hidden', 'true');
    const img = shot.querySelector('img');
    img.loading = 'eager';
    scene.append(shot);
    try { await img.decode(); } catch { shot.remove(); if (request === version) schedule(); return; }
    if (request !== version || reducedMotion.matches || (!manual && (paused || !visible || document.hidden || document.activeElement === caption))) {
      shot.remove();
      return;
    }
    const previous = current;
    shot.getBoundingClientRect();
    shot.classList.add('current');
    shot.removeAttribute('aria-hidden');
    previous.setAttribute('aria-hidden', 'true');
    previous.classList.replace('current', 'outgoing');
    current = shot;
    index = next;
    setTimeout(() => { if (previous !== current) previous.remove(); }, 1650);
    describe(manual);
    schedule();
  }

  function togglePlay() {
    if (reducedMotion.matches) return;
    paused = !paused;
    version++;
    schedule();
  }
  play.addEventListener('click', togglePlay);
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let mouseOnBackdrop = false;
  hero.addEventListener('pointerdown', event => {
    mouseOnBackdrop = finePointer.matches && event.pointerType === 'mouse' && event.button === 0 && event.target === hero;
  });
  hero.addEventListener('pointercancel', () => { mouseOnBackdrop = false; });
  hero.addEventListener('click', event => {
    if (mouseOnBackdrop && event.target === hero && event.detail > 0) togglePlay();
    mouseOnBackdrop = false;
  });
  controls.querySelector('[data-next]').addEventListener('click', () => {
    clearTimeout(timer);
    advance(true);
  });
  function configure() {
    version++;
    controls.hidden = reducedMotion.matches;
    if (reducedMotion.matches) {
      scene.replaceChildren(poster);
      current = poster;
      current.classList.remove('outgoing');
      current.classList.add('current');
      current.removeAttribute('aria-hidden');
      index = 0;
      describe();
    }
    schedule();
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); }).observe(hero);
  }
  caption.addEventListener('focus', schedule);
  caption.addEventListener('blur', () => requestAnimationFrame(schedule));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', configure);
  configure();
}

function setupFilters() {
  const form = document.querySelector('.filters');
  if (!form) return;
  form.hidden = false;
  const {guests, tub, pool} = form.elements;
  const cards = [...document.querySelectorAll('[data-stay]')];
  const empty = document.querySelector('.empty');
  const count = document.querySelector('[data-count]');

  function render() {
    let matches = 0;
    for (const card of cards) {
      card.hidden = Number(card.dataset.guests) < Number(guests.value)
        || (tub?.checked && card.dataset.tub !== 'true') || (pool.checked && card.dataset.pool !== 'true');
      if (!card.hidden) matches++;
    }
    count.textContent = matches + (matches === 1 ? ' stay' : ' stays');
    empty.hidden = matches > 0;
  }

  function readUrl() {
    const params = new URLSearchParams(location.search);
    guests.value = params.get('guests') || '0';
    if (!guests.value) guests.value = '0';
    if (tub) tub.checked = params.get('tub') === '1';
    pool.checked = params.get('pool') === '1';
    render();
  }

  function update() {
    const url = new URL(location.href);
    for (const [key, value] of [['guests',guests.value === '0' ? '' : guests.value], ['tub',tub?.checked ? '1' : ''], ['pool',pool.checked ? '1' : '']]) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
    render();
  }

  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('change', update);
  form.addEventListener('reset', () => requestAnimationFrame(update));
  empty.querySelector('button').addEventListener('click', () => { form.reset(); guests.focus(); });
  window.addEventListener('pageshow', readUrl);
  window.addEventListener('popstate', readUrl);
  readUrl();
}


function setupGallery() {
  const reel = document.querySelector('.gallery');
  if (!reel) return;
  const links = [...reel.querySelectorAll('[data-photo]')];
  const buttons = document.querySelector('.reel-controls');
  buttons.hidden = false;
  buttons.addEventListener('click', event => {
    const step = event.target.closest('[data-reel]');
    if (step) reel.scrollBy({left:Number(step.dataset.reel) * (links[1].offsetLeft - links[0].offsetLeft),
      behavior:reducedMotion.matches ? 'instant' : 'smooth'});
  });
  let drag;
  let dragged = false;
  reel.addEventListener('dragstart', event => event.preventDefault());
  reel.addEventListener('pointerdown', event => {
    dragged = false;
    if (event.pointerType === 'mouse' && event.button === 0) drag = {x:event.clientX, left:reel.scrollLeft};
  });
  reel.addEventListener('pointermove', event => {
    if (!drag) return;
    if (!event.buttons) { endDrag(); return; }
    const delta = event.clientX - drag.x;
    if (Math.abs(delta) < 6 && !dragged) return;
    dragged = true;
    reel.setPointerCapture(event.pointerId);
    reel.classList.add('dragging');
    reel.scrollLeft = drag.left - delta;
  });
  function endDrag() { drag = null; reel.classList.remove('dragging'); }
  reel.addEventListener('pointerup', endDrag);
  reel.addEventListener('pointercancel', endDrag);
  reel.addEventListener('click', event => {
    if (dragged && event.detail) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; }
  }, true);

  const dialog = document.querySelector('.lightbox');
  if (typeof dialog.showModal !== 'function') return;
  const stage = dialog.querySelector('.lightbox-content');
  let selected = 0;
  let version = 0;
  async function show(index) {
    const request = ++version;
    selected = (index + links.length) % links.length;
    const link = links[selected];
    const image = new Image();
    image.alt = link.querySelector('img').alt;
    image.src = link.href;
    try { await image.decode(); } catch { /* Show the alt text if the asset is missing. */ }
    if (request !== version || !dialog.open) return;
    const previous = stage.lastElementChild;
    stage.append(image);
    image.getBoundingClientRect();
    image.classList.add('current');
    if (previous) {
      previous.setAttribute('aria-hidden','true');
      previous.classList.remove('current');
      setTimeout(() => previous.remove(), 400);
    }
    dialog.querySelector('[data-gallery-status]').textContent = (selected + 1) + ' / ' + links.length + ' · ' + image.alt;
    const preload = new Image();
    preload.src = links[(selected + 1) % links.length].href;
  }
  links.forEach((link, i) => link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    dialog.showModal();
    show(i);
  }));
  for (const button of dialog.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => show(selected + Number(button.dataset.step)));
  }
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { version++; stage.replaceChildren(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(selected + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  let start;
  stage.addEventListener('pointerdown', event => {
    start = {x:event.clientX, y:event.clientY};
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointercancel', () => { start = null; });
  stage.addEventListener('pointerup', event => {
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(event.clientY - start.y)) show(selected + (dx < 0 ? 1 : -1));
    start = null;
  });
}

function setupReveals() {
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js');
  const observer = new IntersectionObserver(entries => {
    for (const {target,isIntersecting} of entries) {
      if (!isIntersecting) continue;
      target.classList.add('revealed');
      observer.unobserve(target);
    }
  }, {threshold:0.03});
  document.querySelectorAll('.stay-card, .guide-entry, .feature-photo, .chapter-copy, .chapter-shot').forEach(el => {
    if (el.getBoundingClientRect().top < innerHeight && !el.hidden) return;
    el.classList.add('reveal');
    observer.observe(el);
  });
}

function setupIndex() {
  const index = document.querySelector('.stay-index');
  if (!index) return;
  let selected;
  function select(link) {
    if (!link || link === selected) return;
    selected?.classList.remove('selected');
    selected = link;
    selected.classList.add('selected');
  }
  select(index.querySelector('.index-link:focus') || index.querySelector('.index-link'));
  index.classList.add('has-preview');
  index.addEventListener('focusin', event => select(event.target.closest('.index-link')));
  index.addEventListener('pointerover', event => {
    if (event.pointerType === 'mouse') select(event.target.closest('.index-link'));
  });
  const controls = document.querySelector('.index-controls');
  controls.hidden = false;
  function update() {
    controls.firstElementChild.disabled = index.scrollLeft < 2;
    controls.lastElementChild.disabled = index.scrollWidth - index.clientWidth - index.scrollLeft < 2;
  }
  controls.addEventListener('click', event => {
    const button = event.target.closest('[data-index-step]');
    if (!button) return;
    const step = index.children[1].offsetLeft - index.children[0].offsetLeft;
    index.scrollBy({left:step * Number(button.dataset.indexStep), behavior:reducedMotion.matches ? 'instant' : 'smooth'});
  });
  index.addEventListener('scroll', update, {passive:true});
  window.addEventListener('resize', update, {passive:true});
  index.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    select(event.target.closest('.index-link'));
    if (reducedMotion.matches) return;
    const rect = index.getBoundingClientRect();
    const progress = (event.clientY - rect.top) / rect.height - .5;
    index.style.setProperty('--follow', Math.round(progress * 64) + 'px');
  }, {passive:true});
  index.addEventListener('pointerleave', () => index.style.removeProperty('--follow'));
  update();
}

function setupCursor() {
  const fine = matchMedia('(hover:hover) and (pointer:fine) and (not (any-pointer:coarse)) and (prefers-reduced-motion:no-preference)');
  let cleanup;
  function configure() {
    cleanup?.();
    if (!fine.matches || navigator.maxTouchPoints) return;
    const ring = document.createElement('div');
    const dot = document.createElement('div');
    ring.className = 'cursor-ring';
    dot.className = 'cursor-dot';
    const label = document.createElement('span');
    ring.append(label);
    for (const el of [ring,dot]) {
      el.setAttribute('aria-hidden','true');
      document.body.append(el);
    }
    const controller = new AbortController();
    const options = {passive:true, signal:controller.signal};
    let x, y, rx, ry, frame = 0, magnetic, mouseActive = false;
    function place(el, x, y) {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    function tick() {
      rx += (x - rx) * .19;
      ry += (y - ry) * .19;
      place(ring, rx, ry);
      frame = Math.abs(x-rx) + Math.abs(y-ry) > .15 ? requestAnimationFrame(tick) : 0;
    }
    function resetMagnet() {
      if (magnetic) magnetic.style.translate = '';
      magnetic = null;
    }
    function hide() {
      resetMagnet();
      document.body.classList.remove('custom-pointer');
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function move(event) {
      mouseActive = event.pointerType === 'mouse';
      x = event.clientX;
      y = event.clientY;
      const target = event.target;
      if (!mouseActive || !(target instanceof Element) || target.closest('dialog, label, input, select, textarea, [contenteditable], .booking-form')) {
        hide();
        return;
      }
      const surface = target.closest('[data-cursor], a, button, summary');
      if (!surface && target.closest('h1, h2, h3, p, dd, dt, .amenities li')) { hide(); return; }
      if (rx === undefined) { rx = x; ry = y; }
      document.body.classList.add('custom-pointer');
      const next = surface?.dataset.cursor || (target.matches('.hero') ? target.querySelector('[data-play]').dataset.cursor : '');
      if (next !== label.textContent) {
        label.textContent = next;
        if (next) label.animate([{clipPath:'inset(100% 0 0)'},{clipPath:'inset(0)'}], {duration:200});
      }
      ring.classList.toggle('labeled', Boolean(next));
      const magnet = surface?.matches('a.button, .nav-book') ? surface : null;
      if (magnet !== magnetic) resetMagnet();
      if (magnet) {
        magnetic = magnet;
        const rect = magnet.getBoundingClientRect();
        const pull = n => Math.max(-6, Math.min(6,n * .1));
        magnet.style.translate = `${pull(x-rect.left-rect.width/2)}px ${pull(y-rect.top-rect.height/2)}px`;
      }
      place(dot,x,y);
      if (!frame) tick();
    }
    function deactivate() { mouseActive = false; hide(); }
    document.addEventListener('pointermove',move,options);
    document.addEventListener('click', event => { if (event.pointerType === 'mouse') move(event); },options);
    document.addEventListener('toggle', event => { if (event.target.matches('dialog[open]')) deactivate(); }, {...options,capture:true});
    document.documentElement.addEventListener('pointerleave',deactivate,options);
    document.addEventListener('keydown',deactivate,options);
    window.addEventListener('scroll', () => {
      if (mouseActive && x !== undefined) move({target:document.elementFromPoint(x,y), pointerType:'mouse', clientX:x, clientY:y});
    },options);
    window.addEventListener('blur',deactivate,options);
    cleanup = () => { hide(); controller.abort(); ring.remove(); dot.remove(); };
  }
  fine.addEventListener('change', configure);
  configure();
}

const menu = document.querySelector('.mobile-nav');
document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
menu.addEventListener('keydown', event => {
  if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
});
setupFrames();
setupIndex();
setupFilters();
setupGallery();
setupReveals();
setupCursor();
