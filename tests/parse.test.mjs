// node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, readAmount } from '../ocr.js';

test('amount formats', () => {
  assert.deepEqual(readAmount('1,240.00'), { value: 1240, hasDecimals: true });
  assert.deepEqual(readAmount('1.240,50'), { value: 1240.5, hasDecimals: true });
  assert.deepEqual(readAmount('180,00'), { value: 180, hasDecimals: true });
  assert.deepEqual(readAmount('1,240'), { value: 1240, hasDecimals: false });
  assert.deepEqual(readAmount('35O.OO'), { value: 350, hasDecimals: true });
  assert.deepEqual(readAmount('(50.00)'), { value: -50, hasDecimals: true });
  assert.deepEqual(readAmount('P450.00'), { value: 450, hasDecimals: true });
  assert.equal(readAmount('17:38'), null);
  assert.equal(readAmount('30/09/2026'), null);
  assert.equal(readAmount('Tea'), null);
});

const ph = `
MESA FILIPINO MOMENTS
SM Megamall, Mandaluyong
TIN 123-456-789-000
OR # 004512   Table 12   Pax 4
Date 09/30/2026 19:42
1 Crispy Pata          1,195.00
2 Iced Tea    95.00    190.00
1 Sinigang na Hipon      585.00
1 Garlic Rice x3         165.00
1 Leche Flan             155.00
Subtotal               2,290.00
Service Charge 10%       204.46
VATable Sales          2,044.64
VAT 12%                  245.36
TOTAL                  2,494.46
Cash                   3,000.00
Change                   505.54
`;

test('Philippine receipt: items, service added, VAT inside the prices', () => {
  const r = parseReceipt(ph, { currency: 'PHP' });
  assert.deepEqual(r.items.map((i) => [i.name, i.price]), [
    ['Crispy Pata', 1195],
    ['2 Iced Tea', 190],
    ['Sinigang na Hipon', 585],
    ['Garlic Rice x3', 165],
    ['Leche Flan', 155],
  ]);
  assert.equal(r.total, 2494.46);
  const svc = r.charges.find((c) => c.kind === 'service');
  const vat = r.charges.find((c) => c.kind === 'vat');
  assert.equal(svc.amount, 204.46);
  assert.equal(svc.included, false);
  assert.equal(vat.included, true);
});

const th = `
BAAN KHANITHA
Table 7  Guests 3
Tom Yum Goong        320
Green Curry Chicken  280
Pad Thai             180
Singha Beer 2 @ 120  240
Sub Total           1020
Service Charge 10%   102
VAT 7%             78.54
Grand Total      1200.54
`;

test('Thai ++ receipt: service and VAT both added', () => {
  const r = parseReceipt(th, { currency: 'THB' });
  assert.deepEqual(r.items.map((i) => [i.name, i.price]), [
    ['Tom Yum Goong', 320],
    ['Green Curry Chicken', 280],
    ['Pad Thai', 180],
    ['Singha Beer 2', 240],
  ]);
  assert.equal(r.total, 1200.54);
  assert.ok(r.charges.every((c) => c.included === false));
});

test('senior discount comes through as a negative charge', () => {
  const r = parseReceipt('Kare Kare 520.00\nSenior Disc 20%  (92.86)\nTotal 427.14', { currency: 'PHP' });
  assert.equal(r.charges[0].kind, 'discount');
  assert.equal(r.charges[0].amount, -92.86);
});
