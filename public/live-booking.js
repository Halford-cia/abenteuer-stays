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
  const dayLabel = value => new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'});

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

  const pair = (term, value, cls) => {
    const row = document.createElement('div');
    if (cls) row.className = cls;
    row.append(Object.assign(document.createElement('dt'), {textContent: term}),
      Object.assign(document.createElement('dd'), {textContent: value}));
    return row;
  };

  function renderQuote(quote) {
    const format = new Intl.NumberFormat('en-US', {style: 'currency', currency: quote.currency});
    const nodes = [];
    if (quote.ratePlan) nodes.push(line('live-note', 'Rate: ' + quote.ratePlan));
    // Guesty's dated nightly prices for the chosen plan, when it sends them. They are part of the
    // lines below, not added to the total.
    const nightly = Array.isArray(quote.nightly) ? quote.nightly : [];
    if (nightly.length) {
      const nights = document.createElement('dl');
      nights.className = 'live-nights';
      nights.setAttribute('aria-label', 'Nightly rates');
      for (const night of nightly) nights.append(pair(dayLabel(night.date), format.format(night.amount)));
      nodes.push(nights);
    }
    const list = document.createElement('dl');
    for (const item of quote.lines) {
      // Taxes Guesty reports as already inside a line are named beside it, never added again.
      const included = Array.isArray(item.included) && item.included.length ? ` (includes ${item.included.join(', ')})` : '';
      list.append(pair(item.title + included, format.format(item.amount)));
    }
    list.append(pair(`Total for ${quote.nights} ${quote.nights === 1 ? 'night' : 'nights'}`, format.format(quote.total), 'live-total'));
    nodes.push(list, line('live-note', 'Live rate for your dates. You finish booking on Airbnb, where the final total can differ.'));
    show(nodes);
  }

  // A shown price lasts only as long as Guesty holds it: the function says for how many seconds
  // after this reply arrived (validFor). The expiry timer counts that time, and when it fires the
  // price goes, whatever the device's wall clock says (a clock correction cannot keep it). When the
  // guest comes back to the page, a price is taken down and asked for again if it has expired, if
  // its remaining life cannot be told (the clock reads before its receipt), or if the stay on the
  // form is no longer the one it was quoted for (booking.js moves the dates on after midnight).
  // If asking again fails, no price is shown and the Airbnb form is untouched.
  let days = null;
  let sequence = 0;
  let wanted = null;      // the stay a quote was asked for or is shown for: {key}
  let shown = null;       // the price on screen: {received, until}
  let expiryTimer = null;
  const localToday = () => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  };
  // The stay on the form now, or '' when it is not one that can be quoted.
  function stayKey() {
    const checkIn = arrival.value;
    const checkOut = departure.value;
    if (!checkIn || !checkOut || checkOut <= checkIn || checkIn < localToday()) return '';
    return [checkIn, checkOut, adults.value].join('|');
  }
  function clearShown() {
    shown = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  function expire() {
    clearShown();
    update();
  }

  function update() {
    const request = ++sequence;
    clearShown();
    wanted = null;
    const checkIn = arrival.value;
    const checkOut = departure.value;
    const key = stayKey();
    if (!days || !key) return show([]);
    const verdict = check(days, checkIn, checkOut);
    if (!verdict.ok) {
      const message = messages[verdict.reason];
      return show([line('live-status', typeof message === 'function' ? message(verdict.minNights) : message)]);
    }
    show([line('live-status', 'Checking the rate…')]);
    wanted = {key};
    const guests = adults.value;
    const query = new URLSearchParams({checkIn, checkOut, guests});
    getJSON(`${base}/quote?${query}`, 9000).then(quote => {
      if (request !== sequence) return;
      const received = Date.now();
      // Only a price for exactly this stay and party, still within Guesty's hold, and still the
      // stay on the form, is shown.
      const matches = quote && quote.checkIn === checkIn && quote.checkOut === checkOut
        && quote.guests === Number(guests) && quote.nights === nightsBetween(checkIn, checkOut)
        && Number.isFinite(quote.validFor) && quote.validFor > 0 && stayKey() === key;
      if (!matches) { wanted = null; return show([]); }
      renderQuote(quote);
      shown = {received, until: received + quote.validFor * 1000};
      expiryTimer = setTimeout(expire, Math.min(quote.validFor * 1000, 2 ** 31 - 1));
    });
  }

  // Availability ages too: the function's CDN keeps it about ten minutes, and a guest can come
  // back to an open tab days later. Older than CALENDAR_MAX_AGE (or of unknown age, after a clock
  // correction), it is asked for again on return and when the picker opens. If that fails, the
  // old restrictions are dropped (no stale "taken" night stays) and the Airbnb form is untouched.
  // A failed request (the first one, or a refresh) is tried again on the first return or picker
  // opening at least CALENDAR_RETRY after it, so a short outage does not end live dates for the tab.
  const CALENDAR_MAX_AGE = 15 * 60e3;
  const CALENDAR_RETRY = 60e3;
  let loadedAt = null;    // when the availability on the page arrived
  let failedAt = null;    // when the last request failed, while no newer one has succeeded
  let loading = null;
  function setDays(list) {
    days = list ? rules.index(list) : null;
    window.stayLive = days ? {
      dayState: (value, start) => dayState(days, value, start),
      minNights: start => (days.get(start) || {}).minNights || 1
    } : undefined;
    window.dispatchEvent(new Event('staylive'));
    update();
  }
  function load() {
    if (loading) return loading;
    loading = getJSON(base + '/calendar', 8000).then(calendar => {
      loading = null;
      if (calendar && Array.isArray(calendar.days)) {
        loadedAt = Date.now();
        failedAt = null;
        setDays(calendar.days);
      } else {
        loadedAt = null;
        failedAt = Date.now();
        if (days) setDays(null);
      }
    });
    return loading;
  }
  // Due for a new request: availability past its age, or a failure past the retry pause. Before
  // the first request has finished, nothing is due (the idle load is on its way).
  const calendarAged = () => {
    const since = failedAt !== null ? failedAt : loadedAt;
    if (since === null) return false;
    const age = Date.now() - since;
    return age < 0 || age >= (failedAt !== null ? CALENDAR_RETRY : CALENDAR_MAX_AGE);
  };

  // Back from another page (bfcache), another tab or a sleeping device: timers may not have run.
  function revalidate() {
    const now = Date.now();
    const priceStale = shown && (now >= shown.until || now < shown.received);
    const stayChanged = wanted && stayKey() !== wanted.key;
    if (priceStale || stayChanged) {
      clearShown();
      wanted = null;
      sequence++;                          // a reply still on its way is not shown
      show([]);
    }
    if (calendarAged()) return load();     // update() runs when it arrives
    if (priceStale || stayChanged) update();
  }

  form.addEventListener('change', update);
  window.addEventListener('pageshow', revalidate);
  window.addEventListener('focus', revalidate);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') revalidate(); });
  const opener = panel.querySelector('[data-calendar-open]');
  if (opener) opener.addEventListener('click', () => { if (calendarAged()) load(); });
  if ('requestIdleCallback' in window) requestIdleCallback(load, {timeout: 3000});
  else setTimeout(load, 1500);
})();
