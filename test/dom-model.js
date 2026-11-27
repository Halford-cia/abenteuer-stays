// A small DOM model for driving public/booking.js and public/live-booking.js against the booking
// panel of a BUILT page (dist/). It parses the panel's real markup and implements only what those
// two scripts use: simple selectors, events with bubbling, focus, dialogs and native GET form
// submission. It is not a browser (Chrome cannot start in the agent sandbox); layout, CSS and
// timing differences are out of its reach.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'source', 'hr']);

class Text {
  constructor(text) { this.nodeType = 3; this.data = text; this.parentNode = null; }
  get textContent() { return this.data; }
}

export class Event {
  constructor(type, init = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); this.defaultPrevented = false; Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
}

function parseSelector(selector) {
  const match = /^([a-z]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector.trim());
  if (!match) throw new Error('dom model: unsupported selector ' + selector);
  const [, tag, classes, attr, value] = match;
  return el => (!tag || el.tagName === tag)
    && classes.split('.').filter(Boolean).every(c => el.classList.contains(c))
    && (!attr || (el.hasAttribute(attr) && (value === undefined || el.getAttribute(attr) === value)));
}

export class Element {
  constructor(tagName, doc) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    this._value = undefined;
    this.open = false;
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, key) => el.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())) ?? undefined,
      set: (_, key, v) => { el.setAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v); return true; }
    });
    this.classList = {
      contains: c => (el.getAttribute('class') || '').split(/\s+/).includes(c),
      add: c => { if (!el.classList.contains(c)) el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + c).trim()); },
      remove: c => el.setAttribute('class', (el.getAttribute('class') || '').split(/\s+/).filter(x => x && x !== c).join(' '))
    };
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get type() { return this.getAttribute('type') || (this.tagName === 'button' ? 'submit' : 'text'); }
  set type(v) { this.setAttribute('type', v); }
  get name() { return this.getAttribute('name') || ''; }
  get action() { return this.getAttribute('action') || ''; }
  get method() { return (this.getAttribute('method') || 'get').toLowerCase(); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get value() {
    if (this.tagName === 'select') {
      const options = this.descendants().filter(n => n.tagName === 'option');
      const chosen = options.find(o => o._selected) || options.find(o => o.hasAttribute('selected')) || options[0];
      return chosen ? chosen.getAttribute('value') ?? chosen.textContent : '';
    }
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(v) {
    if (this.tagName === 'select') { for (const o of this.descendants().filter(n => n.tagName === 'option')) o._selected = o.getAttribute('value') === String(v); return; }
    this._value = String(v);
  }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v !== undefined && v !== null) this.append(new Text(String(v))); }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? new Text(n) : n; node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this.append(...nodes); }
  after(node) {
    const parent = this.parentNode;
    node.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node);
  }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(selector) { const test = parseSelector(selector); return this.descendants().filter(test); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(selector) { const test = parseSelector(selector); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (test(n)) return n; return null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (let n = this; n; n = event.bubbles ? n.parentNode : null) for (const fn of n.listeners?.[event.type] || []) fn.call(n, event);
    return !event.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  // A real browser fires no click on a disabled button.
  click() { if (!this.disabled) this.dispatchEvent(new Event('click', {bubbles: true})); }
  get elements() {
    const fields = this.descendants().filter(n => ['input', 'select'].includes(n.tagName) && n.name);
    return Object.fromEntries(fields.map(f => [f.name, f]));
  }
  // Native GET submission: fires submit, then (unless prevented) navigates to action?fields.
  requestSubmit() {
    if (!this.dispatchEvent(new Event('submit', {bubbles: true}))) return null;
    const query = new URLSearchParams();
    for (const field of this.descendants()) {
      if (!['input', 'select'].includes(field.tagName) || !field.name || field.disabled) continue;
      query.append(field.name, field.value);
    }
    const url = this.method === 'get' ? this.action + '?' + query : this.action;
    this.ownerDocument.navigations.push(url);
    return url;
  }
}

function decode(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function parse(html, doc) {
  const root = new Element('#root', doc);
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  for (const m of html.matchAll(token)) {
    const [, close, open, attrs, text] = m;
    const top = stack.at(-1);
    if (text !== undefined) { if (text) top.append(new Text(decode(text))); continue; }
    if (close) { while (stack.length > 1 && stack.pop().tagName !== close.toLowerCase()); continue; }
    if (!open) continue;
    const el = new Element(open.toLowerCase(), doc);
    for (const a of (attrs || '').matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] === undefined ? '' : decode(a[2]));
    top.append(el);
    if (!VOID.has(el.tagName)) stack.push(el);
  }
  return root;
}

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Loads dist/stays/<slug>/index.html's booking panel and runs booking.js, then live-booking.js when
// the built page includes it, exactly in the page's order.
export function builtPage(slug, {fetch, html} = {}) {
  const source = html ?? read(`dist/stays/${slug}/index.html`);
  const start = source.indexOf('<aside class="booking-panel"');
  const end = source.indexOf('</aside>', start) + '</aside>'.length;
  if (start < 0) throw new Error('no booking panel in ' + slug);
  const doc = {activeElement: null, navigations: []};
  const root = parse(source.slice(start, end), doc);
  const windowListeners = {};
  let idle = null;
  const requested = [];
  Object.assign(doc, {
    querySelector: s => root.querySelector(s),
    querySelectorAll: s => root.querySelectorAll(s),
    createElement: tag => new Element(tag, doc)
  });
  const ctx = {
    document: doc, Event, URLSearchParams, Intl, AbortController, setTimeout, clearTimeout, Promise, Date,
    navigator: {},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    requestIdleCallback: fn => { idle = fn; },
    fetch: (url, init) => { requested.push(String(url)); return fetch ? fetch(String(url), init) : Promise.reject(new TypeError('offline')); },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    dispatchEvent: event => { for (const fn of windowListeners[event.type] || []) fn(event); return true; }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const scripts = [...source.matchAll(/<script src="\/([\w-]+\.js)" defer><\/script>/g)].map(m => m[1]).filter(f => f !== 'site.js');
  for (const file of scripts) vm.runInContext(read('public/' + file), ctx, {filename: file});
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const form = root.querySelector('.booking-form');
  return {
    ctx, doc, root, form, requested, scripts, settle,
    box: () => root.querySelector('.live-quote'),
    dialog: () => root.querySelector('.calendar'),
    day: value => root.querySelector(`[data-day="${value}"]`),
    // Run the idle callback that loads the calendar (live pages only).
    idle: () => { const fn = idle; idle = null; if (fn) fn(); return Boolean(fn); },
    choose: async (checkIn, checkOut, adults) => {
      form.elements.check_in.value = checkIn;
      form.elements.check_out.value = checkOut;
      if (adults) form.elements.adults.value = adults;
      form.dispatchEvent(new Event('input', {bubbles: true}));
      form.dispatchEvent(new Event('change', {bubbles: true}));
      await settle();
    }
  };
}

// The local date n days from today, as booking.js computes it.
export function localDay(n) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
