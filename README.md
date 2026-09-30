# Bill splitter

A PWA for splitting the bill after a night out. It covers food, venue costs, tips, VAT and service charge, and works offline once installed on the phone.

## Steps

1. **People.** Type a name and press Enter to add the next one. Names separated by commas go in all at once.
2. **Bill.** Scan the bill with the camera, choose a photo, or type each item and price. The app adds up the lines and compares them with the total on the bill.
3. **Charges.** Service charge, VAT, tip, venue fee or anything else, each set as a percent or a fixed amount.
4. **Claim.** Press Start and pass the phone. Each person ticks what they had, including shared dishes, then presses Done and the next name comes up. The item list under it lets one person fix any item by tapping names, and Everyone ticks the whole table.
5. **Totals.** One amount per person with a breakdown under each. Adjust sets who pays for whom and what anyone is putting in. Copy the totals puts the list on the clipboard for the group chat.

The bill is kept on the phone until New bill is pressed twice. New bill keeps the names.

## The math

- An item is divided evenly among everyone who ticked it. A 600 platter ticked by three people costs each of them 200.
- Each charge has its own split. **Even per head** divides it equally. **By what each ordered** divides it in proportion to each person's food, so someone who only had water pays almost nothing of the service charge.
- A charge starts with everyone ticked under Who pays. Unticking a person moves their part onto the others still ticked.
- A percent charge is worked out on the food alone or on the food plus the charges above it. A Thai ++ bill needs Service charge 10% first and VAT 7% under it set to Food + charges above, which comes to 17.7% on top of the menu prices.
- Already in the prices shows the charge and adds nothing. Philippine VAT is usually already in the menu prices.
- Paid by moves that person's whole amount onto the payer, and they show 0. It follows through a chain, so if Ana pays for Ben and Ben pays for Cara, Ana pays all three.
- Putting in fixes what that person pays. Anything above their share is divided evenly among everyone else who still owes. When someone's slice is more than they owe, they drop to 0 and the leftover is divided again among the rest. Anything left after everyone reaches 0 shows as change back. An amount below their share spreads the gap evenly over the others.
- Rounded amounts add up to the bill exactly, with the leftover cents going to whoever was rounded down the most. Yen, won, rupiah and dong round to whole units.

## Reading the bill

Tesseract.js reads the photo in the browser, loaded from `vendor/tesseract` only when someone presses Scan. The first scan downloads about 7MB: the reader, one of the three engine builds under `core/` picked for the phone's processor, and the English data. The service worker keeps them for offline scans after that.

The photo is turned grey, raised in contrast and enlarged to about 2200px before reading. Each line ending in a price becomes an item. Lines naming the subtotal, cash, change, VATable sales, TIN, table and similar are skipped. Service, VAT and discount lines become charges. The line that says Total, Grand total or Amount due fills Total on the bill.

Service and VAT lines get Already in the prices ticked by whichever combination lands closest to the printed total. With no total read, Philippine VAT counts as in the prices and everything else is added.

Every line is editable before it goes in. A misread price shows up as a difference against the printed total.

## Files

- `index.html` markup and styles.
- `app.js` the screens.
- `split.js` the math, with no page code in it.
- `ocr.js` the photo reader and the line parser.
- `sw.js` the offline cache.
- `tests/` run with `node --test tests/*.test.mjs`. 18 tests covering the math and the receipt parser.

## Deploying

GitHub Pages, from the branch root. Bump `CACHE_VERSION` in `sw.js` on every deploy.

## Open decisions

- The app name, which is Bill splitter for now.
- Whether past bills are kept as a history.
- Hosting.
