import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { faqFor, paymentSafety } from '../data/editorial.js';
import { bookingFor } from '../src/booking.js';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const faq = faqFor(stays);
const photos = JSON.parse(read('data/photos.json'));
const sources = JSON.parse(read('data/photo-sources.json'));
const xml = read('dist/sitemap.xml');
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]));
const htmlFor = route => read(join('dist', route, 'index.html'));
const schemaFor = html => JSON.parse(html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);

test('sitemap, routes, canonicals, local links and image metadata agree', () => {
  const routes = new Set(urls.map(url => url.pathname));
  assert.equal(routes.size, 17);
  const titles = new Set();
  const descriptions = new Set();
  for (const url of urls) {
    const html = htmlFor(url.pathname);
    assert.ok(html.includes('<link rel="canonical" href="' + url.href + '">'));
    assert.ok(html.includes('<meta property="og:url" content="' + url.href + '">'));
    assert.match(html, /<html lang="en">/);
    titles.add(html.match(/<title>(.*?)<\/title>/)[1]);
    descriptions.add(html.match(/name="description" content="([^"]+)"/)[1]);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    schemaFor(html);
    const ogImage = new URL(html.match(/property="og:image" content="([^"]+)"/)[1]);
    assert.ok(existsSync(new URL('dist' + ogImage.pathname, root)));
    for (const [,path] of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const target = new URL('dist' + path, root);
      assert.ok(existsSync(target), url.pathname + ' links to ' + path);
      if (statSync(target).isDirectory()) assert.ok(routes.has(path));
    }
    for (const [,srcset] of html.matchAll(/srcset="([^"]+)"/g)) {
      for (const img of srcset.split(', ')) assert.ok(existsSync(new URL('dist' + img.split(' ')[0], root)));
    }
    for (const [tag] of html.matchAll(/<img src=[^>]+>/gs)) {
      assert.match(tag, /width="\d+"/);
      assert.match(tag, /height="\d+"/);
      assert.match(tag, /alt="[^"]+"/);
    }
  }
  assert.equal(titles.size, routes.size);
  assert.equal(descriptions.size, routes.size);
  assert.ok(read('dist/robots.txt').includes(urls[0].origin + '/sitemap.xml'));
});

test('each listing has its own photos, booking link, occupancy, amenities and review summary', () => {
  assert.equal(new Set(stays.map(s => s.id)).size, 10);
  for (const stay of stays) {
    const html = htmlFor('/stays/' + stay.slug + '/');
    const schema = schemaFor(html);
    const booking = bookingFor(stay);
    assert.equal(booking.url, sources[stay.id].listing);
    assert.ok(html.includes('action="' + booking.url + '" method="get"'));
    assert.ok(html.includes('href="' + booking.url + '">Browse without dates'));
    assert.ok(html.includes('type="submit">' + booking.label));
    assert.equal(schema.petsAllowed, stay.petsAllowed);
    assert.ok(html.includes(stay.petsAllowed ? 'Airbnb lists pets as welcome here.' : 'Airbnb lists this stay as pet-free.'));
    assert.match(html, new RegExp(stay.reviews + ' Airbnb reviews'));
    assert.equal(schema['@type'], 'VacationRental');
    assert.equal(schema.containsPlace.occupancy.value, stay.guests);
    assert.equal(schema.containsPlace.amenityFeature.some(a => a.name === 'Cowboy pool'), stay.cowboyPool);
    assert.ok(photos[stay.id].length >= 3);
    for (const img of photos[stay.id]) {
      assert.ok(html.includes(img.src));
      assert.ok(sources[stay.id].photos[img.src].includes('Hosting-' + stay.id + '/'));
    }
  }
});

test('FAQ markup matches the questions and answers visible to guests', () => {
  const html = htmlFor('/faq/');
  const schema = schemaFor(html);
  assert.equal(schema['@type'], 'FAQPage');
  assert.deepEqual(schema.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), faq);
  assert.equal((html.match(/<details><summary>/g) || []).length, faq.length);
  assert.equal(schemaFor(htmlFor('/'))['@type'], 'LodgingBusiness');
});

test('guest rules, extras payment and error-page routing stay consistent', () => {
  const petAnswer = faq.find(([question]) => question.includes('animal'))[1];
  for (const stay of stays) assert.ok(petAnswer.includes(stay.name));
  for (const path of ['/extras/', '/contact/', '/faq/']) assert.ok(htmlFor(path).includes(paymentSafety));
  const tavern = htmlFor('/stays/the-hidden-tavern/');
  assert.doesNotMatch(tavern + htmlFor('/faq/') + htmlFor('/stays/'), /16\+|16 or more|"minValue":16/);
  assert.match(read('dist/404.html'), /404 · Page not found/);
  assert.ok(!xml.includes('/404'));
});

test('interior headings keep space between the eyebrow, title and lede', () => {
  assert.match(read('public/style.css'), /\.page-intro h1\s*\{\s*margin:\s*1rem 0 1\.5rem;/);
  for (const route of ['/stays/','/experiences/','/extras/','/about/','/contact/','/faq/']) {
    assert.match(htmlFor(route), /class="page-intro shell">[\s\S]*?<h1>[\s\S]*?<\/h1><p class="lede">/);
  }
});

test('the home index, shared frames and photographic treatments cover every stay', () => {
  const home = htmlFor('/');
  const index = home.match(/<ul class="stay-index">([\s\S]*?)<\/ul>/)[1];
  for (const stay of stays) {
    const hero = photos[stay.id][0];
    assert.ok(index.includes('href="/stays/' + stay.slug + '/"'));
    for (const html of [index, htmlFor('/stays/'), htmlFor('/stays/' + stay.slug + '/')]) {
      assert.ok(html.includes('view-transition-name:stay-' + stay.slug + '"'));
    }
    const unit = htmlFor('/stays/' + stay.slug + '/');
    const sourceWidth = Number(hero.wide.match(/(\d+)w$/)[1]);
    assert.equal(unit.includes('class="unit-hero framed"'), sourceWidth <= 1024);
  }
  assert.match(home, /<span class="sr-only">Dusk in the Hill Country\.<\/span>/);
  const poster = photos[stays[0].id][0];
  for (const srcset of [poster.wide,poster.portrait]) assert.ok(home.includes('imagesrcset="' + srcset + '"'));
});

test('only explicit production origins are indexable, and the error page has no canonical', () => {
  const indexable = process.env.CONTEXT === 'production' && Boolean(process.env.SITE_URL);
  assert.equal(read('dist/_headers'), (indexable ? '/404.html' : '/*') + '\n  X-Robots-Tag: noindex, follow\n');
  for (const url of urls) assert.equal(htmlFor(url.pathname).includes('content="noindex, follow"'), !indexable);
  const missing = read('dist/404.html');
  assert.match(missing, /content="noindex, follow"/);
  assert.doesNotMatch(missing, /rel="canonical"/);
});
