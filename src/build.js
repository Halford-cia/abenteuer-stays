import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { about, collection, contact, experiences, extras, faqs, home, unit } from './pages.js';
import { amenities, escapeHtml as h, footer, header, json, stayPath } from './components.js';
import { bookingFor } from './booking.js';
import { faq, instagram } from '../data/editorial.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const load = async name => JSON.parse(await readFile(join(root, 'data', name), 'utf8'));
const photos = await load('photos.json');
const stays = (await load('stays.json')).map(stay => ({ ...stay, photos: photos[stay.id] }));
const production = process.env.CONTEXT === 'production';
const host = production ? process.env.SITE_URL || process.env.URL
  : process.env.DEPLOY_PRIME_URL || process.env.URL;
const origin = new URL(host || 'http://127.0.0.1:4173').origin;
if (!/^https?:\/\//.test(origin) || (production && !origin.startsWith('https://'))) {
  throw new Error('A production build requires an HTTPS SITE_URL or Netlify URL.');
}
const absolute = path => new URL(path, origin).href;
const primary = absolute('/#stay-eden');
const address = {'@type': 'PostalAddress', addressLocality: 'Fredericksburg', addressRegion: 'TX', addressCountry: 'US'};
const business = {'@type':'LodgingBusiness', '@id':primary, name:'Stay Eden', url:absolute('/'), address,
  image:absolute(stays[1].photos[0].src), sameAs:[instagram], parentOrganization:{'@type':'Organization',name:'Abenteuer Management',legalName:'Alford & Pruitt Investments LLC'}};

function rental(stay) {
  return {
    '@type':'VacationRental', '@id':absolute(stayPath(stay) + '#rental'),
    identifier:stay.id, name:stay.name, description:stay.description, url:absolute(stayPath(stay)),
    image:stay.photos.map(image => absolute(image.src)), address, sameAs:[bookingFor(stay).url],
    parentOrganization:{'@id':primary},
    containsPlace:{'@type':'Accommodation', occupancy:{'@type':'QuantitativeValue', value:stay.guests},
      amenityFeature:amenities(stay).map(name => ({'@type':'LocationFeatureSpecification',name,value:true}))}
  };
}

const pages = [
  {path:'/',title:'Stay Eden | Private Hill Country Stays in Fredericksburg, Texas',
    description:'Explore ten private Hill Country stays near Fredericksburg, Texas. Find treetop domes, canvas retreats, tiny homes and country houses with private hot tubs.',
    render:() => home(stays), schema:business},
  {path:'/stays/',title:'The Stays | Fredericksburg Domes, Tents & Homes | Stay Eden',
    description:'Compare all ten Stay Eden rentals by guest capacity, private hot tub and cowboy pool. See photos, amenities and Airbnb booking details for each stay.',
    render:() => collection(stays)},
  {path:'/experiences/',title:'Fredericksburg & Luckenbach Field Guide | Stay Eden',
    description:'Plan a Hill Country day around Main Street, Becker Vineyards, the Luckenbach dance hall and Old Tunnel State Park, with links to each destination.',
    render:experiences,image:stays[0].photos[4]},
  {path:'/extras/',title:'Wine & Early Check-in Bundle | Stay Eden',
    description:'Ease into your Hill Country stay with the $75 wine and early check-in bundle. Learn how to request it and confirm availability with your host.',
    render:() => extras(stays),image:stays[1].photos[4]},
  {path:'/about/',title:'About the Properties & Hosts | Stay Eden',
    description:'Meet Victoria and Henry and discover Stay Eden’s collection of private domes, tents and country houses near Fredericksburg, operated by Abenteuer Management.',
    render:() => about(stays),image:stays[5].photos[0]},
  {path:'/contact/',title:'Contact Your Hosts in Fredericksburg | Stay Eden',
    description:'Reach Victoria and Henry about a Stay Eden reservation, a particular rental or an arrival request. Find the host contact for each of the ten stays.',
    render:() => contact(stays)},
  {path:'/faq/',title:'Guest FAQ | Planning Your Visit to Stay Eden',
    description:'Find answers about privacy, cowboy pools, service animals, group sizes, booking and early check-in at Stay Eden near Fredericksburg.',
    render:faqs,schema:{'@type':'FAQPage',mainEntity:faq.map(([name,text]) =>
      ({'@type':'Question',name,acceptedAnswer:{'@type':'Answer',text}}))}},
  ...stays.map(stay => ({path:stayPath(stay), title:stay.name + ' | Fredericksburg, TX | Stay Eden',
    description:`${stay.name} is a ${stay.type.toLowerCase()} for ${stay.guests}${stay.plus ? '+' : ''} near Fredericksburg. ${stay.feature}. Explore photos, amenities and guest ratings.`,
    image:stay.photos[0],render:() => unit(stay),schema:rental(stay)}))
];

function document(page) {
  const image = page.image || stays[1].photos[0];
  const pageUrl = absolute(page.path);
  const schema = page.schema || {'@type':'WebPage', name:page.title, url:pageUrl, about:{'@id':primary}};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(page.title)}</title><meta name="description" content="${h(page.description)}">
<link rel="canonical" href="${h(pageUrl)}">${production ? '' : '<meta name="robots" content="noindex, follow">'}
<meta property="og:type" content="website"><meta property="og:site_name" content="Stay Eden">
<meta property="og:title" content="${h(page.title)}"><meta property="og:description" content="${h(page.description)}">
<meta property="og:url" content="${h(pageUrl)}"><meta property="og:image" content="${h(absolute(image.src))}">
<meta property="og:image:alt" content="${h(image.alt)}"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#17261e"><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preload" href="/fonts/instrument-serif.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/instrument-serif-italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css"><script src="/site.js" defer></script>
<script type="application/ld+json">${json({'@context':'https://schema.org', ...schema})}</script>
</head><body>${header(page.path, page.path === '/')}<main id="main" tabindex="-1">${page.render()}</main>${footer(page.path)}</body></html>\n`;
}

await rm(output, {recursive:true,force:true});
await mkdir(output,{recursive:true});
await cp(join(root,'public'),output,{recursive:true});
for (const page of pages) {
  const dir = join(output,page.path);
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'index.html'), document(page));
}
await writeFile(join(output,'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(page =>
  '  <url><loc>' + h(absolute(page.path)) + '</loc></url>').join('\n')}\n</urlset>\n`);
await writeFile(join(output,'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: ' + absolute('/sitemap.xml') + '\n');
console.log(`Built ${pages.length} pages for ${origin} (${production ? 'production' : 'noindex'}).`);
