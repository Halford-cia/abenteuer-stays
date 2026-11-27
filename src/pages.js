import { airbnbListing, bookingFor, bookingPanel } from './booking.js';
import { capacity, amenities, arrow, eyebrow, escapeHtml as h, picture, pageIntro, photo, splitFeature, star, stayCard, stayPath } from './components.js';
import { guide, instagram, paymentSafety, reviewSnapshot } from '../data/editorial.js';

function chapter(stay, image, {label, title, copy, href, link, tone}) {
  return `<section class="chapter ${tone}" aria-label="${label}"><div class="chapter-copy shell">
    ${eyebrow(label)}<div><h2>${title}</h2><p>${copy}</p><a class="text-link" href="${href}">${link}</a></div></div>
    <figure class="chapter-shot"><div class="chapter-window">${picture(image)}</div>
    <figcaption><a href="${stayPath(stay)}">${stay.name}</a></figcaption></figure></section>`;
}

export function home(stays) {
  const bySlug = slug => stays.find(stay => stay.slug === slug);
  const sequence = ['treehouse-serenity-dome', 'cherry-cove', 'lunar-dome'].map(bySlug);
  const [first] = sequence;
  const evening = bySlug('das-grun-haus');
  const morning = bySlug('treehouse-serenity-dome');
  const word = word => `<span class="word"><span>${word}</span></span>`;
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-scene" data-scene>
      <div class="film-shot current">${picture(first.photos[0],{priority:true},true)}</div></div>
    ${sequence.map((stay, index) => `<template data-frame-name="${stay.name}" data-frame-url="${stayPath(stay)}">
      <div class="film-shot">${picture(stay.photos[0],{},true)}</div></template>`).join('')}
    <div class="hero-body shell">
      ${eyebrow('Fredericksburg, Texas')}
      <h1 id="hero-title">${word('Dusk')} ${word('in')} ${word('the')}<br><em>${word('Hill')} ${word('Country.')}</em></h1>
      <p>Ten private stays among the oaks, from treetop domes to canvas hideaways.</p>
      <a class="button light" href="/stays/">Explore the stays <span aria-hidden="true">↗</span></a>
    </div>
    <div class="hero-foot shell"><a class="scroll-link" href="#featured"><span class="scroll-line" aria-hidden="true"></span>The collection</a>
      <div class="frame"><span class="frame-label">On location</span><a data-caption href="${stayPath(first)}">${first.name}</a>
        <div class="frame-controls" hidden><span data-counter aria-hidden="true">01 / 03</span>
          <button type="button" data-next aria-label="Next featured stay">${arrow('next')}</button>
          <button type="button" data-play aria-label="Pause slideshow"><span data-glyph aria-hidden="true">Ⅱ</span></button></div></div>
      <span class="sr-only" role="status" data-frame-status></span></div></section>
    <section class="section shell" id="featured">${eyebrow('The collection')}
      <div class="section-heading"><h2>A place of <em>your own.</em></h2><a class="text-link" href="/stays/">View all ten stays</a></div>
      <div class="card-grid selected-stays">${['treehouse-serenity-dome','cherry-cove','das-grun-haus'].map(slug => stayCard(bySlug(slug))).join('')}</div>
    </section>
    <section class="proof shell" aria-label="Airbnb guest ratings">
      <p>Hosted by Victoria<br><span>Airbnb Superhost · ${reviewSnapshot.date}</span></p>
      <dl><div><dt>Host rating</dt><dd>${reviewSnapshot.hostRating}<small> / 5</small></dd></div>
      <div><dt>Guest reviews</dt><dd>${reviewSnapshot.hostReviews}</dd></div>
      <div><dt>Guest Favorite stays</dt><dd>${stays.filter(stay => stay.favorite).length}<small> / ${stays.length}</small></dd></div></dl></section>
    ${chapter(evening, evening.photos[1], {label:'Evening', title:'By the last <em>light.</em>',copy:'Pull a chair up to the fire at Das Grun Haus. For an earlier start, ask your host about wine and early check-in.',href:'/extras/',link:'The $75 arrival bundle',tone:'dusk'})}
    ${chapter(morning, morning.photos[1], {label:'Morning',title:'Wake with <em>the hills.</em>',copy:'Take a seat at the breakfast counter, where the dome window frames the oaks. Spend the day out among the vineyards or take the short drive to Luckenbach.',href:'/experiences/',link:'Open the field guide',tone:'daybreak'})}`;
}

export function collection(stays) {
  return `${pageIntro('Stay Eden · Fredericksburg','The <em>stays.</em>','Find a place for two beneath the trees or bring the whole group to a Hill Country house.')}
    <section class="shell collection" id="collection" aria-label="Stay collection">
      <form class="filters" hidden><label class="guest-filter">Guests <select name="guests">
      <option value="0">Any group size</option>${Array.from({length:16}, (_,i) => {
        const n = i + 1;
        return `<option value="${n}">${n} ${n === 1 ? "guest" : "guests"}</option>`;
      }).join("")}</select></label>
      <label class="check"><input type="checkbox" name="tub"> Private hot tub</label>
      <label class="check"><input type="checkbox" name="pool"> Cowboy pool</label>
      <button class="reset" type="reset">Clear filters</button></form>
      <h2 class="result-count" aria-live="polite"><span data-count>10 stays</span></h2>
      <div class="card-grid">${stays.map((s, i) => stayCard(s,{filter:true,priority:i === 0})).join('')}</div>
      <div class="empty" hidden><p>There are no stays with this combination. Try another group size or clear your filters.</p><button class="button dark" data-clear>Show all stays</button></div>
    </section>`;
}

export function unit(stay) {
  const booking = bookingFor(stay);
  return `<section class="unit-hero"><div class="unit-still" style="view-transition-name:stay-${stay.slug}">${picture(stay.photos[0],{priority:true},true)}</div>
    <div class="unit-title shell">${eyebrow(stay.type + ' · ' + capacity(stay))}<h1>${stay.name}</h1><p>${stay.feature}.</p>
      <a class="text-link" href="/stays/">All stays</a></div></section>
    <div class="booking-bar"><div class="shell"><span>${stay.name}</span><small aria-label="Rated ${stay.rating} out of five">${stay.rating.toFixed(2)} ★</small>
      <a class="button dark" href="#availability">${booking.label}</a></div></div>
    <div class="shell unit-body"><div><section class="unit-section">${eyebrow('The experience')}<h2>Inside the stay.</h2><p class="lede">${stay.description}</p></section>
    <section class="unit-section"><h2>Amenities</h2><ul class="amenities">${amenities(stay).map(item => `<li>${star}${h(item)}</li>`).join('')}</ul></section>
    <section class="unit-section"><h2>House rules</h2><p>Plan for up to ${stay.guests} overnight guests when booking. ${stay.petsAllowed ? 'Airbnb lists pets as welcome here.' : 'Airbnb lists this stay as pet-free.'} Service animals are welcome.</p>
      <a class="text-link" href="${booking.url}">Read the Airbnb house rules</a></section>
    <section class="unit-section"><h2>Guest reviews</h2><p class="review"><span>${stay.rating.toFixed(2)}</span> / 5 · ${stay.reviews} Airbnb reviews</p>
    <p>${stay.favorite ? 'An Airbnb Guest Favorite. ' : ''}Ratings from ${reviewSnapshot.date}. <a href="${booking.url}">Read reviews on Airbnb</a>.</p></section></div>
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
  return `${pageIntro('Stay extras','Arrive a little <em>earlier.</em>','Make room for a glass of wine and a few extra hours in the Hill Country.')}
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
