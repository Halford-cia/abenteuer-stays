// Live availability and quotes from Guesty (phase A). Loaded only on stays mapped in
// data/guesty-listings.json. Any failure leaves today's Airbnb handoff exactly as it is: nothing
// here shows an error to guests, and the Book button always submits the Airbnb form.
(() => {
  const addDay = (value, days) => {
    const date = new Date(value + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const nightsBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);

  // Dates outside the calendar Guesty returned carry no restriction here; the quote decides.
  function check(days, checkIn, checkOut) {
    const first = days.get(checkIn);
    if (first && !first.available) return {ok: false, reason: 'unavailable'};
    if (first && first.noArrival) return {ok: false, reason: 'noArrival'};
    for (let night = checkIn; night < checkOut; night = addDay(night, 1)) {
      const entry = days.get(night);
      if (entry && !entry.available) return {ok: false, reason: 'unavailable'};
    }
    const minNights = first ? first.minNights : 1;
    if (nightsBetween(checkIn, checkOut) < minNights) return {ok: false, reason: 'minNights', minNights};
    const last = days.get(checkOut);
    if (last && last.noDeparture) return {ok: false, reason: 'noDeparture'};
    return {ok: true};
  }

  function dayState(days, value, start) {
    if (!start) {
      const entry = days.get(value);
      return {blocked: Boolean(entry && (!entry.available || entry.noArrival))};
    }
    return {blocked: value > start && !check(days, start, value).ok};
  }

  const rules = {check, dayState, index: list => new Map(list.map(entry => [entry.date, entry]))};
  globalThis.stayLiveRules = rules;
  if (typeof document === 'undefined') return;

  const panel = document.querySelector('[data-live]');
  const form = panel && panel.querySelector('.booking-form');
  if (!form) return;
  const base = panel.dataset.live;
  const {check_in: arrival, check_out: departure, adults} = form.elements;

  function getJSON(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, {signal: controller.signal, headers: {accept: 'application/json'}})
      .then(res => (res.ok ? res.json() : null))
      .then(body => (body && body.ok ? body : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  const box = document.createElement('div');
  box.className = 'live-quote';
  box.hidden = true;
  box.setAttribute('aria-live', 'polite');
  form.querySelector('[data-nights]').after(box);

  const messages = {
    unavailable: 'Those nights are already taken. Choose other dates.',
    noArrival: 'Check-in is not offered on that day.',
    noDeparture: 'Check-out is not offered on that day.',
    minNights: n => `This stay has a ${n}-night minimum from that check-in.`
  };

  function show(nodes) {
    box.replaceChildren(...nodes);
    box.hidden = nodes.length === 0;
  }
  const line = (cls, text) => Object.assign(document.createElement('p'), {className: cls, textContent: text});

  function renderQuote(quote) {
    const format = new Intl.NumberFormat('en-US', {style: 'currency', currency: quote.currency});
    const list = document.createElement('dl');
    for (const item of quote.lines) {
      const row = document.createElement('div');
      row.append(Object.assign(document.createElement('dt'), {textContent: item.title}),
        Object.assign(document.createElement('dd'), {textContent: format.format(item.amount)}));
      list.append(row);
    }
    const total = document.createElement('div');
    total.className = 'live-total';
    total.append(Object.assign(document.createElement('dt'), {textContent: `Total for ${quote.nights} ${quote.nights === 1 ? 'night' : 'nights'}`}),
      Object.assign(document.createElement('dd'), {textContent: format.format(quote.total)}));
    list.append(total);
    const nodes = [list];
    if (quote.ratePlan) nodes.unshift(line('live-note', 'Rate: ' + quote.ratePlan));
    nodes.push(line('live-note', 'Live rate for your dates. You finish booking on Airbnb, where the final total can differ.'));
    show(nodes);
  }

  let days = null;
  let sequence = 0;
  function update() {
    const request = ++sequence;
    const checkIn = arrival.value;
    const checkOut = departure.value;
    if (!days || !checkIn || !checkOut || checkOut <= checkIn) return show([]);
    const verdict = check(days, checkIn, checkOut);
    if (!verdict.ok) {
      const message = messages[verdict.reason];
      return show([line('live-status', typeof message === 'function' ? message(verdict.minNights) : message)]);
    }
    show([line('live-status', 'Checking the rate…')]);
    const query = new URLSearchParams({checkIn, checkOut, guests: adults.value});
    getJSON(`${base}/quote?${query}`, 9000).then(quote => {
      if (request !== sequence) return;
      if (quote && quote.checkIn === checkIn && quote.checkOut === checkOut) renderQuote(quote);
      else show([]);
    });
  }

  function load() {
    getJSON(base + '/calendar', 8000).then(calendar => {
      if (!calendar || !Array.isArray(calendar.days)) return;
      days = rules.index(calendar.days);
      window.stayLive = {
        dayState: (value, start) => dayState(days, value, start),
        minNights: start => (days.get(start) || {}).minNights || 1
      };
      window.dispatchEvent(new Event('staylive'));
      update();
    });
  }

  form.addEventListener('change', update);
  if ('requestIdleCallback' in window) requestIdleCallback(load, {timeout: 3000});
  else setTimeout(load, 1500);
})();
