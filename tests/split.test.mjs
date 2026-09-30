// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, roundShares } from '../split.js';

const people = ['ana', 'ben', 'cara', 'dan'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
const by = (result) => Object.fromEntries(result.people.map((p) => [p.id, p.final]));
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} should be ${b}`);

test('items split among whoever ticked them', () => {
  const r = compute({
    currency: 'PHP', people,
    items: [
      { id: 'i1', name: 'Platter', price: 600, claimedBy: ['ana', 'ben', 'cara'] },
      { id: 'i2', name: 'Steak', price: 900, claimedBy: ['dan'] },
    ],
  });
  assert.deepEqual(by(r), { ana: 200, ben: 200, cara: 200, dan: 900 });
  assert.equal(r.total, 1500);
});

test('even charge splits per head, by order follows the food', () => {
  const items = [
    { id: 'i1', name: 'Wagyu', price: 3000, claimedBy: ['ana'] },
    { id: 'i2', name: 'Water', price: 0, claimedBy: ['ben'] },
    { id: 'i3', name: 'Pasta', price: 1000, claimedBy: ['cara'] },
  ];
  const three = people.slice(0, 3);
  const even = compute({ currency: 'PHP', people: three, items, charges: [{ id: 'c', name: 'Service', unit: 'percent', value: 10, split: 'even' }] });
  near(by(even).ben, 133.33);
  const order = compute({ currency: 'PHP', people: three, items, charges: [{ id: 'c', name: 'Service', unit: 'percent', value: 10, split: 'order' }] });
  assert.deepEqual(by(order), { ana: 3300, ben: 0, cara: 1100 });
});

test('unticked person is left out of a charge', () => {
  const r = compute({
    currency: 'PHP', people: people.slice(0, 3),
    items: [{ id: 'i', name: 'Pizza', price: 900, claimedBy: ['ana', 'ben', 'cara'] }],
    charges: [{ id: 'v', name: 'Venue', unit: 'amount', value: 300, split: 'even', excluded: ['cara'] }],
  });
  assert.deepEqual(by(r), { ana: 450, ben: 450, cara: 300 });
});

test('Thai ++ puts VAT on food plus service', () => {
  const r = compute({
    currency: 'THB', people: people.slice(0, 1),
    items: [{ id: 'i', name: 'Set', price: 1000, claimedBy: ['ana'] }],
    charges: [
      { id: 's', name: 'Service', unit: 'percent', value: 10, split: 'order' },
      { id: 'v', name: 'VAT', unit: 'percent', value: 7, split: 'order', onTop: true },
    ],
  });
  near(r.total, 1177);
  near(by(r).ana, 1177);
});

test('charge already in the prices adds nothing', () => {
  const r = compute({
    currency: 'PHP', people: people.slice(0, 2),
    items: [{ id: 'i', name: 'Lechon', price: 1120, claimedBy: ['ana', 'ben'] }],
    charges: [{ id: 'v', name: 'VAT', unit: 'percent', value: 12, included: true, split: 'order' }],
  });
  assert.deepEqual(by(r), { ana: 560, ben: 560 });
});

test('paying for someone moves their total, chains follow through', () => {
  const items = people.map((p) => ({ id: p.id, name: 'Meal', price: 100, claimedBy: [p.id] }));
  const r = compute({ currency: 'PHP', people, items, paidBy: { ben: 'ana', cara: 'ben' } });
  assert.deepEqual(by(r), { ana: 300, ben: 0, cara: 0, dan: 100 });
  assert.equal(r.people.find((p) => p.id === 'cara').coveredBy, 'ana');
});

test('a paying loop is ignored and flagged', () => {
  const items = people.slice(0, 2).map((p) => ({ id: p.id, name: 'Meal', price: 100, claimedBy: [p.id] }));
  const r = compute({ currency: 'PHP', people: people.slice(0, 2), items, paidBy: { ana: 'ben', ben: 'ana' } });
  assert.deepEqual(by(r), { ana: 100, ben: 100 });
  assert.ok(r.problems.some((p) => p.type === 'loop'));
});

test('extra put in is divided evenly among the rest', () => {
  const items = people.map((p) => ({ id: p.id, name: 'Meal', price: 1000, claimedBy: [p.id] }));
  const r = compute({ currency: 'PHP', people, items, putIn: { ana: 1600 } });
  assert.deepEqual(by(r), { ana: 1600, ben: 800, cara: 800, dan: 800 });
});

test('nobody drops below 0 and the leftover goes to the others', () => {
  const items = [
    { id: 'a', name: 'Feast', price: 2000, claimedBy: ['ana'] },
    { id: 'b', name: 'Soda', price: 50, claimedBy: ['ben'] },
    { id: 'c', name: 'Pasta', price: 600, claimedBy: ['cara'] },
    { id: 'd', name: 'Pasta', price: 600, claimedBy: ['dan'] },
  ];
  const r = compute({ currency: 'PHP', people, items, putIn: { ana: 2600 } });
  // 600 extra: Ben's slice of 200 covers his 50, the other 550 splits between Cara and Dan.
  assert.deepEqual(by(r), { ana: 2600, ben: 0, cara: 325, dan: 325 });
});

test('more than the whole bill comes back as change', () => {
  const items = [
    { id: 'a', name: 'Meal', price: 300, claimedBy: ['ana'] },
    { id: 'b', name: 'Meal', price: 200, claimedBy: ['ben'] },
  ];
  const r = compute({ currency: 'PHP', people: people.slice(0, 2), items, putIn: { ana: 1000 } });
  assert.equal(by(r).ben, 0);
  near(r.change, 500);
  near(r.people[0].changeBack, 500);
});

test('putting in less spreads the gap over the rest', () => {
  const items = people.slice(0, 3).map((p) => ({ id: p.id, name: 'Meal', price: 500, claimedBy: [p.id] }));
  const r = compute({ currency: 'PHP', people: people.slice(0, 3), items, putIn: { ana: 300 } });
  assert.deepEqual(by(r), { ana: 300, ben: 600, cara: 600 });
});

test('rounded amounts always add up to the bill', () => {
  const r = compute({
    currency: 'PHP', people: people.slice(0, 3),
    items: [{ id: 'i', name: 'Cake', price: 100, claimedBy: ['ana', 'ben', 'cara'] }],
    charges: [{ id: 't', name: 'Tip', unit: 'amount', value: 10, split: 'even' }],
  });
  const got = Object.values(by(r));
  near(got.reduce((a, b) => a + b, 0), 110);
  assert.deepEqual(roundShares([33.333, 33.333, 33.334], 2).reduce((a, b) => a + b, 0).toFixed(2), '100.00');
});

test('yen has no cents', () => {
  const r = compute({
    currency: 'JPY', people: people.slice(0, 3),
    items: [{ id: 'i', name: 'Course', price: 10000, claimedBy: ['ana', 'ben', 'cara'] }],
  });
  const got = Object.values(by(r)).sort();
  assert.deepEqual(got, [3333, 3333, 3334]);
});

test('unclaimed items and charges with nobody ticked are flagged', () => {
  const r = compute({
    currency: 'PHP', people: people.slice(0, 1),
    items: [{ id: 'i', name: 'Fries', price: 150, claimedBy: [] }],
    charges: [{ id: 'v', name: 'Venue', unit: 'amount', value: 100, excluded: ['ana'] }],
  });
  assert.deepEqual(r.problems.map((p) => p.type).sort(), ['nopayer', 'unclaimed']);
});
