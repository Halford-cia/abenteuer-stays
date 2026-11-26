// The Airbnb listing remains the source for reviews and host messaging.
export function airbnbListing(stay) {
  return 'https://www.airbnb.com/rooms/' + stay.id;
}

// Replace this provider when the host chooses a direct-booking engine.
export function bookingFor(stay) {
  return {
    url: airbnbListing(stay),
    label: 'Book on Airbnb',
    detail: 'Choose dates on Airbnb for availability, pricing and cancellation terms.'
  };
}

export function bookingPanel(stay) {
  const booking = bookingFor(stay);
  return `<aside class="booking-panel" aria-labelledby="booking-title">
    <h2 id="booking-title">Make it your stay.</h2>
    <p>${booking.detail}</p><a class="button dark" href="${booking.url}">${booking.label}</a>
    <a class="text-link" href="/extras/">Wine &amp; early check-in</a></aside>`;
}
