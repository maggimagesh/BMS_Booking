// Getting a seat layout out of BookMyShow, in the browser that is already open.
//
// The date strip and the showtime list both ship inside the HTML, but the seat
// map does not: it is drawn after you pick a show. So this module drives the
// live page - click the showtime, wait for the seat map, read it - and harvests
// from three places at once, because any one of them can be the one that works:
//
//   1. the JSON that comes back over the network while the seat page loads;
//   2. the seat page's own embedded state (__INITIAL_STATE__ / __NEXT_DATA__);
//   3. the rendered DOM, measured.
//
// (3) deserves a word. Reading pixels sounds like the fragile option and is in
// fact the sturdiest one here: a seat map is a grid of small boxes with the
// screen at the top, and that stays true through any amount of renaming of
// JSON fields. It also gives real geometry, which is what tells the seat picker
// where the aisles are and which seats are actually in the middle of the hall.
//
// Nothing here logs in, holds, or books a seat. It reads the page a person
// would be looking at and then closes the browser.

import fs from 'fs';
import path from 'path';
import { rand } from './stealth.js';
import { buildLayout, recommendSeats } from './seats.js';

const SEAT_KEY_HINT = /("seatStatus"|"SeatStatus"|"seatLayout"|"SeatLayout"|"seats"\s*:\s*\[|"seatNumber"|"SeatNsm")/;

/**
 * The readable part of an error message.
 *
 * Playwright attaches a call log and terminal colour codes to its errors. All
 * of that ends up in the alert email, where the first line is the only part
 * anybody reads and the escape codes are just noise.
 */
export const brief = (message) => String(message ?? '')
  .replace(/\u001b?\[[0-9;]*m/g, '')     // with or without the escape byte
  .split('\n')[0]
  .trim()
  .slice(0, 200);

/** Does this JSON blob look like it contains a seat map at all? */
const looksLikeSeatData = (text) =>
  text.length > 200 && text.length < 12_000_000 && SEAT_KEY_HINT.test(text);

/**
 * Pull seat-shaped objects out of an arbitrary JSON tree.
 *
 * "Seat-shaped" means: has a status-ish field and an identity-ish field, and no
 * children of its own. Deliberately loose - seats.js re-checks every candidate
 * and drops what it cannot place.
 */
const STATUS_FIELD =
  /^(seatstatus|status|seatstate|isavailable|available|isbooked|issold|isoccupied|isblocked)$/i;
const IDENTITY_FIELD =
  /^(seatnumber|seatno|seatname|seatnsm|seatlabel|seatcol|seatrow|rowname|rowlabel|number|col)$/i;

const isSeatObject = (node) => {
  const keys = Object.keys(node);
  if (!keys.some((k) => STATUS_FIELD.test(k))) return false;
  if (!keys.some((k) => IDENTITY_FIELD.test(k))) return false;
  // A seat is a leaf: anything with populated children is the row or the block
  // that holds seats, not a seat.
  return !Object.values(node).some(
    (v) => v && typeof v === 'object' && Object.keys(v).length > 0);
};

/** Row name, category and price are named once on the container, not per seat. */
const withContext = (ctx, node) => {
  let next = ctx;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'object') continue;
    if (/^(categoryname|category|classname|areadesc|areaname|section)$/i.test(key)) {
      next = { ...next, category: value };
    } else if (/^(rowname|rowlabel|seatrow)$/i.test(key)) {
      next = { ...next, rowLabel: value };
    } else if (/^(price|seatprice|ticketprice)$/i.test(key)) {
      next = { ...next, price: value };
    }
  }
  return next;
};

export function harvestSeatObjects(root, limit = 20000) {
  const out = [];
  const stack = [{ node: root, depth: 0, ctx: {} }];

  while (stack.length && out.length < limit) {
    const { node, depth, ctx } = stack.pop();
    if (!node || typeof node !== 'object' || depth > 40) continue;

    let next = ctx;
    if (!Array.isArray(node)) {
      if (isSeatObject(node)) {
        out.push({ ...ctx, ...node });     // the seat's own fields win
        continue;
      }
      next = withContext(ctx, node);
    }

    for (const value of Array.isArray(node) ? node : Object.values(node)) {
      if (value && typeof value === 'object') {
        stack.push({ node: value, depth: depth + 1, ctx: next });
      }
    }
  }
  return out;
}

// --- the DOM reader ----------------------------------------------------------
//
// Runs inside the page. Written as a plain function so page.evaluate can
// serialise it; it cannot close over anything in this file.

/* c8 ignore start - executes in the browser, not in Node */
function scanSeatElements() {
  // Never el.className: on an SVG element that is an SVGAnimatedString, which
  // stringifies to "[object SVGAnimatedString]" and takes the seat's real
  // classes with it. Plenty of seat maps are drawn in SVG, and a seat whose
  // classes are lost reads as status unknown, which counts as taken.
  const classOf = (el) => el.getAttribute('class') || '';

  const isSeatish = (el) => {
    const bag = `${classOf(el)} ${el.id || ''} ` +
      `${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-cy') || ''}`;
    return /seat/i.test(bag);
  };

  const nodes = [...document.querySelectorAll('*')].filter((el) => {
    if (!isSeatish(el)) return false;
    if (el.querySelector('*')) return false;          // seats are leaves
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.width < 80 && r.height > 4 && r.height < 80;
  });

  // Only an element's *own* text, never its descendants': the container that
  // names a category also contains the seats, and textContent would hand back
  // "GOLD123456789..." - a category name with the whole row glued to it.
  const ownText = (el) => [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim())
    .join(' ')
    .trim();

  const isName = (t) => t && t.length < 40 && /[a-z]/i.test(t) &&
    (t.replace(/[^0-9]/g, '').length / t.length) < 0.4;

  const sectionLabel = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      const bag = `${classOf(p)} ${p.getAttribute('data-testid') || ''}`;
      if (!/(category|section|tier|zone|class)/i.test(bag)) continue;
      const own = ownText(p);
      if (isName(own)) return own.split('\n')[0].trim();
      // The name is often a heading beside the seats rather than loose text.
      for (const kid of p.children) {
        if (isSeatish(kid)) continue;
        const t = ownText(kid);
        if (isName(t)) return t;
      }
    }
    return undefined;
  };

  // Halls label their rows once, in an element at the end of the row rather
  // than on every seat. Without it the rows are only "sixth from the screen",
  // which is true but not something you can tell the person at the counter.
  const rowLabel = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const kids = [...p.children];
      if (kids.filter(isSeatish).length < 3) continue;
      for (const kid of kids) {
        if (isSeatish(kid)) continue;
        const t = ownText(kid) || (kid.textContent || '').trim();
        if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase();
      }
      return undefined;
    }
    return undefined;
  };

  return nodes.map((el) => {
    const r = el.getBoundingClientRect();
    const classes = `${classOf(el)} ${el.getAttribute('data-status') || ''} ` +
      `${el.getAttribute('data-testid') || ''}`;
    return {
      label: (el.textContent || '').trim() ||
        el.getAttribute('aria-label') || el.getAttribute('title') || '',
      statusHint: `${classes} ${el.getAttribute('aria-disabled') === 'true' ? 'disabled' : ''}`,
      rowLabel: rowLabel(el),
      category: sectionLabel(el),
      x: Math.round(r.left + window.scrollX + r.width / 2),
      y: Math.round(r.top + window.scrollY + r.height / 2)
    };
  }).filter((s) => s.label || s.statusHint.trim());
}
/* c8 ignore stop */

// --- driving the page --------------------------------------------------------

const absolute = (url, base) => {
  try { return new URL(url, base).toString(); } catch { return null; }
};

/**
 * Click the showtime in the rendered page.
 *
 * The showtime list often does not render for an automated client (the
 * client-side showtimes call is refused), in which case there is nothing to
 * click and this returns false - the caller then has a reason to report rather
 * than a mystery.
 */
async function clickShowtime(page, show) {
  const label = show.label.replace(/\s+/g, ' ');
  const variants = [label, label.replace(' ', ''), label.replace(/^0/, '')];
  for (const text of variants) {
    const target = page.getByText(text, { exact: false }).first();
    try {
      if (await target.count() === 0) continue;
      await target.scrollIntoViewIfNeeded({ timeout: 5000 });
      await target.click({ timeout: 10000 });
      return true;
    } catch {
      // try the next spelling of the time
    }
  }
  return false;
}

async function dump(page, dir, label) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe = label.replace(/[^\w.-]+/g, '_');
    await page.screenshot({ path: path.join(dir, `${safe}.png`), fullPage: true });
    fs.writeFileSync(path.join(dir, `${safe}.html`), await page.content());
  } catch {
    // debug artefacts are a nicety; never let them fail the run
  }
}

/**
 * Open a show's seat map and recommend where to sit.
 *
 * Returns { ok: false, reason } rather than throwing: a seat map we cannot read
 * must not cost the caller its "tickets are open" email. That email is the
 * whole point of the checker and it goes out either way.
 *
 * @param page    a live Playwright page on the showtimes URL
 * @param show    from readShowtimes(): { label, venue, url, sessionId }
 * @param options seats, scoring, debugDir, baseUrl, log
 */
export async function inspectSeats(page, show, options = {}) {
  const {
    seats = 2, scoring, limit = 3, rowOrder = 'auto', debugDir = null,
    baseUrl = page.url(), log = () => {}
  } = options;

  const captured = [];
  const onResponse = async (res) => {
    try {
      const type = res.headers()['content-type'] || '';
      if (!/json/i.test(type)) return;
      const text = await res.text();
      if (looksLikeSeatData(text)) captured.push({ url: res.url(), text });
    } catch {
      // a response body that has gone away is not an error worth reporting
    }
  };

  page.on('response', onResponse);
  try {
    // Prefer the show's own link; fall back to clicking it in the page.
    const target = show.url ? absolute(show.url, baseUrl) : null;
    if (target) {
      log(`   opening seat layout: ${target}`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      log(`   clicking the ${show.label} show`);
      if (!await clickShowtime(page, show)) {
        return { ok: false, reason: `the ${show.label} show could not be opened ` +
          `(no link in the page state, and nothing clickable in the rendered page)` };
      }
    }

    // Seat maps are drawn client-side and animate in; give it a moment, then a
    // best-effort wait for something seat-shaped to exist.
    await page.waitForTimeout(rand(2500, 4000));
    await page.waitForSelector('[class*="seat" i], [data-testid*="seat" i]', { timeout: 15000 })
      .catch(() => {});

    const seatUrl = page.url();
    const records = [];
    let source = null;

    // 1. network JSON
    for (const cap of captured) {
      try {
        const found = harvestSeatObjects(JSON.parse(cap.text));
        if (found.length > records.length) {
          records.length = 0;
          records.push(...found);
          source = `network response ${new URL(cap.url).pathname}`;
        }
      } catch {
        // not JSON after all
      }
    }

    // 2. the seat page's embedded state
    if (records.length === 0) {
      const state = await page.evaluate(() => {
        const s = window.__INITIAL_STATE__ ?? window.__NEXT_DATA__ ?? null;
        try { return s ? JSON.parse(JSON.stringify(s)) : null; } catch { return null; }
      }).catch(() => null);
      if (state) {
        const found = harvestSeatObjects(state);
        if (found.length) { records.push(...found); source = 'page state'; }
      }
    }

    // 3. the rendered seat map, measured
    if (records.length === 0) {
      const found = await page.evaluate(scanSeatElements).catch(() => []);
      if (found.length) { records.push(...found); source = 'rendered seat map'; }
    }

    if (records.length === 0) {
      await dump(page, debugDir, `seatmap-empty-${show.label}`);
      return { ok: false, reason: 'no seat map on the page (it may need a login, ' +
        'or the show may not be open for booking yet)', seatUrl };
    }

    const layout = buildLayout(records, { rowOrder });
    if (layout.total === 0) {
      await dump(page, debugDir, `seatmap-unreadable-${show.label}`);
      return { ok: false, reason: `found ${records.length} seat-shaped records but ` +
        `none could be placed in a row`, seatUrl };
    }

    log(`   read ${layout.total} seats in ${layout.rowCount} rows from ${source}` +
      ` (${layout.available} free)`);

    return {
      ok: true,
      source,
      seatUrl,
      show,
      layout,
      recommendation: recommendSeats(layout, seats, { scoring, limit })
    };
  } catch (e) {
    await dump(page, debugDir, `seatmap-error-${show.label}`);
    return { ok: false, reason: `seat layout could not be opened: ${brief(e.message)}` };
  } finally {
    page.off('response', onResponse);
  }
}
