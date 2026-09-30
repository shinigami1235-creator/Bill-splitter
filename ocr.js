// Reads a photo of a bill into item lines, charge lines and the printed
// total. Tesseract.js is self-hosted under vendor/tesseract and loads only on
// the first scan. parseReceipt has no DOM in it so tests can run it in Node.

const SKIP = /\b(sub\s*-?\s*total|subtotal|cash|change|tender(ed)?|card|visa|master\s*card|mastercard|amex|gcash|g-cash|maya|paymaya|promptpay|balance|vat\s*-?\s*able|vatable|vat\s*-?\s*exempt|exempt|zero\s*-?\s*rated|net\s+of\s+vat|net\s+sales|tin|tel|phone|mobile|date|time|table|tbl|pax|guests?|receipt|invoice|o\.?r\.?\s*(no|#)|s\.?i\.?\s*(no|#)|serial|ptu|pos|cashier|server|waiter|trans(action)?|terminal|acct|account|ref|qty|items?\s+sold|no\.\s*of|tax\s*id)\b/i;
const TOTAL = /\b(grand\s*total|total\s*amount|amount\s*due|total\s*due|total|net\s*amount|amount\s*payable)\b/i;
const DISCOUNT = /\b(disc|discount|less|senior|pwd|sc\s*\/\s*pwd|promo|voucher|coupon)\b/i;
const SERVICE = /\b(service|svc|serv\.?\s*ch(g|arge)?|s\s*\/\s*c|sc)\b/i;
const VAT = /\b(vat|tax|gst)\b/i;

// One token to an amount, or null. Handles 1,240.00 / 1.240,00 / 180,00 and
// the usual misreads of 0 and 1 inside a number.
export function readAmount(token) {
  if (!token) return null;
  let t = String(token).trim()
    .replace(/^(php|thb|usd|p|₱|฿|\$|€|£|¥)/i, '')
    .replace(/[:=]+$/, '');
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1); }
  if (/^-/.test(t)) { negative = true; t = t.slice(1); }
  if (/-$/.test(t)) { negative = true; t = t.slice(0, -1); }
  if (!/^[\dOoIl|.,]+$/.test(t)) return null;
  const digits = (t.match(/\d/g) || []).length;
  const letters = (t.match(/[OoIl|]/g) || []).length;
  if (!digits || letters > digits + 2) return null;
  t = t.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  if (/[.,]$/.test(t) || /^[.,]/.test(t)) return null;
  let hasDecimals = false;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    const whole = t.slice(0, dec).replace(/[.,]/g, '');
    const frac = t.slice(dec + 1);
    if (!/^\d{1,2}$/.test(frac)) return null;
    t = `${whole}.${frac}`;
    hasDecimals = true;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = t.split(sep);
    const tail = parts[parts.length - 1];
    if (tail.length === 2 || tail.length === 1) {
      t = `${parts.slice(0, -1).join('')}.${tail}`;
      hasDecimals = true;
    } else if (tail.length === 3 && parts.slice(1).every((p) => p.length === 3)) {
      t = parts.join('');
    } else {
      return null;
    }
  }
  const value = parseFloat(t);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, hasDecimals };
}

function tidyName(name) {
  return name
    .replace(/\s*@\s*[\d.,]+$/, '')
    .replace(/^[^A-Za-z0-9(]+/, '')
    .replace(/[\s.:\-_=@*]+$/, '')
    .replace(/^1\s*[xX×]?\s+(?=\D)/, '')
    .replace(/^(\d+)\s*[xX×]\s*/, '$1 × ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseReceipt(text, { currency = 'PHP' } = {}) {
  const items = [];
  const charges = [];
  const totals = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[\t ]+/g, ' ').trim();
    if (!line) continue;
    const toks = line.split(' ');
    // Drop VAT flags and similar letters printed after the price.
    while (toks.length > 1 && /^[A-Za-z*#]{1,2}$/.test(toks[toks.length - 1]) && !readAmount(toks[toks.length - 1])) toks.pop();
    const amount = readAmount(toks[toks.length - 1]);
    if (!amount) continue;
    toks.pop();
    // Quantity, unit price and line total: keep the line total.
    while (toks.length && readAmount(toks[toks.length - 1])?.hasDecimals) toks.pop();
    if (toks.length && /^@/.test(toks[toks.length - 1])) toks.pop();
    const name = tidyName(toks.join(' '));
    if (!/[A-Za-z฀-๿]{2,}/.test(name)) continue;
    if (TOTAL.test(name) && !/sub\s*-?\s*total/i.test(name) && !/\b(qty|items?|count|pax)\b/i.test(name)) {
      totals.push({ name, value: amount.value, grand: /grand|due|payable/i.test(name) });
      continue;
    }
    if (SKIP.test(name)) continue;
    if (DISCOUNT.test(name)) {
      charges.push({ kind: 'discount', name, amount: -Math.abs(amount.value) });
      continue;
    }
    if (SERVICE.test(name)) {
      charges.push({ kind: 'service', name, amount: amount.value });
      continue;
    }
    if (VAT.test(name)) {
      charges.push({ kind: 'vat', name, amount: amount.value });
      continue;
    }
    if (!amount.hasDecimals && (amount.value >= 100000 || /[:/#]/.test(line))) continue;
    if (amount.value === 0) continue;
    items.push({ name, price: amount.value });
  }

  let total = null;
  const grand = totals.filter((t) => t.grand);
  if (grand.length) total = grand[grand.length - 1].value;
  else if (totals.length) total = Math.max(...totals.map((t) => t.value));

  guessIncluded({ items, charges, total, currency });
  return { items, charges, total };
}

// Decide which charge lines are already inside the item prices. With a
// printed total, the combination that lands closest to it wins. Without one,
// Philippine VAT counts as inside the prices and everything else is added.
function guessIncluded({ items, charges, total, currency }) {
  const food = items.reduce((a, i) => a + i.price, 0);
  const flexible = charges.filter((c) => c.kind === 'service' || c.kind === 'vat');
  for (const c of charges) c.included = c.kind === 'vat' && currency === 'PHP';
  if (total === null || !flexible.length || flexible.length > 6) return;
  const fixedPart = charges.filter((c) => !flexible.includes(c)).reduce((a, c) => a + c.amount, 0);
  let best = null;
  for (let mask = 0; mask < 1 << flexible.length; mask++) {
    const added = flexible.reduce((a, c, i) => a + (mask & (1 << i) ? c.amount : 0), 0);
    const gap = Math.abs(food + fixedPart + added - total);
    if (!best || gap < best.gap - 1e-6) best = { mask, gap };
  }
  flexible.forEach((c, i) => { c.included = !(best.mask & (1 << i)); });
}

// ---- Browser side ----

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} could not be loaded.`));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = new URL('./vendor/tesseract/', document.baseURI).href;
      if (!window.Tesseract) await loadScript(`${base}tesseract.min.js`);
      const worker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}core`,
        langPath: `${base}lang`,
        workerBlobURL: false,
        logger: (m) => progressHandler && progressHandler(m),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  progressHandler = onProgress;
  return workerPromise;
}
let progressHandler = null;

// Grey, upscaled copy of the photo. Thermal print is small and faint, and
// Tesseract reads it far better at around 2000px on the long side.
async function prepare(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(2200 / long, 3);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1) contrast(1.35)';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas;
}

export async function scanBill(file, { currency, onProgress } = {}) {
  const say = (label, share) => onProgress && onProgress(label, share);
  say('Preparing the photo', 0.02);
  const canvas = await prepare(file);
  say('Loading the reader', 0.05);
  const worker = await getWorker((m) => {
    if (m.status === 'recognizing text') say('Reading the bill', 0.2 + m.progress * 0.8);
    else if (/load|initiali/i.test(m.status)) say('Loading the reader', 0.05 + (m.progress || 0) * 0.15);
  });
  const { data } = await worker.recognize(canvas);
  say('Reading the bill', 1);
  return { text: data.text, ...parseReceipt(data.text, { currency }) };
}
