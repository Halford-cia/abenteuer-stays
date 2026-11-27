export const instagram = 'https://www.instagram.com/stayeden_fredericksburgtx/';

export const paymentSafety = 'Payment for extras is requested through Airbnb. We never ask for payment by wire, Zelle, gift card or any link outside Airbnb.';
export const reviewSnapshot = { date: 'November 2026', hostRating: '4.85', hostReviews: '2,437' };

export function faqFor(stays) {
  const names = group => new Intl.ListFormat('en-US').format(group.map(stay => stay.name));
  const pets = stays.filter(stay => stay.petsAllowed);
  const noPets = stays.filter(stay => !stay.petsAllowed);
  const tavern = stays.find(stay => stay.slug === 'the-hidden-tavern');
  return [
    ['Where is Stay Eden?', 'The stays are in the Texas Hill Country near Fredericksburg, wineries and Luckenbach. Allow roughly 15–20 minutes to downtown from the glamping property. The drive varies by home. Check the map on your chosen listing.'],
    ['How private are the stays?', 'On the glamping property, the units sit about 150 to 300 feet apart. Each has its own space. The cottages and larger homes have individual listings with more detail about their grounds.'],
    ['Which stays have a cowboy pool?', 'Treehouse Serenity Dome, Lunar Dome, Cherry Cove and Cozy Tiny Home each have a cowboy pool. All ten stays have a private hot tub. The Hidden Tavern has two.'],
    ['Can we bring an animal?', `Airbnb lists pets as welcome at ${names(pets)}. Its house rules list no pets at ${names(noPets)}. Service animals are welcome at all ten stays.`],
    ['What should families know about decks and water?', 'Pecan Haven’s tent sits about ten feet above the ground, and several stays have stairs and raised decks. All ten have hot tubs. Review the Safety & property details on your chosen Airbnb listing when planning a stay with children.'],
    ['How do we book or check a price?', 'Choose a stay and follow its booking link. Enter dates and your guest count to see current availability, the full price and cancellation terms before reserving.'],
    ['Can we arrange wine and early check-in?', `The wine and early check-in bundle is $75. Request it in your Airbnb reservation thread, where your host will confirm availability and the arrival time. ${paymentSafety}`],
    ['Which home works for a group?', `Walnut Horizon sleeps four and Das Grun Haus sleeps six. For The Hidden Tavern, plan for up to ${tavern.guests} overnight guests when booking on Airbnb.`]
  ];
}

export const guide = [
  {place:'Fredericksburg', name:'A walk down Main Street', text:'Begin at the Pioneer Museum on the west end and work your way toward the National Museum of the Pacific War. Leave time between the two for galleries, tasting rooms and a look through the shop windows.', label:'Explore Main Street', url:'https://www.visitfredericksburgtx.com/things-to-do/shopping/main-street/'},
  {place:'Stonewall', name:'An afternoon at the vineyard', text:'Make the estate tasting room at Becker Vineyards your stop for Texas wine. Check the winery’s tasting and cellar-tour options before setting out.', label:'Visit Becker Vineyards', url:'https://www.beckervineyards.com/estate-winery-tasting-room/'},
  {place:'Luckenbach', name:'Listen in at the dance hall', text:'Plan your visit around a pickers circle or a show at the Luckenbach dance hall. The calendar lists who’s playing, when doors open and which shows need a ticket.', label:'See the music calendar', url:'https://www.luckenbachtexas.com/calendar'},
  {place:'Old Tunnel State Park', name:'Dusk at the old railway tunnel', text:'Bring binoculars for the birds. From May through October, bats roost in the old tunnel. Reserve evening viewing with the park and allow for the bats to emerge on their own schedule.', label:'Plan a park visit', url:'https://tpwd.texas.gov/state-parks/old-tunnel'}
];
