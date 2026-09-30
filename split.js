// The whole split, worked out from the bill state. No DOM in here, so the
// tests in tests/split.test.mjs run it straight under Node.

export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

export function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '' && Number.isFinite(num(value));
}

export function minorUnits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

// Charge amounts in the order they sit on the bill. A percent charge set to
// "food + charges above" takes every added charge above it into its base,
// which is how a Thai ++ bill puts 7% VAT on the food plus the 10% service.
export function chargeAmounts(bill, subtotal) {
  let added = 0;
  return (bill.charges || []).map((c) => {
    const value = num(c.value);
    const base = subtotal + (c.onTop ? added : 0);
    const amount = c.unit === 'percent' ? (base * value) / 100 : value;
    if (!c.included) added += amount;
    return { id: c.id, name: c.name || 'Charge', amount, included: !!c.included };
  });
}

// Spread whole minor units (cents) so the rounded amounts add up to the
// rounded total exactly. Units left over go to the amounts that lost the most
// in rounding.
export function roundShares(values, digits) {
  const scale = 10 ** digits;
  const scaled = values.map((v) => v * scale);
  const target = Math.round(sum(scaled));
  const floors = scaled.map((v) => Math.floor(v + 1e-9));
  let left = target - sum(floors);
  const order = scaled
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k].i] += 1;
  for (let k = order.length - 1; left < 0 && order.length; k = (k - 1 + order.length) % order.length, left++) out[order[k].i] -= 1;
  return out.map((v) => v / scale);
}

export function compute(bill) {
  const people = bill.people || [];
  const ids = people.map((p) => p.id);
  const nameOf = Object.fromEntries(people.map((p) => [p.id, p.name || 'No name']));
  const digits = minorUnits(bill.currency || 'PHP');
  const problems = [];
  const zero = () => Object.fromEntries(ids.map((id) => [id, 0]));
  const lines = Object.fromEntries(ids.map((id) => [id, []]));

  // Items: each one divided evenly among whoever ticked it.
  const food = zero();
  let subtotal = 0;
  for (const item of bill.items || []) {
    const price = num(item.price);
    subtotal += price;
    const on = (item.claimedBy || []).filter((id) => ids.includes(id));
    if (!on.length) {
      if (price) problems.push({ type: 'unclaimed', id: item.id, name: item.name || 'Item' });
      continue;
    }
    const each = price / on.length;
    for (const id of on) {
      food[id] += each;
      lines[id].push({ kind: 'item', name: item.name || 'Item', amount: each, ways: on.length });
    }
  }

  // Charges: even per head, or weighted by each person's food.
  const charges = chargeAmounts(bill, subtotal);
  const extras = zero();
  (bill.charges || []).forEach((c, i) => {
    const { amount, included } = charges[i];
    if (included || !amount) return;
    const payers = ids.filter((id) => !(c.excluded || []).includes(id));
    if (!payers.length) {
      problems.push({ type: 'nopayer', id: c.id, name: charges[i].name });
      return;
    }
    let weights = payers.map((id) => (c.split === 'order' ? Math.max(food[id], 0) : 1));
    if (sum(weights) <= 0) weights = payers.map(() => 1);
    const total = sum(weights);
    payers.forEach((id, k) => {
      const share = (amount * weights[k]) / total;
      extras[id] += share;
      lines[id].push({ kind: 'charge', name: charges[i].name, amount: share });
    });
  });

  const total = subtotal + sum(charges.filter((c) => !c.included).map((c) => c.amount));
  const own = Object.fromEntries(ids.map((id) => [id, food[id] + extras[id]]));

  // Paying for someone moves their whole amount onto the payer. Chains
  // follow through (Ana pays for Ben, Ben pays for Cara, so Ana pays all
  // three). A loop is ignored and flagged.
  const paidBy = bill.paidBy || {};
  const rootOf = (id) => {
    const seen = new Set([id]);
    let cur = id;
    while (paidBy[cur] && ids.includes(paidBy[cur]) && paidBy[cur] !== cur) {
      cur = paidBy[cur];
      if (seen.has(cur)) return null;
      seen.add(cur);
    }
    return cur;
  };
  const due = zero();
  const coveredBy = {};
  for (const id of ids) {
    let root = rootOf(id);
    if (root === null) {
      problems.push({ type: 'loop', id, name: nameOf[id] });
      root = id;
    }
    due[root] += own[id];
    if (root !== id) {
      coveredBy[id] = root;
      lines[root].push({ kind: 'covers', name: nameOf[id], amount: own[id] });
    }
  }

  // Putting in: a person who sets an amount pays exactly that. Extra above
  // their due is divided evenly among everyone else who still owes, and
  // nobody drops below 0. A shortfall is divided evenly the same way.
  const putIn = bill.putIn || {};
  const fixed = ids.filter((id) => !coveredBy[id] && hasValue(putIn[id]));
  const rest = ids.filter((id) => !coveredBy[id] && !fixed.includes(id));
  const final = { ...due };
  const adjust = zero();
  const changeBack = zero();
  for (const id of fixed) final[id] = num(putIn[id]);
  const extra = sum(fixed.map((id) => num(putIn[id]) - due[id]));
  let change = 0;
  let short = 0;

  if (extra > 1e-9) {
    let pool = extra;
    const active = rest.filter((id) => final[id] > 1e-9).sort((a, b) => final[a] - final[b]);
    while (pool > 1e-9 && active.length) {
      const slice = pool / active.length;
      const low = active[0];
      if (final[low] <= slice) {
        pool -= final[low];
        adjust[low] -= final[low];
        final[low] = 0;
        active.shift();
      } else {
        for (const id of active) {
          final[id] -= slice;
          adjust[id] -= slice;
        }
        pool = 0;
      }
    }
    if (pool > 1e-9) {
      change = pool;
      const over = fixed.map((id) => Math.max(num(putIn[id]) - due[id], 0));
      const overTotal = sum(over);
      fixed.forEach((id, k) => {
        changeBack[id] = overTotal > 0 ? (pool * over[k]) / overTotal : pool / fixed.length;
      });
    }
  } else if (extra < -1e-9) {
    const gap = -extra;
    let takers = rest.filter((id) => due[id] > 1e-9);
    if (!takers.length) takers = rest;
    if (takers.length) {
      for (const id of takers) {
        final[id] += gap / takers.length;
        adjust[id] += gap / takers.length;
      }
    } else {
      short = gap;
      problems.push({ type: 'short', amount: gap });
    }
  }

  // Round only the amounts nobody typed, so a typed amount shows as typed.
  const loose = ids.filter((id) => !fixed.includes(id));
  const rounded = roundShares(loose.map((id) => final[id]), digits);
  loose.forEach((id, k) => { final[id] = rounded[k]; });

  const contributorsOf = (id) => {
    if (adjust[id] < -1e-9) return fixed.filter((f) => num(putIn[f]) - due[f] > 1e-9);
    if (adjust[id] > 1e-9) return fixed.filter((f) => due[f] - num(putIn[f]) > 1e-9);
    return [];
  };

  return {
    digits,
    subtotal,
    total,
    charges,
    change,
    short,
    problems,
    people: people.map((p) => ({
      id: p.id,
      name: nameOf[p.id],
      food: food[p.id],
      extras: extras[p.id],
      own: own[p.id],
      due: due[p.id],
      final: final[p.id],
      coveredBy: coveredBy[p.id] || null,
      covers: ids.filter((id) => coveredBy[id] === p.id),
      putIn: fixed.includes(p.id) ? num(putIn[p.id]) : null,
      adjust: adjust[p.id],
      adjustFrom: contributorsOf(p.id),
      changeBack: changeBack[p.id],
      lines: lines[p.id],
    })),
  };
}
