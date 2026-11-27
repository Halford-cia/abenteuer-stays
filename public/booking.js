function setupBooking() {
  const form = document.querySelector('.booking-form');
  const {check_in: arrival, check_out: departure} = form.elements;
  const day = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
  const parse = value => new Date(value + 'T12:00:00');
  function offset(date, days) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days,12); }
  function sync() {
    arrival.min = day(new Date());
    departure.min = day(offset(parse(arrival.value > arrival.min ? arrival.value : arrival.min),1));
    if (departure.value && departure.value < departure.min) departure.value = '';
    const nights = (Date.parse(departure.value) - Date.parse(arrival.value)) / 86400000;
    form.querySelector('[data-nights]').textContent = nights > 0 ? `${nights} ${nights === 1 ? 'night' : 'nights'}` : '';
  }
  form.addEventListener('input', sync);
  window.addEventListener('pageshow', sync);
  sync();

  const copy = document.querySelector('[data-copy]');
  if (navigator.clipboard?.writeText) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      const request = document.querySelector('[data-request]').textContent;
      const status = document.querySelector('[data-copy-status]');
      try { await navigator.clipboard.writeText(request); status.textContent = 'Request copied.'; }
      catch { status.textContent = 'Select and copy the request above.'; }
    });
  }

  const dialog = document.querySelector('.calendar');
  if (!dialog.showModal) return;
  const open = document.querySelector('[data-calendar-open]');
  const months = dialog.querySelector('[data-months]');
  const prompt = dialog.querySelector('[data-calendar-prompt]');
  const desktop = matchMedia('(min-width: 760px)');
  const label = date => date.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  let firstMonth, start, focused;
  function monthOf(date, advance = 0) { return new Date(date.getFullYear(),date.getMonth()+advance,1,12); }
  function render() {
    const n = desktop.matches ? 2 : 1;
    const today = day(new Date());
    const earliest = start ? day(offset(parse(start),1)) : today;
    const firstDay = day(firstMonth);
    if (focused < earliest || focused < firstDay || focused >= day(monthOf(firstMonth,n))) focused = earliest > firstDay ? earliest : firstDay;
    dialog.querySelector('[data-month="-1"]').disabled = firstMonth <= monthOf(parse(earliest));
    months.replaceChildren();
    for (let i = 0; i < n; i++) {
      const date = monthOf(firstMonth,i);
      const name = date.toLocaleDateString('en-US',{month:'long',year:'numeric'});
      const section = document.createElement('section');
      section.setAttribute('aria-label',name);
      const heading = document.createElement('h3');
      heading.textContent = name;
      section.append(heading);
      const grid = document.createElement('div');
      grid.className = 'days';
      for (const weekday of ['Su','Mo','Tu','We','Th','Fr','Sa']) {
        const span = document.createElement('span');
        span.textContent = weekday;
        span.setAttribute('aria-hidden','true');
        grid.append(span);
      }
      const length = offset(monthOf(date,1),-1).getDate();
      for (let d = 1; d <= length; d++) {
        const current = offset(date,d-1);
        const value = day(current);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.day = value;
        button.textContent = d;
        button.disabled = value < earliest;
        button.tabIndex = value === focused ? 0 : -1;
        button.setAttribute('aria-label',label(current));
        if (value === today) button.setAttribute('aria-current','date');
        if (value === start || (!start && [arrival.value,departure.value].includes(value))) button.className = 'chosen';
        if (d === 1) button.style.gridColumnStart = date.getDay()+1;
        grid.append(button);
      }
      section.append(grid);
      months.append(section);
    }
    prompt.textContent = start ? `Check-in ${label(parse(start))}. Choose check-out.` : 'Choose check-in.';
  }
  function focusDay() { months.querySelector('[tabindex="0"]')?.focus({preventScroll:true}); }
  function showDate(value) {
    focused = value;
    if (value < day(firstMonth) || value >= day(monthOf(firstMonth,desktop.matches ? 2 : 1))) firstMonth = monthOf(parse(value));
    render();
    focusDay();
  }
  open.hidden = false;
  open.addEventListener('click', () => {
    sync();
    start = '';
    focused = arrival.value >= arrival.min ? arrival.value : arrival.min;
    firstMonth = monthOf(parse(focused));
    render();
    dialog.showModal();
    focusDay();
  });
  dialog.querySelector('[data-calendar-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.month) {
      firstMonth = monthOf(firstMonth,Number(button.dataset.month));
      focused = day(firstMonth);
      render();
      focusDay();
    } else if (button.dataset.day) {
      if (start) {
        arrival.value = start;
        departure.value = button.dataset.day;
        sync();
        dialog.close();
      } else {
        start = button.dataset.day;
        showDate(day(offset(parse(start),1)));
      }
    }
  });
  months.addEventListener('keydown', event => {
    const steps = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
    if (!Object.hasOwn(steps,event.key) || !event.target.dataset.day) return;
    event.preventDefault();
    const value = day(offset(parse(event.target.dataset.day),steps[event.key]));
    const earliest = start ? day(offset(parse(start),1)) : day(new Date());
    showDate(value < earliest ? earliest : value);
  });
  desktop.addEventListener('change', () => { if (dialog.open) { render(); focusDay(); } });
}

setupBooking();
