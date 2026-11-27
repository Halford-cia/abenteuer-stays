import { airbnbListing, bookingFor, bookingPanel } from './booking.js';
import { capacity, amenities, arrow, eyebrow, escapeHtml as h, picture, pageIntro, photo, splitFeature, stayCard, stayPath } from './components.js';
import { guide, instagram, paymentSafety, reviewSnapshot } from '../data/editorial.js';

function chapter(stay, image, {label, title, copy, href, link, tone}) {
  return `<section class="chapter ${tone}" aria-label="${label}"><div class="chapter-copy shell">
    ${eyebrow(label)}<div><h2>${title}</h2><p>${copy}</p><a class="text-link" href="${href}">${link}</a></div></div>
    <figure class="chapter-shot"><div class="chapter-window">${picture(image)}</div>
    <figcaption><a href="${stayPath(stay)}">${stay.name}</a></figcaption></figure></section>`;
}

function filmShot(image, opening = false) {
  const {focus, from, to} = image.motion;
  return `<div class="film-shot${opening ? ' current opening' : ''}" style="--focus:${focus};--from:${from};--to:${to}">
    ${picture(image, {priority:opening}, true)}</div>`;
}

function stayIndex(stays) {
  return `<section class="section shell" id="featured" aria-labelledby="index-title">
    ${eyebrow('The collection')}<div class="section-heading"><h2 id="index-title">The ten <em>stays.</em></h2>
      <a class="text-link" href="/stays/#collection">Filter by guests &amp; amenities</a></div>
    <ul class="stay-index">${stays.map(stay => `<li><a class="index-link" href="${stayPath(stay)}" data-cursor="View">
      <span class="index-image stay-frame" style="view-transition-name:stay-${stay.slug}">
        ${picture(stay.photos[0],{sizes:'(max-width: 759px) 78vw, 44vw'})}
        <span class="index-feature">${h(stay.feature)}</span></span>
      <span class="index-name">${stay.name}</span><span class="index-meta">${capacity(stay)}</span></a></li>`).join('')}</ul>
    <div class="index-controls reel-controls" hidden><button data-index-step="-1" aria-label="Previous stay">${arrow('back')}</button>
      <button data-index-step="1" aria-label="Next stay">${arrow('next')}</button></div></section>`;
}

export function home(stays) {
  const bySlug = slug => stays.find(stay => stay.slug === slug);
  const sequence = ['treehouse-serenity-dome', 'cherry-cove', 'lunar-dome'].map(bySlug);
  const [first] = sequence;
  const evening = bySlug('oak-retreat');
  const night = bySlug('pecan-haven');
  const word = word => `<span class="word"><span>${word}</span></span>`;
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-scene" data-scene>${filmShot(first.photos[0], true)}</div>
    ${sequence.map(stay => `<template data-frame-name="${stay.name}" data-frame-url="${stayPath(stay)}">${filmShot(stay.photos[0])}</template>`).join('')}
    <div class="hero-body shell">
      ${eyebrow('Fredericksburg, Texas')}
      <h1 id="hero-title"><span class="sr-only">Dusk in the Hill Country.</span><span aria-hidden="true">${word('Dusk')} ${word('in')} ${word('the')}<br><em>${word('Hill')} ${word('Country.')}</em></span></h1>
      <p>Ten private stays among the oaks, from treetop domes to canvas hideaways.</p>
      <a class="button light" href="#featured">Explore the stays</a>
    </div>
    <div class="hero-foot shell"><a class="scroll-link" href="#featured"><span class="scroll-line" aria-hidden="true"></span>The collection</a>
      <div class="frame"><span class="frame-label">On location</span><a data-caption href="${stayPath(first)}">${first.name}</a>
        <div class="frame-controls" hidden><span data-counter aria-hidden="true">01 / 03</span>
          <button type="button" data-next aria-label="Next featured stay">${arrow('next')}</button>
          <button type="button" data-play aria-label="Pause slideshow"><span data-glyph aria-hidden="true">Ⅱ</span></button></div></div>
      <span class="sr-only" role="status" data-frame-status></span></div></section>
    ${stayIndex(stays)}
    ${chapter(evening, evening.photos[2], {label:'Evening', title:'By the last <em>light.</em>',copy:'At Oak Retreat, the hammock hangs between the canvas tent and the hot tub. Stay out on the deck as the last pink leaves the sky.',href:stayPath(evening),link:'Step inside Oak Retreat',tone:'dusk'})}
    ${chapter(night, night.photos[0], {label:'Night',title:'Under the <em>canopy.</em>',copy:'String lights trace the way up to Pecan Haven. The canvas treehouse sits ten feet above the ground, with a private hot tub tucked beneath the deck.',href:stayPath(night),link:'Visit Pecan Haven',tone:'night'})}
    ${chapter(first, first.photos[1], {label:'Morning',title:'Wake with <em>the hills.</em>',copy:'Take your coffee slowly. When you’re ready to head out, spend an afternoon among the vineyards or an evening listening to music in Luckenbach.',href:'/experiences/',link:'Open the field guide',tone:'daybreak'})}
    <section class="proof" aria-label="Airbnb guest ratings"><div class="proof-inner shell">
      <p>Hosted by Victoria<br><span>Airbnb Superhost · ${reviewSnapshot.date}</span></p>
      <dl><div><dt>Host rating</dt><dd>${reviewSnapshot.hostRating}<small> / 5</small></dd></div>
      <div><dt>Guest reviews</dt><dd>${reviewSnapshot.hostReviews}</dd></div>
      <div><dt>Guest Favorite stays</dt><dd>${stays.filter(stay => stay.favorite).length}<small> / ${stays.length}</small></dd></div></dl></div></section>
    <section class="plan-stay shell"><h2>Plan your <em>stay.</em></h2><div><a class="button dark" href="/stays/#collection">Find your stay</a>
      <a class="text-link" href="/contact/">Ask your hosts</a></div></section>`;
}

export function collection(stays) {
  const allHaveHotTubs = stays.every(stay => stay.hotTub);
  return `${pageIntro('Stay Eden · Fredericksburg','The <em>stays.</em>','Find a place for two beneath the trees or bring the whole group to a Hill Country house.')}
    <section class="shell collection" id="collection" aria-label="Stay collection">
      ${allHaveHotTubs ? '<p class="collection-amenity">Every stay has a private hot tub.</p>' : ''}
      <form class="filters" hidden><label class="guest-filter">Guests <select name="guests">
      <option value="0">Any group size</option>${Array.from({length:16}, (_,i) => {
        const n = i + 1;
        return `<option value="${n}">${n} ${n === 1 ? "guest" : "guests"}</option>`;
      }).join("")}</select></label>
      ${allHaveHotTubs ? '' : '<label class="check"><input type="checkbox" name="tub"> Private hot tub</label>'}
      <label class="check"><input type="checkbox" name="pool"> Cowboy pool</label>
      <button class="reset" type="reset">Clear filters</button></form>
      <h2 class="result-count" aria-live="polite"><span data-count>${stays.length} stays</span></h2>
      <div class="card-grid">${stays.map((s, i) => stayCard(s,{filter:true,priority:i === 0})).join('')}</div>
      <div class="empty" hidden><p>There are no stays with this combination. Try another group size or clear your filters.</p><button class="button dark" data-clear>Show all stays</button></div>
    </section>`;
}

export function unit(stay, bundle) {
  const booking = bookingFor(stay);
  const hero = stay.photos[0];
  const framed = hero.framed;
  const detail = stay.photos[1];
  const portrait = detail.height > detail.width;
  const facts = [capacity(stay), stay.type];
  if (stay.hotTub) facts.push(stay.amenities.includes('Two private hot tubs') ? 'Two private hot tubs' : 'Private hot tub');
  if (stay.cowboyPool) facts.push('Cowboy pool');
  return `<section class="unit-hero${framed ? ' framed' : ''}"><div class="unit-still stay-frame" style="view-transition-name:stay-${stay.slug}">
      ${picture(hero,{priority:true, sizes:framed ? '(min-width: 760px) min(54vw, 64rem), 89vw' : '100vw'}, !framed)}</div>
    <div class="unit-title shell">${eyebrow(stay.type + ' · ' + capacity(stay))}<h1>${stay.name}</h1><p>${stay.feature}.</p>
      <a class="text-link" href="/stays/">All stays</a></div></section>
    <div class="booking-bar"><div class="shell"><span>${stay.name}</span><small><span class="sr-only">Rated </span>${stay.rating.toFixed(2)}<span class="sr-only"> out of five</span> <span aria-hidden="true">★</span></small>
      <a class="button dark" href="#availability">${booking.label}</a></div></div>
    <section class="unit-intro shell">${eyebrow('The experience')}<h2>Inside <em>the stay.</em></h2><p class="lede">${stay.description}</p>
      <ul class="fact-row">${facts.map(fact => `<li>${h(fact)}</li>`).join('')}</ul></section>
    <figure class="unit-spread shell${portrait ? ' portrait' : ''}">${picture(detail,{sizes:portrait ? 'min(89vw, 28rem)' : 'min(89vw, 60rem)'})}</figure>
    <div class="shell unit-body"><div><section class="unit-section"><h2>Amenities</h2><ul class="amenities">${amenities(stay).map(item => `<li>${h(item)}</li>`).join('')}</ul></section>
    <section class="unit-section"><h2>House rules</h2><p>Plan for up to ${stay.guests} overnight guests when booking. ${stay.petsAllowed ? 'Airbnb lists pets as welcome here.' : 'Airbnb lists this stay as pet-free.'} Service animals are welcome.</p>
      <a class="text-link" href="${booking.url}">Read the Airbnb house rules</a></section>
    <section class="unit-section"><h2>Guest reviews</h2><p class="review"><span>${stay.rating.toFixed(2)}</span> / 5 · ${stay.reviews} Airbnb reviews</p>
    <p>${stay.favorite ? 'An Airbnb Guest Favorite. ' : ''}Ratings from ${reviewSnapshot.date}. <a href="${booking.url}">Read reviews on Airbnb</a>.</p></section>
    <section class="unit-extra"><img src="${bundle.src}" width="${bundle.width}" height="${bundle.height}" alt="${h(bundle.alt)}" loading="lazy">
      <div>${eyebrow('Arrival bundle')}<h2>Wine &amp; early check-in</h2><p>$75 per bundle, subject to availability.</p>
        <a class="text-link" href="/extras/">Bundle details</a></div></section></div>
    ${bookingPanel(stay)}</div>
    <section class="shell gallery-section">${eyebrow('Photo gallery')}<div class="section-heading"><h2>A closer <em>look.</em></h2>
      <div class="reel-controls" hidden><button data-reel="-1" aria-label="Scroll gallery back">${arrow('back')}</button><button data-reel="1" aria-label="Scroll gallery forward">${arrow('next')}</button></div></div>
    <div class="gallery">${stay.photos.map((image, i) => `<a href="${image.src}" data-photo="${i}" data-cursor="Open" aria-label="Enlarge photo ${i+1}. ${h(image.alt)}">${photo(image,{sizes:'(min-width: 760px) 45vw, 82vw'})}</a>`).join('')}</div>
    <dialog class="lightbox" aria-labelledby="gallery-name"><div class="lightbox-bar"><h3 id="gallery-name">${stay.name} gallery</h3><button type="button" data-close>Close</button></div>
    <div class="lightbox-content"></div><div class="lightbox-controls"><button type="button" data-step="-1">Previous</button><p data-gallery-status aria-live="polite"></p><button type="button" data-step="1">Next</button></div></dialog>
    </section>`;
}

export function experiences() {
  return `${pageIntro('Fredericksburg & beyond','The field <em>guide.</em>','An afternoon among the vines, a little live music or a quiet hour on a trail. Four places to build a Hill Country day around.')}
    <section class="shell guide-list" aria-label="Destinations">${guide.map(item => `<article class="guide-entry">${eyebrow(item.place)}<div><h2>${item.name}</h2><p>${item.text}</p><a class="text-link" href="${item.url}">${item.label}</a></div></article>`).join('')}</section>`;
}

export function extras(stays) {
  return `${pageIntro('Stay extras','Arrive a little <em>earlier.</em>','Enjoy a glass of wine and an earlier arrival in the Hill Country.')}
    <section class="shell editorial-split"><div class="editorial-photo">${picture(stays.find(s => s.slug === 'cherry-cove').photos[3],{priority:true,sizes:'(min-width: 800px) 50vw, 100vw'})}</div>
    <div class="editorial-copy">${eyebrow('The arrival bundle')}<h2>Wine &amp;<br><em>early check-in.</em></h2><p class="price">$75 <span>per bundle</span></p>
    <p>Pair wine with an earlier arrival. Once you’ve reserved your stay, ask for the bundle in your Airbnb message thread. Your host will confirm availability and the check-in time.</p><p>${paymentSafety}</p>
    <a class="button dark" href="/contact/">Contact your host</a></div></section>`;
}

export function about(stays) {
  return `${pageIntro('About Stay Eden','At home <em>among the oaks.</em>','Stay Eden is a collection of ten private stays in the Texas Hill Country, hosted by Victoria and Henry.')}
    ${splitFeature({image:stays[5].photos[0], label:'The property', title:'A little room <em>between neighbors.</em>', text:'At the glamping property, canvas tents and geodesic domes sit about 150 to 300 feet apart. Some decks look out into the branches. Others open to a cowboy pool or a hammock chair for two.',href:'/stays/',cta:'Explore the collection',priority:true})}
    <section class="narrow section"><h2>Your hosts</h2><p>Victoria is the Airbnb Superhost behind the collection, with Henry as co-host. Stay Eden is operated by Abenteuer Management (Alford &amp; Pruitt Investments LLC).</p>
    <p>Reach out with questions about a particular stay or help planning an arrival.</p><a class="text-link" href="/contact/">Get in touch</a></section>`;
}

export function contact(stays) {
  return `${pageIntro('Contact','Get in <em>touch.</em>','Victoria and Henry can help you choose a stay or plan an arrival.')}
    <div class="shell contact-layout"><section><h2>Before you book</h2><p>Choose your stay below, then use “Contact host” on its Airbnb listing to ask about dates, amenities or access.</p>
    <ul class="contact-list">${stays.map(s => `<li><a href="${airbnbListing(s)}">${s.name}</a></li>`).join('')}</ul></section>
    <aside class="contact-aside"><h2>Already booked?</h2><p>For arrival details or the $75 wine and early check-in bundle, message your host in your existing reservation thread.</p><p>${paymentSafety}</p>
    <a class="button dark" href="https://www.airbnb.com/trips">Open Airbnb trips</a><hr><p>Find us on Instagram</p><a class="text-link" href="${instagram}">@stayeden_fredericksburgtx</a></aside></div>`;
}

export function faqs(faq) {
  return `${pageIntro('Planning your stay','A few <em>answers.</em>','Details about the properties, reservations and getting here.')}
    <section class="shell faq-section" aria-label="Frequently asked questions">${faq.map(([question,answer]) => `<details><summary>${h(question)}<span aria-hidden="true"></span></summary><p>${h(answer)}</p></details>`).join('')}
    <p class="more-help">Have a question about a specific stay? <a href="/contact/">Ask the hosts</a>.</p></section>`;
}

export function missing(stays) {
  const image = stays.find(s => s.slug === 'lunar-dome').photos[0];
  return `<section class="unit-hero"><div class="unit-still">${picture(image,{priority:true},true)}</div>
    <div class="unit-title shell">${eyebrow('404 · Page not found')}<h1>Lost in <em>the hills.</em></h1><a class="button light" href="/stays/">Find your stay</a></div></section>`;
}
