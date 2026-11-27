export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
}

export function json(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export const stayPath = stay => '/stays/' + stay.slug + '/';
export const capacity = stay => stay.guests + ' guests';
export const amenities = stay => [
  ...(stay.hotTub && !stay.amenities.includes('Two private hot tubs') ? ['Private hot tub'] : []),
  ...(stay.cowboyPool ? ['Cowboy pool'] : []),
  ...stay.amenities
];

export const mark = `<svg viewBox="0 0 44 48" class="mark" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <path d="M3 42V24a19 19 0 0 1 38 0v18z"/><circle cx="28" cy="18" r="4"/>
  <path d="m3 34 8-9q3-3 6 0l16 17M18 32l5-5q3-3 6 0l12 11M3 38l8-8 12 12"/>
</svg>`;
const brand = `<a class="brand" href="/" aria-label="Stay Eden home">${mark}<span>Stay Eden</span></a>`;
export const arrow = side => `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${side === 'back' ? 'm14 5-7 7 7 7' : 'm10 5 7 7-7 7'}"/></svg>`;
export const eyebrow = label => `<p class="eyebrow"><span class="short-rule" aria-hidden="true"></span>${escapeHtml(label)}</p>`;
export const siteLinks = [['/stays/','The stays'],['/experiences/','Field guide'],['/extras/','Stay extras'],['/about/','About'],['/faq/','FAQ'],['/contact/','Contact']];

function link([href, name], route) {
  return `<a href="${href}"${route === href ? ' aria-current="page"' : ''}>${name}</a>`;
}

export function header(route, overPhoto = false) {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="site-header${overPhoto ? ' over-photo' : ''}">
    <div class="topbar shell">${brand}
      <nav class="desktop-nav" aria-label="Main">${[siteLinks[0], siteLinks[1], siteLinks[3], siteLinks[5]].map(item => link(item, route)).join('')}</nav>
      <a class="nav-book" href="/stays/#collection">Find a stay</a>
      <details class="mobile-nav"><summary aria-label="Navigation menu"><span class="hamburger" aria-hidden="true"></span> Menu</summary>
      <nav aria-label="Mobile">${siteLinks.map(item => link(item, route)).join('')}</nav></details>
    </div>
  </header>`;
}

export function footer(route) {
  return `<footer class="site-footer"><div class="shell footer-top"><div>${brand}<p>Fredericksburg, Texas</p></div>
    <nav aria-label="Footer">${siteLinks.map(item => link(item, route)).join('')}</nav></div>
    <div class="shell footer-base"><span>© ${new Date().getUTCFullYear()} Stay Eden · Abenteuer Management</span><a href="https://www.instagram.com/stayeden_fredericksburgtx/">Instagram</a></div></footer>`;
}

export function photo(image, {sizes = '100vw', priority = false, className = ''} = {}) {
  return `<img src="${image.src}" srcset="${image.small} ${Math.min(640, image.width)}w, ${image.medium ? image.medium + " 960w, " : ""}${image.src} ${image.width}w"
    sizes="${sizes}" width="${image.width}" height="${image.height}" alt="${escapeHtml(image.alt)}"
    class="${className}" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
}

// The portrait crop is reserved for full-height mobile heroes.
export const portraitMedia = '(orientation: portrait) and (max-width: 900px)';

export function picture(image, options = {}, portrait = false) {
  if (!image.wide) return photo(image, options);
  const sizes = options.sizes || '100vw';
  return `<picture>${portrait && image.portrait ? `<source media="${portraitMedia}" type="image/avif" srcset="${image.portrait}" sizes="100vw">` : ''}
    <source type="image/avif" srcset="${image.wide}" sizes="${sizes}">${photo(image, options)}</picture>`;
}

export function stayCard(stay, {filter = false, priority = false} = {}) {
  return `<article class="stay-card" ${filter ? `data-stay data-guests="${stay.guests}" data-tub="${stay.hotTub}" data-pool="${stay.cowboyPool}"` : ''}>
    <a class="card-link" href="${stayPath(stay)}" data-cursor="View">
      <div class="card-image stay-frame" style="view-transition-name:stay-${stay.slug}">
        ${picture(stay.photos[0], {sizes:'(max-width: 609px) 90vw, (max-width: 959px) 44vw, 30vw', priority})}
      </div>
      <p class="card-meta">${stay.type}<span>·</span>${capacity(stay)}</p>
      <h3>${stay.name}</h3><p class="card-desc">${stay.feature}</p></a></article>`;
}

export function pageIntro(section, title, copy) {
  return `<div class="page-intro shell">${eyebrow(section)}<h1>${title}</h1><p class="lede">${copy}</p></div>`;
}

export function splitFeature({image, label, title, text, href, cta, dark = false, priority = false}) {
  return `<section class="feature-band${dark ? ' forest' : ''}"><div class="split-feature shell">
    <div class="feature-photo">${picture(image,{sizes:'(min-width: 800px) 52vw, 100vw', priority})}</div>
    <div class="feature-copy">${eyebrow(label)}<h2>${title}</h2><p>${text}</p><a class="text-link" href="${href}">${cta}</a></div>
    </div></section>`;
}
