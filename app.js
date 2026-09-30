import { compute, num, hasValue, minorUnits } from './split.js';
import { scanBill } from './ocr.js';

const KEY = 'bill-splitter:v1';
const STEPS = ['People', 'Bill', 'Charges', 'Claim', 'Totals'];
const CURRENCIES = [
  ['PHP', 'Philippine peso'], ['THB', 'Thai baht'], ['USD', 'US dollar'], ['SGD', 'Singapore dollar'],
  ['HKD', 'Hong Kong dollar'], ['MYR', 'Malaysian ringgit'], ['IDR', 'Indonesian rupiah'], ['VND', 'Vietnamese dong'],
  ['JPY', 'Japanese yen'], ['KRW', 'Korean won'], ['EUR', 'Euro'], ['GBP', 'British pound'], ['AUD', 'Australian dollar'],
];
const PRESETS = {
  service: { name: 'Service charge', unit: 'percent', value: 10, split: 'order' },
  vat12: { name: 'VAT 12%', unit: 'percent', value: 12, split: 'order', included: true },
  vat7: { name: 'VAT 7%', unit: 'percent', value: 7, split: 'order', onTop: true },
  tip: { name: 'Tip', unit: 'amount', value: '', split: 'even' },
  venue: { name: 'Venue fee', unit: 'amount', value: '', split: 'even' },
  other: { name: 'Other', unit: 'amount', value: '', split: 'even' },
};

const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function guessCurrency() {
  const lang = (navigator.language || '').toLowerCase();
  return lang === 'th' || lang.endsWith('-th') ? 'THB' : 'PHP';
}

function fresh(people = []) {
  return {
    v: 1, currency: guessCurrency(), people, items: [], charges: [], paidBy: {}, putIn: {},
    billTotal: '', step: people.length ? 1 : 0, turn: null, handoff: false, done: [],
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.v === 1) return { ...fresh(), ...saved };
  } catch { /* private window or blocked storage */ }
  return fresh();
}

let state = load();
let scan = null;
let newBillArmed = null;

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

// ---- Money ----

let fmt = null;
function money(n) {
  if (!fmt || fmt.cur !== state.currency) {
    const d = minorUnits(state.currency);
    let f;
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: d, maximumFractionDigits: d });
    } catch {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, minimumFractionDigits: d, maximumFractionDigits: d });
    }
    fmt = { cur: state.currency, f };
  }
  return fmt.f.format(Math.abs(n) < 1e-9 ? 0 : n);
}
function symbol() {
  const part = new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find((p) => p.type === 'currency');
  return part ? part.value : state.currency;
}
const plain = (n) => (hasValue(n) ? String(n) : '');
const close = (a, b) => Math.abs(a - b) < 0.5 / 10 ** minorUnits(state.currency) + 1e-9;
const nameOf = (id) => state.people.find((p) => p.id === id)?.name || 'No name';
const listNames = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// ---- Rendering ----

const view = document.getElementById('view');
const bar = document.getElementById('bar');
const steps = document.getElementById('steps');
const sheet = document.getElementById('sheet');
const sheetIn = document.getElementById('sheet-in');

function render(focusId) {
  const turning = state.step === 3 && state.turn;
  document.body.classList.toggle('turning', !!turning);
  renderSteps();
  view.innerHTML = [renderPeople, renderBill, renderCharges, renderClaim, renderTotals][state.step]();
  renderBar();
  live();
  if (focusId) document.getElementById(focusId)?.focus();
}

function renderSteps() {
  const counts = [state.people.length, state.items.length, state.charges.length, null, null];
  steps.innerHTML = STEPS.map((label, i) => `<button class="step${i === state.step ? ' on' : ''}" data-step="${i}">${label}${counts[i] ? `<span class="n">${counts[i]}</span>` : ''}</button>`).join('');
}

function renderBar() {
  const back = state.step > 0 ? `<button class="btn" data-go="${state.step - 1}">Back</button>` : '';
  const next = state.step < STEPS.length - 1
    ? `<button class="btn btn-primary grow" data-go="${state.step + 1}">Next: ${STEPS[state.step + 1]}</button>`
    : '<button class="btn btn-primary grow" data-act="copy">Copy the totals</button>';
  bar.innerHTML = back + next;
}

function renderPeople() {
  const rows = state.people.map((p) => `
    <li><input type="text" data-in="person-name" data-id="${p.id}" value="${esc(p.name)}" aria-label="Name">
    <button class="icon-btn" data-act="del-person" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join('');
  return `
  <section class="card">
    <h2>People</h2>
    <div class="add-row">
      <input type="text" id="name-in" placeholder="Name" enterkeyhint="next" autocomplete="off" autocapitalize="words">
      <button class="btn btn-primary" data-act="add-person">Add</button>
    </div>
    ${rows ? `<ul class="list">${rows}</ul>` : ''}
  </section>`;
}

function renderBill() {
  const rows = state.items.map((it) => `
    <li><input type="text" data-in="item-name" data-id="${it.id}" value="${esc(it.name)}" aria-label="Item">
    <input type="text" class="money" inputmode="decimal" data-in="item-price" data-id="${it.id}" value="${esc(plain(it.price))}" aria-label="Price of ${esc(it.name)}">
    <button class="icon-btn" data-act="del-item" data-id="${it.id}" aria-label="Remove ${esc(it.name)}">×</button></li>`).join('');
  const options = CURRENCIES.map(([code, label]) => `<option value="${code}"${code === state.currency ? ' selected' : ''}>${code} ${label}</option>`).join('');
  return `
  <section class="card">
    <div class="head-row"><h2>Bill</h2><div class="grow"></div>
      <select data-ch="currency" aria-label="Currency" style="width:auto">${options}</select></div>
    <div class="actions">
      <label class="btn btn-primary">Scan the bill<input type="file" accept="image/*" capture="environment" data-ch="scan" hidden></label>
      <label class="btn">Choose a photo<input type="file" accept="image/*" data-ch="scan" hidden></label>
    </div>
    <div class="add-row">
      <input type="text" id="item-name" placeholder="Item" enterkeyhint="next" autocomplete="off">
      <input type="text" id="item-price" class="money" inputmode="decimal" placeholder="Price" enterkeyhint="done" autocomplete="off">
      <button class="btn btn-primary" data-act="add-item">Add</button>
    </div>
    ${rows ? `<ul class="list">${rows}</ul>` : ''}
  </section>
  <section class="card">
    <div class="field"><label for="bill-total">Total on the bill</label>
      <input type="text" id="bill-total" class="money" inputmode="decimal" data-in="bill-total" value="${esc(state.billTotal)}" placeholder="Example: 2,494.46"></div>
    <p class="check" data-live="check"></p>
  </section>`;
}

function renderCharges() {
  const sym = esc(symbol());
  const presets = [['service', 'Service charge 10%'], ['vat12', 'VAT 12%'], ['vat7', 'VAT 7%'], ['tip', 'Tip'], ['venue', 'Venue fee'], ['other', 'Other']]
    .map(([key, label]) => `<button class="btn btn-small" data-act="add-charge" data-preset="${key}">+ ${label}</button>`).join('');
  const cards = state.charges.map((c) => {
    const seg = (field, options) => `<div class="seg wide">${options.map(([val, label]) => `<button data-act="charge-set" data-id="${c.id}" data-field="${field}" data-val="${val}" class="${String(c[field] ?? '') === String(val) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    const chips = state.people.map((p) => `<button class="chip${(c.excluded || []).includes(p.id) ? '' : ' on'}" data-act="charge-person" data-id="${c.id}" data-person="${p.id}">${esc(p.name)}</button>`).join('');
    return `
    <article class="card">
      <div class="head-row"><input type="text" class="charge-title" data-in="charge-name" data-id="${c.id}" value="${esc(c.name)}" aria-label="Charge name">
        <button class="icon-btn" data-act="del-charge" data-id="${c.id}" aria-label="Remove ${esc(c.name)}">×</button></div>
      <div class="field"><span class="label">Amount</span>
        <div class="joined"><input type="text" class="money" inputmode="decimal" data-in="charge-value" data-id="${c.id}" value="${esc(plain(c.value))}" aria-label="Amount of ${esc(c.name)}">
        <div class="seg">${[['percent', '%'], ['amount', sym]].map(([val, label]) => `<button data-act="charge-set" data-id="${c.id}" data-field="unit" data-val="${val}" class="${c.unit === val ? 'on' : ''}">${label}</button>`).join('')}</div></div></div>
      ${c.unit === 'percent' ? `<div class="field"><span class="label">Percent of</span>${seg('onTop', [['false', 'Food'], ['true', 'Food + charges above']])}</div>` : ''}
      <label class="switch"><input type="checkbox" data-ch="charge-included" data-id="${c.id}"${c.included ? ' checked' : ''}> Already in the prices</label>
      ${c.included ? '' : `
      <div class="field"><span class="label">Split</span>${seg('split', [['even', 'Even per head'], ['order', 'By what each ordered']])}</div>
      <div class="field"><span class="label">Who pays</span><div class="chips">${chips || '<span class="muted">Add names first.</span>'}</div></div>`}
      <p class="live" data-live="charge" data-id="${c.id}"></p>
    </article>`;
  }).join('');
  return `
  <section class="card">
    <h2>Charges</h2>
    <div class="presets">${presets}</div>
  </section>
  ${cards}
  <section class="card" data-live="summary"></section>`;
}

function renderClaim() {
  if (!state.people.length) return '<section class="card"><h2>Claim</h2><p>Add names first.</p><button class="btn" data-go="0">Go to People</button></section>';
  if (!state.items.length) return '<section class="card"><h2>Claim</h2><p>Add the items first.</p><button class="btn" data-go="1">Go to Bill</button></section>';
  if (state.turn && !state.people.some((p) => p.id === state.turn)) state.turn = null;
  if (state.turn && state.handoff) {
    const name = esc(nameOf(state.turn));
    return `<section class="handoff"><p>Pass the phone to</p><h2>${name}</h2>
      <button class="btn btn-primary btn-big" data-act="turn-go">I'm ${name}</button>
      <button class="btn btn-big" data-act="turn-skip">Skip ${name}</button>
      <button class="btn btn-big" data-act="turn-exit">Back to the list</button></section>`;
  }
  if (state.turn) {
    const me = state.turn;
    const picks = state.items.map((it) => {
      const on = (it.claimedBy || []).includes(me);
      const others = (it.claimedBy || []).filter((id) => id !== me).map(nameOf);
      const ways = (it.claimedBy || []).length;
      let note = '';
      if (on && others.length) note = `Shared with ${esc(listNames(others))}, ${money(num(it.price) / ways)} each`;
      else if (others.length) note = `Ticked by ${esc(listNames(others))}`;
      return `<li><button class="pick${on ? ' on' : ''}" data-act="pick" data-id="${it.id}" aria-pressed="${on}">
        <span class="box"></span><span class="pick-name">${esc(it.name || 'Item')}</span><span class="pick-price">${money(num(it.price))}</span>
        ${note ? `<span class="pick-with">${note}</span>` : ''}</button></li>`;
    }).join('');
    return `
    <div class="turn-head"><h2>${esc(nameOf(me))}, tick what you had</h2><p class="muted">Tick anything you shared too.</p></div>
    <ul class="pick-list">${picks}</ul>
    <div class="turn-foot"><span class="mine" data-live="mine"></span><div class="grow"></div>
      <button class="btn" data-act="turn-exit">List</button>
      <button class="btn btn-primary" data-act="turn-done">Done</button></div>`;
  }
  const next = state.people.find((p) => !state.done.includes(p.id));
  const status = state.people.map((p) => {
    const count = state.items.filter((it) => (it.claimedBy || []).includes(p.id)).length;
    const done = state.done.includes(p.id);
    return `<button class="btn${done ? ' done' : ''}" data-act="turn-open" data-id="${p.id}">${esc(p.name)}<small>${done ? `Done, ${count} ${count === 1 ? 'item' : 'items'}` : count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Not yet'}</small></button>`;
  }).join('');
  const nobody = state.items.filter((it) => !(it.claimedBy || []).length && num(it.price));
  const items = state.items.map((it) => {
    const chips = state.people.map((p) => `<button class="chip${(it.claimedBy || []).includes(p.id) ? ' on' : ''}" data-act="claim" data-id="${it.id}" data-person="${p.id}">${esc(p.name)}</button>`).join('');
    const empty = !(it.claimedBy || []).length;
    return `<div class="claim-item">
      <div class="sum-row"><span>${esc(it.name || 'Item')}${empty ? ' <small class="live bad">Nobody yet</small>' : ''}</span><span>${money(num(it.price))}</span></div>
      <div class="chips">${chips}<button class="chip all" data-act="claim-all" data-id="${it.id}">Everyone</button></div></div>`;
  }).join('');
  return `
  <section class="card">
    <h2>Pass the phone</h2>
    <p class="muted">Each person ticks what they had, including anything shared.</p>
    ${next ? `<p><button class="btn btn-primary btn-big" data-act="turn-start" data-id="${next.id}">Start with ${esc(next.name)}</button></p>` : ''}
    <div class="status-list">${status}</div>
  </section>
  <section class="card">
    <h2>Items</h2>
    ${nobody.length ? `<p class="check bad">${nobody.length === 1 ? '1 item has' : `${nobody.length} items have`} nobody on ${nobody.length === 1 ? 'it' : 'them'}.</p>
      <p><button class="btn" data-act="nobody-all">Split ${nobody.length === 1 ? 'it' : 'those'} among everyone</button></p>` : ''}
    ${items}
  </section>`;
}

function renderTotals() {
  if (!state.people.length) return '<section class="card"><h2>Totals</h2><p>Add names first.</p><button class="btn" data-go="0">Go to People</button></section>';
  const r = compute(state);
  const options = (id) => [`<option value="">Themselves</option>`]
    .concat(state.people.filter((p) => p.id !== id).map((p) => `<option value="${p.id}"${state.paidBy[id] === p.id ? ' selected' : ''}>${esc(p.name)}</option>`)).join('');
  const rows = r.people.map((p) => `
    <div class="adjust-row">
      <span class="who">${esc(p.name)}</span>
      <div class="field"><label for="pb-${p.id}">Paid by</label><select id="pb-${p.id}" data-ch="paid-by" data-id="${p.id}">${options(p.id)}</select></div>
      <div class="field"><label for="pi-${p.id}">Putting in</label><input type="text" id="pi-${p.id}" class="money" inputmode="decimal" data-in="put-in" data-id="${p.id}"
        value="${esc(plain(state.putIn[p.id]))}" placeholder="${esc(p.coveredBy ? '' : money(p.due))}"${p.coveredBy ? ' disabled' : ''}></div>
    </div>`).join('');
  return `
  <div data-live="results"></div>
  <section class="card">
    <h2>Adjust</h2>
    <p class="muted">Pick who pays for whom, and enter an amount for anyone putting in more or less than their share.</p>
    ${rows}
  </section>`;
}

function resultsHtml() {
  const r = compute(state);
  const blocking = r.problems.filter((p) => p.type === 'unclaimed' || p.type === 'nopayer');
  if (blocking.length) {
    const unclaimed = blocking.filter((p) => p.type === 'unclaimed').map((p) => esc(p.name));
    const nopayer = blocking.filter((p) => p.type === 'nopayer').map((p) => esc(p.name));
    return `<section class="card"><h2>Totals</h2>
      ${unclaimed.length ? `<p class="check bad">Nobody has ticked ${listNames(unclaimed)}.</p><p><button class="btn" data-go="3">Go to Claim</button></p>` : ''}
      ${nopayer.length ? `<p class="check bad">Nobody is ticked to pay ${listNames(nopayer)}.</p><p><button class="btn" data-go="2">Go to Charges</button></p>` : ''}
    </section>`;
  }
  const cards = r.people.map((p) => {
    const notes = [];
    if (p.coveredBy) notes.push(`Paid by ${esc(nameOf(p.coveredBy))}`);
    if (p.covers.length) notes.push(`Covers ${esc(listNames(p.covers.map(nameOf)))}`);
    if (p.putIn !== null) notes.push(`Putting in ${money(p.putIn)}`);
    if (p.changeBack > 1e-9) notes.push(`Gets ${money(p.changeBack)} back`);
    if (p.adjust < -1e-9) notes.push(`${money(-p.adjust)} off from what ${esc(listNames(p.adjustFrom.map(nameOf)))} put in`);
    if (p.adjust > 1e-9) notes.push(`${money(p.adjust)} more since ${esc(listNames(p.adjustFrom.map(nameOf)))} put in less`);
    const lines = p.lines.map((l) => {
      const label = l.kind === 'item' ? `${esc(l.name)}${l.ways > 1 ? ` <span class="muted">÷ ${l.ways}</span>` : ''}`
        : l.kind === 'covers' ? `${esc(l.name)}'s share` : esc(l.name);
      return `<div class="sum-row"><span>${label}</span><span>${money(l.amount)}</span></div>`;
    }).join('');
    const adjustLine = Math.abs(p.adjust) > 1e-9 ? `<div class="sum-row"><span>Adjustment</span><span>${p.adjust < 0 ? '−' : ''}${money(Math.abs(p.adjust))}</span></div>` : '';
    return `<article class="result">
      <div class="result-top"><span class="who">${esc(p.name)}</span><span class="amount">${money(p.final)}</span></div>
      ${notes.length ? `<p class="notes">${notes.join(' · ')}</p>` : ''}
      ${lines || adjustLine ? `<details><summary>Breakdown</summary>${lines}${adjustLine}</details>` : ''}
    </article>`;
  }).join('');
  const collected = r.people.reduce((a, p) => a + p.final, 0);
  const printed = hasValue(state.billTotal) ? num(state.billTotal) : null;
  return `<section class="card"><h2>Totals</h2>
    ${cards}
    <div class="sum-row total"><span>Bill</span><span>${money(r.total)}</span></div>
    <div class="sum-row"><span class="muted">Collected</span><span>${money(collected)}</span></div>
    ${r.change > 1e-9 ? `<div class="sum-row"><span class="muted">Change back</span><span>${money(r.change)}</span></div>` : ''}
    ${r.short > 1e-9 ? `<p class="check bad">Short by ${money(r.short)}.</p>` : ''}
    ${printed !== null && !close(printed, r.total) ? `<p class="check bad">The bill says ${money(printed)}, a difference of ${money(Math.abs(printed - r.total))}.</p>` : ''}
  </section>`;
}

// Parts that change while someone types, updated without rebuilding inputs.
function live() {
  const r = compute(state);
  for (const el of view.querySelectorAll('[data-live]')) {
    const kind = el.dataset.live;
    if (kind === 'check') {
      const printed = hasValue(state.billTotal) ? num(state.billTotal) : null;
      if (printed === null) {
        el.className = 'check plain';
        el.textContent = `Items and charges come to ${money(r.total)}.`;
      } else if (close(printed, r.total)) {
        el.className = 'check ok';
        el.textContent = `Items and charges come to ${money(r.total)} and match the bill.`;
      } else {
        el.className = 'check bad';
        el.textContent = `Items and charges come to ${money(r.total)} while the bill says ${money(printed)}, a difference of ${money(Math.abs(printed - r.total))}.`;
      }
    } else if (kind === 'charge') {
      const i = state.charges.findIndex((c) => c.id === el.dataset.id);
      const c = state.charges[i];
      const amount = r.charges[i]?.amount || 0;
      const payers = state.people.filter((p) => !(c.excluded || []).includes(p.id)).length;
      el.classList.remove('bad');
      if (c.included) el.textContent = `${money(amount)} already in the prices.`;
      else if (!payers && amount) { el.textContent = 'Tick at least one person.'; el.classList.add('bad'); }
      else el.textContent = `${money(amount)}, ${c.split === 'order' ? 'by what each ordered' : 'even per head'} across ${payers} ${payers === 1 ? 'person' : 'people'}.`;
    } else if (kind === 'summary') {
      const rows = r.charges.map((c) => `<div class="sum-row"><span>${esc(c.name)}${c.included ? ' <span class="muted">in the prices</span>' : ''}</span><span>${money(c.amount)}</span></div>`).join('');
      el.innerHTML = `<div class="sum-row"><span>Food</span><span>${money(r.subtotal)}</span></div>${rows}
        <div class="sum-row total"><span>Total</span><span>${money(r.total)}</span></div>`;
    } else if (kind === 'mine') {
      const me = r.people.find((p) => p.id === state.turn);
      el.textContent = me ? `Your items ${money(me.food)}` : '';
    } else if (kind === 'results') {
      el.innerHTML = resultsHtml();
    }
  }
}

// ---- Actions ----

function go(step) {
  state.step = Math.max(0, Math.min(STEPS.length - 1, step));
  if (state.step !== 3) { state.turn = null; state.handoff = false; }
  save();
  render();
  window.scrollTo(0, 0);
}

function addPerson() {
  const input = document.getElementById('name-in');
  const names = input.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  for (const name of names) state.people.push({ id: uid(), name });
  save();
  render('name-in');
}

function addItem() {
  const name = document.getElementById('item-name').value.trim();
  const price = document.getElementById('item-price').value.trim();
  if (!name && !price) return;
  state.items.push({ id: uid(), name: name || 'Item', price: hasValue(price) ? num(price) : '', claimedBy: [] });
  save();
  render('item-name');
}

function nextTurn(after) {
  const order = state.people.map((p) => p.id);
  const start = order.indexOf(after);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(start + k) % order.length];
    if (!state.done.includes(id)) return id;
  }
  return null;
}

const actions = {
  'add-person': addPerson,
  'del-person': (el) => {
    const id = el.dataset.id;
    state.people = state.people.filter((p) => p.id !== id);
    for (const it of state.items) it.claimedBy = (it.claimedBy || []).filter((x) => x !== id);
    for (const c of state.charges) c.excluded = (c.excluded || []).filter((x) => x !== id);
    delete state.putIn[id];
    delete state.paidBy[id];
    for (const k of Object.keys(state.paidBy)) if (state.paidBy[k] === id) delete state.paidBy[k];
    state.done = state.done.filter((x) => x !== id);
    save(); render();
  },
  'add-item': addItem,
  'del-item': (el) => { state.items = state.items.filter((it) => it.id !== el.dataset.id); save(); render(); },
  'add-charge': (el) => {
    state.charges.push({ id: uid(), onTop: false, included: false, excluded: [], ...PRESETS[el.dataset.preset] });
    save(); render();
    window.scrollTo(0, document.body.scrollHeight);
  },
  'del-charge': (el) => { state.charges = state.charges.filter((c) => c.id !== el.dataset.id); save(); render(); },
  'charge-set': (el) => {
    const c = state.charges.find((x) => x.id === el.dataset.id);
    const val = el.dataset.val;
    c[el.dataset.field] = val === 'true' ? true : val === 'false' ? false : val;
    save(); render();
  },
  'charge-person': (el) => {
    const c = state.charges.find((x) => x.id === el.dataset.id);
    const id = el.dataset.person;
    c.excluded = c.excluded || [];
    c.excluded = c.excluded.includes(id) ? c.excluded.filter((x) => x !== id) : [...c.excluded, id];
    save(); render();
  },
  claim: (el) => {
    const it = state.items.find((x) => x.id === el.dataset.id);
    const id = el.dataset.person;
    it.claimedBy = (it.claimedBy || []).includes(id) ? it.claimedBy.filter((x) => x !== id) : [...(it.claimedBy || []), id];
    save(); render();
  },
  'claim-all': (el) => {
    const it = state.items.find((x) => x.id === el.dataset.id);
    const all = state.people.map((p) => p.id);
    it.claimedBy = (it.claimedBy || []).length === all.length ? [] : all;
    save(); render();
  },
  'nobody-all': () => {
    const all = state.people.map((p) => p.id);
    for (const it of state.items) if (!(it.claimedBy || []).length) it.claimedBy = all.slice();
    save(); render();
  },
  'turn-start': (el) => { state.turn = el.dataset.id; state.handoff = true; save(); render(); window.scrollTo(0, 0); },
  'turn-open': (el) => { state.turn = el.dataset.id; state.handoff = false; save(); render(); window.scrollTo(0, 0); },
  'turn-go': () => { state.handoff = false; save(); render(); window.scrollTo(0, 0); },
  'turn-skip': () => {
    const next = nextTurn(state.turn);
    state.turn = next && next !== state.turn ? next : null;
    state.handoff = !!state.turn;
    save(); render();
  },
  'turn-exit': () => { state.turn = null; state.handoff = false; save(); render(); window.scrollTo(0, 0); },
  'turn-done': () => {
    if (!state.done.includes(state.turn)) state.done.push(state.turn);
    const next = nextTurn(state.turn);
    state.turn = next;
    state.handoff = !!next;
    save(); render(); window.scrollTo(0, 0);
  },
  pick: (el) => {
    const it = state.items.find((x) => x.id === el.dataset.id);
    const me = state.turn;
    it.claimedBy = (it.claimedBy || []).includes(me) ? it.claimedBy.filter((x) => x !== me) : [...(it.claimedBy || []), me];
    save();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  copy: async (el) => {
    const r = compute(state);
    if (r.problems.some((p) => p.type === 'unclaimed' || p.type === 'nopayer')) return;
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const lines = [`Bill split, ${date}`];
    for (const p of r.people) {
      const extra = p.coveredBy ? ` (paid by ${nameOf(p.coveredBy)})` : p.changeBack > 1e-9 ? ` (gets ${money(p.changeBack)} back)` : '';
      lines.push(`${p.name}: ${money(p.final)}${extra}`);
    }
    lines.push(`Total: ${money(r.total)}`);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      el.textContent = 'Copied';
    } catch {
      el.textContent = 'Copy failed';
    }
    setTimeout(() => { el.textContent = 'Copy the totals'; }, 1800);
  },
};

const inputs = {
  'person-name': (el) => { const p = state.people.find((x) => x.id === el.dataset.id); if (p) p.name = el.value; },
  'item-name': (el) => { const it = state.items.find((x) => x.id === el.dataset.id); if (it) it.name = el.value; },
  'item-price': (el) => { const it = state.items.find((x) => x.id === el.dataset.id); if (it) it.price = el.value.trim(); },
  'bill-total': (el) => { state.billTotal = el.value.trim(); },
  'charge-name': (el) => { const c = state.charges.find((x) => x.id === el.dataset.id); if (c) c.name = el.value; },
  'charge-value': (el) => { const c = state.charges.find((x) => x.id === el.dataset.id); if (c) c.value = el.value.trim(); },
  'put-in': (el) => {
    const v = el.value.trim();
    if (hasValue(v)) state.putIn[el.dataset.id] = v; else delete state.putIn[el.dataset.id];
  },
};

const changes = {
  currency: (el) => { state.currency = el.value; save(); render(); },
  'charge-included': (el) => {
    const c = state.charges.find((x) => x.id === el.dataset.id);
    c.included = el.checked;
    save(); render();
  },
  'paid-by': (el) => {
    if (el.value) {
      state.paidBy[el.dataset.id] = el.value;
      delete state.putIn[el.dataset.id];
    } else delete state.paidBy[el.dataset.id];
    save(); render();
  },
  scan: (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (file) openScan(file);
  },
};

document.addEventListener('click', (e) => {
  const goEl = e.target.closest('[data-go]');
  if (goEl && !goEl.closest('#sheet')) { go(Number(goEl.dataset.go)); return; }
  const stepEl = e.target.closest('[data-step]');
  if (stepEl) { go(Number(stepEl.dataset.step)); return; }
  const el = e.target.closest('[data-act]');
  if (el && !el.closest('#sheet') && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});
view.addEventListener('input', (e) => {
  const el = e.target.closest('[data-in]');
  if (!el || !inputs[el.dataset.in]) return;
  inputs[el.dataset.in](el);
  save();
  live();
});
view.addEventListener('change', (e) => {
  const el = e.target.closest('[data-ch]');
  if (el && changes[el.dataset.ch]) changes[el.dataset.ch](el);
});
view.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'name-in') { e.preventDefault(); addPerson(); }
  else if (e.target.id === 'item-name') { e.preventDefault(); document.getElementById('item-price').focus(); }
  else if (e.target.id === 'item-price') { e.preventDefault(); addItem(); }
});

document.getElementById('new-bill').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!newBillArmed) {
    btn.textContent = 'Tap again to clear';
    newBillArmed = setTimeout(() => { btn.textContent = 'New bill'; newBillArmed = null; }, 3000);
    return;
  }
  clearTimeout(newBillArmed);
  newBillArmed = null;
  btn.textContent = 'New bill';
  const currency = state.currency;
  state = fresh(state.people);
  state.currency = currency;
  save();
  render();
});

// ---- Photo reader ----

function openScan(file) {
  if (scan?.photo) URL.revokeObjectURL(scan.photo);
  scan = { status: 'reading', label: 'Preparing the photo', share: 0, photo: URL.createObjectURL(file) };
  const mine = scan;
  renderSheet();
  scanBill(file, {
    currency: state.currency,
    onProgress: (label, share) => {
      if (scan !== mine) return;
      scan.label = label;
      scan.share = share;
      const bar = sheetIn.querySelector('.progress > div');
      const text = sheetIn.querySelector('[data-scan-label]');
      if (bar) bar.style.width = `${Math.round(share * 100)}%`;
      if (text) text.textContent = label;
    },
  }).then((res) => {
    if (scan !== mine) return;
    scan = {
      status: 'review', photo: scan.photo, text: res.text,
      items: res.items.map((i) => ({ ...i, on: true })),
      charges: res.charges.map((c) => ({ ...c, on: true })),
      total: res.total === null ? '' : String(res.total),
    };
    renderSheet();
  }).catch((err) => {
    if (scan !== mine) return;
    scan = { status: 'error', photo: scan.photo, message: err && err.message ? err.message : String(err) };
    renderSheet();
  });
}

function closeScan() {
  if (scan?.photo) URL.revokeObjectURL(scan.photo);
  scan = null;
  sheet.hidden = true;
  sheetIn.innerHTML = '';
  document.body.style.overflow = '';
}

function scanCheck() {
  const items = scan.items.filter((i) => i.on).reduce((a, i) => a + num(i.price), 0);
  const charges = scan.charges.filter((c) => c.on && !c.included).reduce((a, c) => a + num(c.amount), 0);
  const sumAll = items + charges;
  if (!hasValue(scan.total)) return { cls: 'plain', text: `Ticked lines come to ${money(sumAll)}.` };
  const t = num(scan.total);
  if (close(t, sumAll)) return { cls: 'ok', text: `Ticked lines come to ${money(sumAll)} and match the bill.` };
  return { cls: 'bad', text: `Ticked lines come to ${money(sumAll)} while the bill says ${money(t)}, a difference of ${money(Math.abs(t - sumAll))}.` };
}

function renderSheet() {
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  const photo = `<img class="scan-photo" src="${scan.photo}" alt="Photo of the bill" data-sact="zoom">`;
  if (scan.status === 'reading') {
    sheetIn.innerHTML = `<div class="head-row"><h2>Reading the bill</h2></div>${photo}
      <div class="progress"><div style="width:${Math.round(scan.share * 100)}%"></div></div>
      <p class="muted" data-scan-label>${esc(scan.label)}</p>
      <p class="muted">The first scan downloads about 7MB and later scans reuse it.</p>
      <div class="sheet-foot"><button class="btn grow" data-sact="cancel">Cancel</button></div>`;
    return;
  }
  if (scan.status === 'error') {
    sheetIn.innerHTML = `<div class="head-row"><h2>Reading the bill</h2></div>${photo}
      <p class="check bad">The bill could not be read. ${esc(scan.message)}</p>
      <div class="sheet-foot"><button class="btn grow" data-sact="cancel">Close</button></div>`;
    return;
  }
  const itemRows = scan.items.map((it, i) => `
    <div class="scan-row${it.on ? '' : ' off'}"><input type="checkbox" data-sch="item-on" data-i="${i}"${it.on ? ' checked' : ''} aria-label="Keep ${esc(it.name)}">
      <input type="text" data-sin="item-name" data-i="${i}" value="${esc(it.name)}" aria-label="Item">
      <input type="text" class="money" inputmode="decimal" data-sin="item-price" data-i="${i}" value="${esc(it.price)}" aria-label="Price"></div>`).join('');
  const chargeRows = scan.charges.map((c, i) => `
    <div class="scan-row${c.on ? '' : ' off'}"><input type="checkbox" data-sch="charge-on" data-i="${i}"${c.on ? ' checked' : ''} aria-label="Keep ${esc(c.name)}">
      <input type="text" data-sin="charge-name" data-i="${i}" value="${esc(c.name)}" aria-label="Charge">
      <input type="text" class="money" inputmode="decimal" data-sin="charge-amount" data-i="${i}" value="${esc(c.amount)}" aria-label="Amount">
      ${c.kind === 'discount' ? '' : `<label class="in-prices"><input type="checkbox" data-sch="charge-included" data-i="${i}"${c.included ? ' checked' : ''}> Already in the prices</label>`}</div>`).join('');
  const kept = scan.items.filter((i) => i.on).length;
  const check = scanCheck();
  sheetIn.innerHTML = `
    <div class="head-row"><h2>Check what was read</h2><div class="grow"></div><button class="icon-btn" data-sact="cancel" aria-label="Close">×</button></div>
    ${photo}
    ${scan.items.length ? `<h3>Items</h3>${itemRows}` : '<p class="check bad" style="margin-top:12px">No prices found. Retake the photo closer with the bill flat.</p>'}
    ${scan.charges.length ? `<h3>Charges</h3>${chargeRows}` : ''}
    <div class="field" style="margin-top:12px"><label for="scan-total">Total on the bill</label>
      <input type="text" id="scan-total" class="money" inputmode="decimal" data-sin="total" value="${esc(scan.total)}"></div>
    <p class="check ${check.cls}" data-scan-check>${esc(check.text)}</p>
    <details class="rawbox"><summary>Text read from the photo</summary><pre class="raw">${esc(scan.text)}</pre></details>
    <div class="sheet-foot"><button class="btn" data-sact="cancel">Cancel</button>
      <button class="btn btn-primary grow" data-sact="add"${kept || scan.charges.some((c) => c.on) ? '' : ' disabled'}>Add ${kept} ${kept === 1 ? 'item' : 'items'}</button></div>`;
}

sheetIn.addEventListener('click', (e) => {
  const el = e.target.closest('[data-sact]');
  if (!el) return;
  const act = el.dataset.sact;
  if (act === 'zoom') el.classList.toggle('big');
  else if (act === 'cancel') closeScan();
  else if (act === 'add') {
    for (const it of scan.items.filter((x) => x.on)) {
      state.items.push({ id: uid(), name: it.name || 'Item', price: hasValue(it.price) ? num(it.price) : '', claimedBy: [] });
    }
    for (const c of scan.charges.filter((x) => x.on)) {
      state.charges.push({
        id: uid(), name: c.name, unit: 'amount', value: hasValue(c.amount) ? num(c.amount) : '',
        included: !!c.included, onTop: false, split: c.kind === 'discount' ? 'even' : 'order', excluded: [],
      });
    }
    if (hasValue(scan.total)) state.billTotal = String(num(scan.total));
    closeScan();
    save();
    render();
  }
});
sheet.addEventListener('click', (e) => { if (e.target === sheet && scan?.status !== 'reading') closeScan(); });
sheetIn.addEventListener('input', (e) => {
  const el = e.target.closest('[data-sin]');
  if (!el) return;
  const i = Number(el.dataset.i);
  const field = el.dataset.sin;
  if (field === 'item-name') scan.items[i].name = el.value;
  else if (field === 'item-price') scan.items[i].price = el.value.trim();
  else if (field === 'charge-name') scan.charges[i].name = el.value;
  else if (field === 'charge-amount') scan.charges[i].amount = el.value.trim();
  else if (field === 'total') scan.total = el.value.trim();
  const check = scanCheck();
  const p = sheetIn.querySelector('[data-scan-check]');
  p.className = `check ${check.cls}`;
  p.textContent = check.text;
});
sheetIn.addEventListener('change', (e) => {
  const el = e.target.closest('[data-sch]');
  if (!el) return;
  const i = Number(el.dataset.i);
  if (el.dataset.sch === 'item-on') scan.items[i].on = el.checked;
  else if (el.dataset.sch === 'charge-on') scan.charges[i].on = el.checked;
  else if (el.dataset.sch === 'charge-included') scan.charges[i].included = el.checked;
  const y = sheetIn.scrollTop;
  renderSheet();
  sheetIn.scrollTop = y;
});

// ---- Install and offline ----

let installEvent = null;
const installBtn = document.getElementById('install');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
