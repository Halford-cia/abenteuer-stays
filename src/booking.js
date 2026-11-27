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
    <form action="${url}" method="get" class="booking-form">
      <div class="date-fields"><label>Check-in<input type="date" name="check_in" required></label>
      <label>Check-out<input type="date" name="check_out" required></label></div>
      <label>Adults<select name="adults">${options}</select></label>
      <button class="button dark" type="submit">${label}</button>
    </form><p class="booking-note">${provider} · <a href="${url}">Browse without dates</a></p>
    <div class="bundle-note"><h3>Wine &amp; early check-in</h3><p>Settle in early with a bottle of wine. $75 per bundle, subject to availability.</p>
      <a class="text-link" href="/extras/">See the arrival bundle</a></div></aside>`;
}
