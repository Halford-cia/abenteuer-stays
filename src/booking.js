// Keep the listing, handoff fields and reservation copy together when changing providers.
export function airbnbListing(stay) {
  return 'https://www.airbnb.com/rooms/' + stay.id;
}

export function bookingFor(stay) {
  return {url: airbnbListing(stay), label: 'Check availability', provider: 'Reservations via Airbnb'};
}

export function bookingPanel(stay) {
  const {url, label, provider} = bookingFor(stay);
  const options = Array.from({length: stay.guests}, (_, i) =>
    `<option value="${i + 1}"${i === 1 ? ' selected' : ''}>${i + 1}</option>`).join('');
  return `<aside class="booking-panel" id="availability" aria-labelledby="booking-title">
    <h2 id="booking-title">Your dates.</h2>
    <button type="button" class="calendar-trigger text-link" data-calendar-open hidden>Choose on calendar</button>
    <form action="${url}" method="get" class="booking-form">
      <div class="date-fields"><label>Check-in<input type="date" name="check_in" required></label>
      <label>Check-out<input type="date" name="check_out" required></label></div>
      <output class="night-count" aria-live="polite" data-nights></output>
      <label>Adults<select name="adults">${options}</select></label>
      <p class="booking-note">Add children and infants on Airbnb.</p>
      <button class="button dark" type="submit">${label}</button>
    </form><p class="booking-note">${provider} · <a href="${url}">Browse without dates</a></p>
    <details class="bundle-request"><summary>Request the $75 arrival bundle</summary>
      <p>After booking, copy this request into your Airbnb reservation thread.</p>
      <p data-request>Could we add the $75 wine and early check-in bundle to our stay?</p>
      <button type="button" class="text-link" data-copy hidden>Copy request</button><span role="status" data-copy-status></span></details>
    <dialog class="calendar" aria-labelledby="calendar-title" aria-describedby="calendar-prompt"><header><h2 id="calendar-title">Choose your dates</h2>
      <button type="button" data-calendar-close>Close</button></header>
      <p id="calendar-prompt" data-calendar-prompt aria-live="polite"></p>
      <div class="month-nav"><button type="button" data-month="-1" aria-label="Previous month">Previous</button>
        <button type="button" data-month="1" aria-label="Next month">Next</button></div>
      <div class="months" data-months></div></dialog></aside>`;
}
