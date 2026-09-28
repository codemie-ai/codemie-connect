// The wireframe's option-card control: a group of cards where exactly one is
// selected, the radio inside each card being the single source of truth for
// what is chosen (and what assistive tech reads) while the card is what the
// user sees and clicks.
//
// Lifted out of ui/setup-view.js so Home's checklist can present a choice in
// the same shape guided setup does — the same markup, the same classes, the
// same "recommended" badge — rather than growing a second look for the same
// job. Pure DOM: no Tauri, no window globals, no knowledge of either screen.

// One selectable card.
export function makeCard({ title, description, recommended, name, value }) {
  const card = document.createElement('div');
  card.className = 'setup-option-card' + (recommended ? ' recommended' : '');

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  card.appendChild(radio);

  // title/description are caller-supplied text that can originate from CLI
  // output -- always rendered via .textContent, never innerHTML.
  const titleEl = document.createElement('div');
  titleEl.className = 'setup-option-title';
  titleEl.textContent = title;
  card.appendChild(titleEl);

  if (description) {
    const descEl = document.createElement('div');
    descEl.className = 'setup-option-description';
    descEl.textContent = description;
    card.appendChild(descEl);
  }

  if (recommended) {
    const badge = document.createElement('span');
    badge.className = 'setup-option-badge';
    badge.textContent = 'Recommended'; // static UI copy, not driver-supplied text.
    card.appendChild(badge);
  }
  return { card, radio };
}

// A group of cards where exactly one is selected; select(i) keeps the radios
// and the visual state in step, and the first card starts selected.
export function makeCardGroup(control, name, items) {
  const radios = [];
  const cardEls = [];
  function select(index) {
    radios.forEach((r, i) => { r.checked = i === index; });
    cardEls.forEach((c, i) => c.classList.toggle('selected', i === index));
  }
  items.forEach((item, index) => {
    const { card, radio } = makeCard({ ...item, name, value: String(index) });
    // Clicking anywhere on the card selects it -- the radio input remains
    // the single source of truth the submit button reads from.
    card.onclick = () => select(index);
    radios.push(radio);
    cardEls.push(card);
    control.appendChild(card);
  });
  if (radios.length) select(0);
  return {
    selectedIndex: () => {
      const chosen = radios.findIndex((r) => r.checked);
      return chosen === -1 ? 0 : chosen;
    },
  };
}
