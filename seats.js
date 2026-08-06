// Turning a seat layout into "sit here, both of you".
//
// This module knows nothing about Playwright and nothing about BookMyShow's
// payload shapes. It takes plain seat records - a row, a number, a status, and
// optionally where the seat physically sits in the hall - and answers the two
// questions the checker actually cares about:
//
//   1. which seats are free at this show;
//   2. which run of SEATS free seats *next to each other* is the best place to
//      watch the film from.
//
// Everything about "best" lives in scoreBlock() and is tunable, because taste
// is not a constant. The defaults put you a little past the middle of the hall
// and dead centre of the row, which is where a large-format screen looks right:
// far enough back that the frame fits in your field of view without a head
// turn, centred so the image is not keystoned and the sound stage is not
// lopsided.

export const AVAILABLE = 'available';
export const TAKEN = 'taken';
export const UNKNOWN = 'unknown';

export const DEFAULT_SCORING = {
  // 0 = front row, 1 = back row. Roughly two-thirds back, the usual
  // recommendation for a big screen, nudged forward a touch for IMAX.
  idealRowFraction: 0.62,
  rowWeight: 1.0,
  // Being off-centre sideways is more noticeable than being a row or two off,
  // so it costs more per unit of error.
  columnWeight: 1.4,
  // Rows in front of the sweet spot are worse than rows the same distance
  // behind it: too close means neck strain, too far just means smaller.
  frontRowPenalty: 1.7
};

// --- status ------------------------------------------------------------------

const AVAILABLE_WORDS =
  /^(available|vacant|free|open|empty|unsold|unoccupied|selectable|yes|y|a)$/i;
const TAKEN_WORDS =
  /^(sold|soldout|sold_?out|booked|occupied|unavailable|not_?available|blocked|reserved|filled|disabled|taken|social_?distance|no|n)$/i;

/**
 * Interpret whatever the layout called a status.
 *
 * The numeric convention is BookMyShow's own: SeatStatus "0" means the seat is
 * free and any other digit means it is not (sold, blocked, held). A layout that
 * numbers the other way round would read as fully booked rather than fully
 * free, which is the safe direction to be wrong in - it recommends nothing
 * instead of recommending a seat somebody else is sitting in.
 */
export function interpretStatus(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  if (typeof value === 'boolean') return UNKNOWN;   // meaning lives in the key
  const s = String(value).trim();
  if (!s) return UNKNOWN;
  if (/^-?\d+$/.test(s)) return Number(s) === 0 ? AVAILABLE : TAKEN;
  if (AVAILABLE_WORDS.test(s)) return AVAILABLE;
  if (TAKEN_WORDS.test(s)) return TAKEN;
  return UNKNOWN;
}

/**
 * Status from a CSS class list or test id, for layouts read out of the DOM.
 * "selected" counts as taken: it is not a seat this checker may claim.
 */
export function statusFromTokens(text) {
  if (!text) return UNKNOWN;
  // Class lists come in every house style there is - "_available", "seat--sold",
  // "isSelected", "seat_notAvailable" - so split on everything that is not a
  // letter or a digit and judge the words that fall out. "not available" is
  // glued back together first, or its second half would read as good news.
  const words = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/not[^a-z0-9]*available/g, 'unavailable')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  // The one-letter and yes/no spellings that interpretStatus accepts are left
  // out here: in a class list "a" and "n" are noise, not a seat's status.
  if (words.some((w) => /^(sold|soldout|booked|occupied|unavailable|blocked|reserved|filled|disabled|taken|selected)$/.test(w))) {
    return TAKEN;
  }
  if (words.some((w) => /^(available|vacant|free|empty|unsold|unoccupied|selectable)$/.test(w))) {
    return AVAILABLE;
  }
  return UNKNOWN;
}

// --- seat records ------------------------------------------------------------

const lower = (o) => {
  const m = new Map();
  for (const k of Object.keys(o)) m.set(k.toLowerCase(), o[k]);
  return m;
};

const pick = (map, names) => {
  for (const n of names) {
    const v = map.get(n);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const ROW_KEYS = ['rowlabel', 'rowname', 'seatrow', 'row', 'rowid'];
const NUM_KEYS = ['seatlabel', 'seatnumber', 'seatno', 'seatname', 'seatnsm',
                  'number', 'label', 'name'];
const COL_KEYS = ['colindex', 'seatcol', 'column', 'col', 'seatposition', 'pos'];
const STATUS_KEYS = ['seatstatus', 'status', 'seatstate', 'state', 'availability'];
const CATEGORY_KEYS = ['categoryname', 'category', 'seattype', 'classname',
                       'areaname', 'areadesc', 'section', 'sectionlabel'];
const PRICE_KEYS = ['price', 'seatprice', 'amount', 'ticketprice'];

// Boolean keys, and what `true` means for each.
const BOOLEAN_KEYS = [
  ['isavailable', AVAILABLE], ['available', AVAILABLE], ['isfree', AVAILABLE],
  ['isvacant', AVAILABLE], ['isselectable', AVAILABLE],
  ['isbooked', TAKEN], ['issold', TAKEN], ['isoccupied', TAKEN],
  ['isblocked', TAKEN], ['isdisabled', TAKEN], ['isreserved', TAKEN]
];

/** "H12" -> { row: "H", number: 12 }; "12" -> { row: undefined, number: 12 } */
function splitSeatLabel(label) {
  const m = /^\s*([A-Za-z]{0,3})[\s-]*(\d{1,3})\s*$/.exec(String(label ?? ''));
  if (!m) return {};
  return { row: m[1] || undefined, number: Number(m[2]) };
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Normalise one raw record into a seat, or return null if it does not look like
 * one. Records come from three different places (a JSON payload, the page's
 * embedded state, the rendered DOM) and none of them agree on key names, so
 * every field is looked up by a list of aliases.
 */
export function toSeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = lower(raw);

  let status = interpretStatus(pick(m, STATUS_KEYS));
  if (status === UNKNOWN) {
    for (const [key, meaning] of BOOLEAN_KEYS) {
      const v = m.get(key);
      if (typeof v === 'boolean') {
        status = v ? meaning : (meaning === AVAILABLE ? TAKEN : AVAILABLE);
        break;
      }
    }
  }
  if (status === UNKNOWN) status = statusFromTokens(pick(m, ['statushint', 'classname', 'class']));

  const rawLabel = pick(m, NUM_KEYS);
  const parts = splitSeatLabel(rawLabel);
  const rowLabel = String(pick(m, ROW_KEYS) ?? parts.row ?? '').trim().toUpperCase();
  const seatNumber = num(pick(m, ['seatnumber', 'number'])) ?? parts.number;
  const col = num(pick(m, COL_KEYS)) ?? seatNumber;

  const x = num(pick(m, ['x', 'left', 'cx']));
  const y = num(pick(m, ['y', 'top', 'cy']));

  // A record needs an identity (row/number) or a position; without either it
  // cannot be placed in the hall and is not a seat as far as we are concerned.
  const hasIdentity = rowLabel !== '' || seatNumber !== undefined;
  const hasPosition = x !== undefined && y !== undefined;
  if (!hasIdentity && !hasPosition) return null;
  if (status === UNKNOWN && !hasIdentity) return null;

  const label = rawLabel !== undefined && String(rawLabel).trim() !== ''
    ? String(rawLabel).trim()
    : (seatNumber !== undefined ? String(seatNumber) : '?');

  return {
    rowLabel,
    label,
    number: seatNumber,
    col,
    x, y,
    status,
    category: pick(m, CATEGORY_KEYS) ? String(pick(m, CATEGORY_KEYS)).trim() : undefined,
    price: num(pick(m, PRICE_KEYS))
  };
}

// --- layout ------------------------------------------------------------------

/** A, B, ... Z, AA - so row Z sorts before row AA, unlike a plain string sort. */
export function compareRowLabels(a, b) {
  const A = String(a).toUpperCase(), B = String(b).toUpperCase();
  const na = Number(A), nb = Number(B);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (A.length !== B.length) return A.length - B.length;
  return A < B ? -1 : A > B ? 1 : 0;
}

const median = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

/**
 * Group seats into rows ordered front-to-back, each row ordered left-to-right.
 *
 * Ordering front-to-back is the one thing a seat map cannot tell us for
 * certain. With coordinates it is unambiguous - the screen is at the top of
 * every seat layout ever drawn, so a smaller y is nearer the screen. Without
 * them we fall back on the Indian multiplex convention of row A at the front,
 * which `rowOrder` can override when a hall numbers itself the other way.
 *
 * @param records raw seat-ish objects
 * @param rowOrder 'auto' | 'front-first' | 'back-first'
 */
export function buildLayout(records, { rowOrder = 'auto' } = {}) {
  const seats = [];
  for (const r of records || []) {
    const s = toSeat(r);
    if (s) seats.push(s);
  }

  const geometric = seats.length > 0 && seats.every((s) => s.x !== undefined && s.y !== undefined);

  // Rows come from the row label only when *every* seat has one. A half
  // labelled map is the normal case for a map read off the screen - the reader
  // finds a row's letter only where the hall draws one - and grouping those by
  // label would tip every unlabelled row into a single '?' row spanning the
  // auditorium. Seats in different rows would then sit next to each other in
  // that row's seat list, and "two together" could mean two seats ten metres
  // apart. Coordinates settle it whenever they are there; a label that turns
  // up inside a cluster is then only used to name it.
  const groups = new Map();
  const allLabelled = seats.length > 0 && seats.every((s) => s.rowLabel);
  if (allLabelled || (!geometric && seats.some((s) => s.rowLabel))) {
    for (const s of seats) {
      const key = s.rowLabel || '?';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
  } else {
    const ys = [...seats].map((s) => s.y).sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 0);
    const tol = Math.max(1, (median(gaps) ?? 1) * 0.6);
    let key = 0, last = null;
    for (const s of [...seats].sort((a, b) => a.y - b.y)) {
      if (last !== null && s.y - last > tol) key++;
      last = s.y;
      const name = String(key);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(s);
    }
  }

  let rows = [...groups.entries()].map(([label, rowSeats]) => {
    const ordered = [...rowSeats].sort((a, b) => {
      if (geometric) return a.x - b.x;
      if (a.col !== undefined && b.col !== undefined) return a.col - b.col;
      return compareRowLabels(a.label, b.label);
    });
    return {
      // A cluster keeps the row letter of any seat in it that carries one, so
      // the email can still say "Row H" rather than "row 8 from the screen".
      label: ordered.find((s) => s.rowLabel)?.rowLabel ?? label,
      seats: ordered,
      y: median(ordered.map((s) => s.y).filter((v) => v !== undefined)),
      category: ordered.find((s) => s.category)?.category
    };
  });

  if (geometric && rows.every((r) => r.y !== undefined)) {
    rows.sort((a, b) => a.y - b.y);            // top of the map = the screen
  } else {
    rows.sort((a, b) => compareRowLabels(a.label, b.label));
  }
  if (rowOrder === 'back-first') rows.reverse();

  rows.forEach((r, i) => { r.index = i; });     // 0 = nearest the screen

  // A map drawn without seat numbers - an SVG grid of plain rectangles is the
  // usual culprit - leaves seats with a position and no name, and an email
  // reading "seats ?, ?" helps nobody. Number them from the left of their row.
  // Adjacency still comes from the coordinates, so a counted number never
  // bridges an aisle; it is a label, not a claim about the hall's numbering.
  let countedNumbers = false;
  for (const row of rows) {
    row.seats.forEach((s, i) => {
      if (s.number !== undefined) return;
      s.number = i + 1;
      s.col = s.col ?? i + 1;
      if (s.label === '?' || s.label === '') {
        s.label = String(i + 1);
        countedNumbers = true;
      }
    });
  }

  const all = rows.flatMap((r) => r.seats);
  const available = all.filter((s) => s.status === AVAILABLE);
  const byCategory = new Map();
  for (const s of all) {
    const key = s.category || 'All seats';
    const c = byCategory.get(key) || { category: key, total: 0, available: 0, price: s.price };
    c.total++;
    if (s.status === AVAILABLE) c.available++;
    if (c.price === undefined) c.price = s.price;
    byCategory.set(key, c);
  }

  return {
    rows,
    geometric,
    countedNumbers,
    rowCount: rows.length,
    total: all.length,
    available: available.length,
    unknown: all.filter((s) => s.status === UNKNOWN).length,
    categories: [...byCategory.values()].sort((a, b) => b.available - a.available),
    minX: geometric ? Math.min(...all.map((s) => s.x)) : undefined,
    maxX: geometric ? Math.max(...all.map((s) => s.x)) : undefined
  };
}

// --- picking -----------------------------------------------------------------

/**
 * Are these two seats actually side by side, with no aisle between them?
 *
 * Coordinates settle it when we have them: an aisle shows up as a gap much
 * wider than the seat pitch. Otherwise consecutive column indices (or seat
 * numbers) have to do, which is the convention every layout in this codebase's
 * experience follows - an aisle takes a column index with it.
 */
function adjacent(a, b, pitch) {
  if (a.x !== undefined && b.x !== undefined && pitch) {
    return b.x - a.x <= pitch * 1.5;
  }
  if (a.col !== undefined && b.col !== undefined) return b.col - a.col === 1;
  if (a.number !== undefined && b.number !== undefined) return b.number - a.number === 1;
  return false;
}

/** The typical centre-to-centre distance between neighbouring seats in a row. */
function seatPitch(row) {
  const xs = row.seats.map((s) => s.x).filter((v) => v !== undefined).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]).filter((g) => g > 0);
  return median(gaps);
}

/** Every run of exactly `count` free, adjacent seats in this row. */
function blocksInRow(row, count) {
  const pitch = seatPitch(row);
  const out = [];
  const free = [];
  for (const s of row.seats) {
    if (s.status !== AVAILABLE) { free.length = 0; continue; }
    if (free.length && !adjacent(free[free.length - 1], s, pitch)) free.length = 0;
    free.push(s);
    if (free.length >= count) out.push(free.slice(free.length - count));
  }
  return out.map((seats) => ({ row, seats }));
}

/** The longest run of free adjacent seats anywhere, used when `count` will not fit. */
function longestRun(layout) {
  let best = 0;
  for (const row of layout.rows) {
    const pitch = seatPitch(row);
    let run = 0;
    let prev = null;
    for (const s of row.seats) {
      if (s.status !== AVAILABLE) { run = 0; prev = null; continue; }
      run = prev && adjacent(prev, s, pitch) ? run + 1 : 1;
      prev = s;
      if (run > best) best = run;
    }
  }
  return best;
}

/**
 * How good a place to watch from is this block? Lower is better.
 *
 * Two independent misses, added: how far the row is from the sweet spot depth,
 * and how far the block's centre is from the centre line of the hall. Sideways
 * error is weighted heavier, and rows in front of the sweet spot are penalised
 * harder than rows behind it.
 */
export function scoreBlock(block, layout, scoring = DEFAULT_SCORING) {
  const opts = { ...DEFAULT_SCORING, ...scoring };
  const rowFrac = layout.rowCount > 1
    ? block.row.index / (layout.rowCount - 1)
    : 0.5;

  let colFrac = 0.5;
  if (layout.geometric && layout.maxX > layout.minX) {
    const centre = block.seats.reduce((a, s) => a + s.x, 0) / block.seats.length;
    colFrac = (centre - layout.minX) / (layout.maxX - layout.minX);
  } else if (block.row.seats.length > 1) {
    const idx = block.seats.map((s) => block.row.seats.indexOf(s));
    const centre = idx.reduce((a, i) => a + i, 0) / idx.length;
    colFrac = centre / (block.row.seats.length - 1);
  }

  const rowMiss = rowFrac - opts.idealRowFraction;
  const rowPenalty = Math.abs(rowMiss) * (rowMiss < 0 ? opts.frontRowPenalty : 1);
  const colPenalty = Math.abs(colFrac - 0.5);

  return {
    score: opts.rowWeight * rowPenalty + opts.columnWeight * colPenalty,
    rowFrac,
    colFrac
  };
}

function sideways(colFrac) {
  const off = colFrac - 0.5;
  if (Math.abs(off) < 0.05) return 'dead centre';
  if (Math.abs(off) < 0.15) return off < 0 ? 'just left of centre' : 'just right of centre';
  return off < 0 ? 'left of centre' : 'right of centre';
}

function depth(rowFrac, rowCount, rowIndex) {
  const pct = Math.round(rowFrac * 100);
  const back = rowCount - rowIndex;
  if (rowIndex === 0) return 'front row';
  if (back === 1) return 'back row';
  return `${pct}% of the way back`;
}

/**
 * Naming the row.
 *
 * A hall read from pixels alone has no row letters, only an order, and "Row 6"
 * would look like a row named 6. Say what it actually is: the sixth row back.
 */
export const rowName = (block) => /^\d+$/.test(String(block.row))
  ? `row ${block.rowIndex + 1} from the screen`
  : `Row ${block.row}`;

/** "11-12", or "11, 14" if the run is not numerically consecutive. */
export function seatRange(seats) {
  const labels = seats.map((s) => s.label);
  if (seats.length > 1 && seats.every((s) => s.number !== undefined)) {
    const consecutive = seats.every((s, i) => i === 0 || s.number - seats[i - 1].number === 1);
    if (consecutive) return `${labels[0]}-${labels[labels.length - 1]}`;
  }
  return labels.join(', ');
}

/**
 * Best places to sit `count` people together.
 *
 * Returns the best block per row, best first, so the alternatives are genuinely
 * different seats rather than the same block shifted one along. When `count`
 * seats will not fit together anywhere, `blocks` is empty and `largestRun` says
 * how many do fit, which is the useful thing to put in the email.
 */
export function recommendSeats(layout, count, { scoring, limit = 3 } = {}) {
  const wanted = Math.max(1, Math.floor(count));
  const scored = [];

  for (const row of layout.rows) {
    let bestInRow = null;
    for (const block of blocksInRow(row, wanted)) {
      const s = scoreBlock(block, layout, scoring);
      const entry = {
        row: row.label,
        rowIndex: row.index,
        seats: block.seats,
        labels: seatRange(block.seats),
        category: block.seats.find((x) => x.category)?.category || row.category,
        price: block.seats.find((x) => x.price !== undefined)?.price,
        ...s
      };
      // Mirror-image blocks either side of a central aisle score identically.
      // Break those ties on seat number so the same hall always produces the
      // same recommendation, rather than one that flickers run to run.
      const better = !bestInRow || entry.score < bestInRow.score - 1e-9 ||
        (Math.abs(entry.score - bestInRow.score) <= 1e-9 &&
         (entry.seats[0].number ?? 0) < (bestInRow.seats[0].number ?? 0));
      if (better) bestInRow = entry;
    }
    if (bestInRow) scored.push(bestInRow);
  }

  scored.sort((a, b) =>
    (a.score - b.score) ||
    (a.rowIndex - b.rowIndex) ||
    ((a.seats[0].number ?? 0) - (b.seats[0].number ?? 0)));
  const blocks = scored.slice(0, limit).map((b) => ({
    ...b,
    why: `${depth(b.rowFrac, layout.rowCount, b.rowIndex)}, ${sideways(b.colFrac)}`
  }));

  return {
    wanted,
    blocks,
    rowsWithSpace: scored.length,
    largestRun: blocks.length ? wanted : longestRun(layout),
    summary: {
      total: layout.total,
      available: layout.available,
      unknown: layout.unknown,
      rowCount: layout.rowCount,
      countedNumbers: layout.countedNumbers,
      categories: layout.categories
    }
  };
}

// --- email copy --------------------------------------------------------------

const money = (n) => (n === undefined ? '' : ` (Rs ${Math.round(n)} each)`);

/**
 * The seat section of the alert email. Written to be read on a phone, in a
 * hurry, by somebody who is about to book: the answer first, the evidence
 * after it.
 */
export function formatSeatReport(report, { showLabel, venue, seatUrl } = {}) {
  const lines = [];
  const where = [showLabel, venue].filter(Boolean).join(' - ');

  if (!report.ok) {
    lines.push(where ? `Seats at ${where}: could not be read.` : 'Seats: could not be read.');
    lines.push(`Reason: ${report.reason}`);
    return lines;
  }

  const { wanted, blocks, summary } = report.recommendation;
  lines.push(where ? `Seats at ${where}` : 'Seats');
  lines.push('-'.repeat(Math.min(60, (where ? `Seats at ${where}` : 'Seats').length)));

  if (blocks.length === 0) {
    lines.push(`No ${wanted} free seats together.` +
      (report.recommendation.largestRun > 0
        ? ` The longest run of free seats next to each other is ${report.recommendation.largestRun}.`
        : ' Nothing is free.'));
  } else {
    lines.push(`Best ${wanted} seats together:`);
    blocks.forEach((b, i) => {
      const where = rowName(b);
      lines.push(`  ${i + 1}. ${where.charAt(0).toUpperCase()}${where.slice(1)}, ` +
        `seat${b.seats.length > 1 ? 's' : ''} ${b.labels}${money(b.price)}`);
      lines.push(`     ${b.why}${b.category ? ` - ${b.category}` : ''}`);
    });
    if (report.recommendation.rowsWithSpace > blocks.length) {
      lines.push(`  (${report.recommendation.rowsWithSpace} rows have ${wanted} together;` +
        ` the top ${blocks.length} are listed)`);
    }
  }

  const pct = summary.total ? Math.round((summary.available / summary.total) * 100) : 0;
  lines.push('');
  lines.push(`Availability: ${summary.available} of ${summary.total} seats free (${pct}%),` +
    ` ${summary.rowCount} rows.`);
  for (const c of summary.categories.slice(0, 6)) {
    lines.push(`  ${c.category}: ${c.available} of ${c.total} free` +
      (c.price !== undefined ? ` (Rs ${Math.round(c.price)})` : ''));
  }
  if (summary.countedNumbers) {
    lines.push('  The map showed no seat numbers, so these are counted from the' +
      ' left of the row as you face the screen.');
  }
  if (summary.unknown) {
    lines.push(`  ${summary.unknown} seat(s) had a status this checker could not read` +
      ` and were treated as taken.`);
  }
  if (summary.available === summary.total && summary.total > 0) {
    lines.push('  Every seat reads as free - the show may have only just opened.');
  }
  if (seatUrl) {
    lines.push('');
    lines.push(`Seat layout: ${seatUrl}`);
  }
  return lines;
}
