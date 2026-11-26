function setupFrames() {
  const data = document.getElementById('frames');
  if (!data) return;
  const frames = JSON.parse(data.textContent);
  const scene = document.querySelector('.hero-scene');
  const caption = document.querySelector('[data-caption]');
  const counter = document.querySelector('[data-counter]');
  let selected = 0;
  let version = 0;

  async function changeFrame(step) {
    selected = (selected + step + frames.length) % frames.length;
    const request = ++version;
    const frame = frames[selected];
    const picture = frame.image;
    const image = new Image();
    image.className = 'hero-image';
    image.alt = picture.alt;
    image.width = picture.width;
    image.height = picture.height;
    image.sizes = '100vw';
    image.srcset = [picture.small + ' 640w', picture.medium && picture.medium + ' 960w',
      picture.src + ' ' + picture.width + 'w'].filter(Boolean).join(', ');
    image.src = picture.src;
    try { await image.decode(); } catch { return; }
    if (request !== version) return;
    scene.replaceChildren(image);
    caption.href = frame.url;
    caption.textContent = frame.name;
    counter.textContent = String(selected + 1).padStart(2, '0') + ' / ' + String(frames.length).padStart(2, '0');
    document.querySelector('[data-frame-status]').textContent = 'Featured photo ' + (selected + 1) + ' of ' + frames.length + '. ' + frame.name;
  }

  const controls = document.querySelector('.frame-controls');
  controls.hidden = false;
  for (const button of controls.querySelectorAll('button')) {
    button.addEventListener('click', () => changeFrame(Number(button.dataset.frame)));
  }
}

function setupFilters() {
  const form = document.querySelector('.filters');
  if (!form) return;
  const {guests, tub, pool} = form.elements;
  const cards = [...document.querySelectorAll('[data-stay]')];
  const empty = document.querySelector('.empty');
  const count = document.querySelector('[data-count]');

  function render() {
    let matches = 0;
    for (const card of cards) {
      card.hidden = Number(card.dataset.guests) < Number(guests.value)
        || (tub.checked && card.dataset.tub !== 'true') || (pool.checked && card.dataset.pool !== 'true');
      if (!card.hidden) matches++;
    }
    count.textContent = matches + (matches === 1 ? ' stay' : ' stays');
    empty.hidden = matches > 0;
  }

  function readUrl() {
    const params = new URLSearchParams(location.search);
    guests.value = params.get('guests') || '0';
    if (!guests.value) guests.value = '0';
    tub.checked = params.get('tub') === '1';
    pool.checked = params.get('pool') === '1';
    render();
  }

  function update() {
    const url = new URL(location.href);
    for (const [key, value] of [['guests',guests.value === '0' ? '' : guests.value], ['tub',tub.checked ? '1' : ''], ['pool',pool.checked ? '1' : '']]) {
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
  const dialog = document.querySelector('.lightbox');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const photos = [...document.querySelectorAll('[data-photo]')];
  const large = dialog.querySelector('[data-large]');
  let selected = 0;
  function show(index) {
    selected = (index + photos.length) % photos.length;
    const link = photos[selected];
    large.src = link.href;
    large.alt = link.querySelector('img').alt;
    dialog.querySelector('[data-gallery-status]').textContent = (selected + 1) + ' / ' + photos.length + ' · ' + large.alt;
  }
  photos.forEach((link, i) => link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    show(i);
    dialog.showModal();
  }));
  for (const button of dialog.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => show(selected + Number(button.dataset.step)));
  }
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(selected + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
}

function setupMotion() {
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  if (motion.matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      }
    }, {threshold:.12});
    const elements = document.querySelectorAll('.reveal, .stay-card, .guide-entry');
    elements.forEach(el => { if (el.getBoundingClientRect().top > innerHeight) observer.observe(el); });
  }

  const fine = matchMedia('(hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) and (prefers-reduced-motion: no-preference)');
  let controller;
  let ring;
  function configurePointer() {
    controller?.abort();
    ring?.remove();
    if (!fine.matches || navigator.maxTouchPoints) return;
    controller = new AbortController();
    ring = document.createElement('span');
    ring.className = 'cursor-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.hidden = true;
    document.body.append(ring);
    const options = {passive:true, signal:controller.signal};
    document.addEventListener('pointermove', event => {
      ring.hidden = event.pointerType !== 'mouse';
      ring.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px) translate(-50%, -50%)';
      ring.classList.toggle('over-link', Boolean(event.target.closest('a, button, select, summary, label')));
    }, options);
    document.documentElement.addEventListener('pointerleave', () => { ring.hidden = true; }, options);
    document.addEventListener('keydown', () => { ring.hidden = true; }, options);
  }
  configurePointer();
  fine.addEventListener('change', configurePointer);
}

const menu = document.querySelector('.mobile-nav');
document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
menu.addEventListener('keydown', event => {
  if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
});
setupFrames();
setupFilters();
setupGallery();
setupMotion();
