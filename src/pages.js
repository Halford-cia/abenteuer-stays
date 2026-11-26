import { bookingFor, bookingPanel } from './booking.js';
import { capacity, amenities, arrow, eyebrow, escapeHtml as h, json, pageIntro, photo, splitFeature, star, stayCard, stayPath } from './components.js';
import { faq, guide, instagram } from '../data/editorial.js';

export function home(stays) {
  const bySlug = slug => stays.find(stay => stay.slug === slug);
  const featured = ['lunar-dome', 'cherry-cove', 'pecan-haven'].map(bySlug);
  const frames = featured.map(stay => ({image:stay.photos[0], name:stay.name, url:stayPath(stay)}));
  const first = frames[0];
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-scene">${photo(first.image,{priority:true, className:'hero-image'})}</div>
    <div class="hero-body shell">
      ${eyebrow('Fredericksburg, Texas')}
      <h1 id="hero-title">Into the<br><em>Hill Country.</em></h1>
      <p>Ten private stays, from treetop domes to canvas hideaways among the oaks.</p>
      <a class="button light" href="/stays/">Explore the stays</a>
    </div>
    <div class="hero-foot shell"><a class="scroll-link" href="#featured"><span class="scroll-line" aria-hidden="true"></span>Scroll to explore</a>
    <div class="frame"><span class="frame-label">In the frame</span><a data-caption href="${first.url}">${first.name}</a>
    <div class="frame-controls" hidden><button type="button" data-frame="-1" aria-label="Previous featured photo">${arrow('back')}</button>
    <span data-counter aria-hidden="true">01 / 03</span><button type="button" data-frame="1" aria-label="Next featured photo">${arrow('next')}</button></div></div>
    <span class="sr-only" role="status" data-frame-status></span></div>
    <script type="application/json" id="frames">${json(frames)}</script></section>
    <section class="section shell" id="featured">${eyebrow('Selected stays')}
      <div class="section-heading"><h2>Sleep somewhere <em>special.</em></h2><a class="text-link" href="/stays/">View all ten stays</a></div>
      <div class="card-grid">${['treehouse-serenity-dome','cherry-cove','das-grun-haus'].map(slug => stayCard(bySlug(slug))).join('')}</div>
    </section>
    ${splitFeature({image:bySlug('treehouse-serenity-dome').photos[4], label:'The field guide', title:'A day <em>in the hills.</em>', text:'Leave the deck for a vineyard tasting, a walk down Main Street or an evening of live music in Luckenbach.',href:'/experiences/',cta:'Open the field guide',dark:true})}`;
}

export function collection(stays) {
  return `${pageIntro('Stay Eden · Fredericksburg','The <em>stays.</em>','Find a place for two beneath the trees or bring the whole group to a Hill Country house.')}
    <section class="shell collection" id="collection" aria-label="Stay collection">
      <form class="filters" hidden><label class="guest-filter">Guests <select name="guests" aria-label="Minimum guest capacity">
      <option value="0">Any group size</option>${Array.from({length:16}, (_,i) => {
        const n = i + 1;
        return `<option value="${n}">${n}${n === 16 ? "+" : ""} ${n === 1 ? "guest" : "guests"}</option>`;
      }).join("")}</select></label>
      <label class="check"><input type="checkbox" name="tub"> Private hot tub</label>
      <label class="check"><input type="checkbox" name="pool"> Cowboy pool</label>
      <button class="reset" type="reset">Clear filters</button></form>
      <h2 class="result-count" aria-live="polite"><span data-count>10 stays</span></h2>
      <div class="card-grid">${stays.map(s => stayCard(s,{filter:true})).join('')}</div>
      <div class="empty" hidden><p>There are no stays with this combination. Try another group size or clear your filters.</p><button class="button dark" data-clear>Show all stays</button></div>
    </section>`;
}

export function unit(stay) {
  const booking = bookingFor(stay);
  return `<div class="shell detail-heading"><a class="text-link back-link" href="/stays/">All stays</a>
    ${eyebrow(stay.type + ' · ' + capacity(stay))}<h1>${stay.name}</h1><div class="detail-subhead"><p class="lede">${stay.feature}.</p><a class="button dark" href="${booking.url}">${booking.label}</a></div></div>
    <div class="shell detail-hero">${photo(stay.photos[0],{priority:true})}</div>
    <div class="shell unit-body"><div><section class="unit-section">${eyebrow('The experience')}<h2>Inside the stay.</h2><p class="lede">${stay.description}</p></section>
    <section class="unit-section"><h2>Amenities</h2><ul class="amenities">${amenities(stay).map(item => `<li>${star}${h(item)}</li>`).join('')}</ul></section>
    <section class="unit-section"><h2>Guest reviews</h2><p class="review"><span>${stay.rating.toFixed(2)}</span> / 5 · ${stay.reviews} Airbnb reviews</p>
    <p>${stay.favorite ? 'An Airbnb Guest Favorite. ' : ''}Ratings from November 2026. <a href="${booking.url}">Read reviews on Airbnb</a>.</p></section></div>
    ${bookingPanel(stay)}</div>
    <section class="shell gallery-section">${eyebrow('Photo gallery')}<h2>A closer look.</h2>
    <div class="gallery">${stay.photos.map((image, i) => `<a href="${image.src}" data-photo="${i}" aria-label="Enlarge photo ${i+1}. ${h(image.alt)}">${photo(image,{sizes:'(min-width: 760px) 30vw, 90vw'})}</a>`).join('')}</div>
    <dialog class="lightbox" aria-labelledby="gallery-name"><div class="lightbox-bar"><h3 id="gallery-name">${stay.name} gallery</h3><button type="button" data-close>Close</button></div>
    <div class="lightbox-content"><img alt="" data-large></div><div class="lightbox-controls"><button type="button" data-step="-1">Previous</button><p data-gallery-status aria-live="polite"></p><button type="button" data-step="1">Next</button></div></dialog>
    </section>`;
}

export function experiences() {
  return `${pageIntro('Fredericksburg & beyond','The field <em>guide.</em>','An afternoon among the vines, a little live music or a quiet hour on a trail. Four places to build a Hill Country day around.')}
    <section class="shell guide-list" aria-label="Destinations">${guide.map(item => `<article class="guide-entry">${eyebrow(item.place)}<div><h2>${item.name}</h2><p>${item.text}</p><a class="text-link" href="${item.url}">${item.label}</a></div></article>`).join('')}</section>`;
}

export function extras(stays) {
  return `${pageIntro('Stay extras','Arrive a little <em>earlier.</em>','Make room for a glass of wine and a few extra hours in the Hill Country.')}
    <section class="shell editorial-split"><div class="editorial-photo">${photo(stays.find(s => s.slug === 'lunar-dome').photos[4],{priority:true,sizes:'(min-width: 800px) 50vw, 100vw'})}</div>
    <div class="editorial-copy">${eyebrow('The arrival bundle')}<h2>Wine &amp;<br><em>early check-in.</em></h2><p class="price">$75 <span>per bundle</span></p>
    <p>Pair wine with an earlier arrival. Once you’ve reserved your stay, ask for the bundle in your Airbnb message thread. Your host will confirm availability, the check-in time and how to pay.</p>
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
    <ul class="contact-list">${stays.map(s => `<li><a href="${bookingFor(s).url}">${s.name}</a></li>`).join('')}</ul></section>
    <aside class="contact-aside"><h2>Already booked?</h2><p>For arrival details or the $75 wine and early check-in bundle, message your host in your existing reservation thread.</p>
    <a class="button dark" href="https://www.airbnb.com/trips">Open Airbnb trips</a><hr><p>Find us on Instagram</p><a class="text-link" href="${instagram}">@stayeden_fredericksburgtx</a></aside></div>`;
}

export function faqs() {
  return `${pageIntro('Planning your stay','A few <em>answers.</em>','Details about the properties, reservations and getting here.')}
    <section class="shell faq-section" aria-label="Frequently asked questions">${faq.map(([question,answer]) => `<details><summary>${h(question)}<span aria-hidden="true"></span></summary><p>${h(answer)}</p></details>`).join('')}
    <p class="more-help">Have a question about a specific stay? <a href="/contact/">Ask the hosts</a>.</p></section>`;
}
