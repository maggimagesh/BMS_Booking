// Tests for the parts that decide where you sit.
//
// The live site cannot be tested from here - it is behind Cloudflare and only
// answers a real browser - so the fixtures below are the shapes BookMyShow is
// known to use: numeric SeatStatus with "0" meaning free, seats nested under a
// row that names itself, and a measured DOM where the only truth is pixels.
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLayout, recommendSeats, interpretStatus, statusFromTokens,
  seatRange, formatSeatReport, AVAILABLE, TAKEN, UNKNOWN
} from '../seats.js';
import { harvestSeatObjects, brief } from '../seatmap.js';
import {
  parseClockTime, clockLabel, readShowtimes, pickShowNearest, readSelectedDate,
  showtimeSignature, verifySchedule, analyseState
} from '../extract.js';

// --- helpers ----------------------------------------------------------------

/** A hall: `rows` rows of `cols` seats, with `taken` given as "H12" labels. */
function hall(rows, cols, taken = []) {
  const gone = new Set(taken);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = String.fromCharCode(65 + r);
    for (let c = 1; c <= cols; c++) {
      out.push({
        seatRow: row,
        seatNumber: c,
        seatLabel: `${row}${c}`,
        seatStatus: gone.has(`${row}${c}`) ? '1' : '0'
      });
    }
  }
  return out;
}

// --- statuses ---------------------------------------------------------------

test('numeric seat status follows BookMyShow: 0 is free, anything else is not', () => {
  assert.equal(interpretStatus('0'), AVAILABLE);
  assert.equal(interpretStatus(0), AVAILABLE);
  assert.equal(interpretStatus('1'), TAKEN);
  assert.equal(interpretStatus(2), TAKEN);
  assert.equal(interpretStatus('AVAILABLE'), AVAILABLE);
  assert.equal(interpretStatus('sold'), TAKEN);
  assert.equal(interpretStatus(''), UNKNOWN);
  assert.equal(interpretStatus(undefined), UNKNOWN);
});

test('class names from the rendered map are read, and "selected" is not free', () => {
  assert.equal(statusFromTokens('seat _available css-1x'), AVAILABLE);
  assert.equal(statusFromTokens('seat seat--sold'), TAKEN);
  assert.equal(statusFromTokens('seat is-selected'), TAKEN);
  assert.equal(statusFromTokens('seat'), UNKNOWN);
});

test('a boolean field is read through the meaning of its key', () => {
  const [free] = buildLayout([{ seatRow: 'A', seatNumber: 1, isAvailable: true }]).rows[0].seats;
  assert.equal(free.status, AVAILABLE);
  const [sold] = buildLayout([{ seatRow: 'A', seatNumber: 1, isBooked: true }]).rows[0].seats;
  assert.equal(sold.status, TAKEN);
});

test('an unreadable status is treated as taken, never as free', () => {
  const layout = buildLayout([
    { seatRow: 'A', seatNumber: 1, seatStatus: 'mystery' },
    { seatRow: 'A', seatNumber: 2, seatStatus: '0' }
  ]);
  assert.equal(layout.available, 1);
  assert.equal(layout.unknown, 1);
  assert.equal(recommendSeats(layout, 2).blocks.length, 0);
});

// --- layout -----------------------------------------------------------------

test('rows come out front-to-back and seats left-to-right', () => {
  const layout = buildLayout(hall(3, 4));
  assert.deepEqual(layout.rows.map((r) => r.label), ['A', 'B', 'C']);
  assert.deepEqual(layout.rows[0].seats.map((s) => s.number), [1, 2, 3, 4]);
  assert.equal(layout.total, 12);
  assert.equal(layout.available, 12);
});

test('row Z sorts before row AA', () => {
  const layout = buildLayout([
    { seatLabel: 'AA1', seatStatus: '0' },
    { seatLabel: 'Z1', seatStatus: '0' },
    { seatLabel: 'B1', seatStatus: '0' }
  ]);
  assert.deepEqual(layout.rows.map((r) => r.label), ['B', 'Z', 'AA']);
});

test('a seat label carries its own row when there is no row field', () => {
  const layout = buildLayout([{ seatLabel: 'H12', seatStatus: '0' }]);
  assert.equal(layout.rows[0].label, 'H');
  assert.equal(layout.rows[0].seats[0].number, 12);
});

// --- picking ----------------------------------------------------------------

test('two together are found, and they are in the middle of the hall', () => {
  const layout = buildLayout(hall(10, 10));
  const { blocks } = recommendSeats(layout, 2);

  const best = blocks[0];
  // 10 rows, sweet spot 0.62 back -> row index 6 (G); centre of a 10-wide row
  // is seats 5 and 6.
  assert.equal(best.row, 'G');
  assert.deepEqual(best.seats.map((s) => s.number), [5, 6]);
  assert.equal(best.labels, 'G5-G6');
  assert.match(best.why, /way back/);
  assert.match(best.why, /centre/);
});

test('alternatives are different rows, not the same block nudged along', () => {
  const { blocks } = recommendSeats(buildLayout(hall(10, 10)), 2, { limit: 3 });
  assert.equal(blocks.length, 3);
  assert.equal(new Set(blocks.map((b) => b.row)).size, 3);
});

test('booked seats are skipped and never recommended', () => {
  // Only D3+D4 and A1+A2 are free anywhere.
  const seats = [
    ...hall(1, 4, ['A3', 'A4']),
    { seatRow: 'D', seatNumber: 1, seatLabel: 'D1', seatStatus: '1' },
    { seatRow: 'D', seatNumber: 2, seatLabel: 'D2', seatStatus: '1' },
    { seatRow: 'D', seatNumber: 3, seatLabel: 'D3', seatStatus: '0' },
    { seatRow: 'D', seatNumber: 4, seatLabel: 'D4', seatStatus: '0' }
  ];
  const { blocks } = recommendSeats(buildLayout(seats), 2);
  const chosen = blocks.flatMap((b) => b.seats.map((s) => s.label));
  assert.ok(!chosen.includes('A3') && !chosen.includes('D1'));
  assert.deepEqual(blocks[0].seats.map((s) => s.label), ['D3', 'D4']);
});

test('a gap in the numbering is not "together"', () => {
  // 5 and 7 are free but 6 is sold: no pair in this row.
  const layout = buildLayout(hall(1, 8, ['A1', 'A2', 'A3', 'A4', 'A6', 'A8']));
  const rec = recommendSeats(layout, 2);
  assert.equal(rec.blocks.length, 0);
  assert.equal(rec.largestRun, 1);
});

test('an aisle is a gap even when the seat numbers run straight through it', () => {
  // Seats 1-4, a wide aisle, then 5-8. Numbering is continuous; the pixels are
  // not, and the pixels win.
  const seats = [];
  for (let c = 1; c <= 8; c++) {
    seats.push({
      seatLabel: `A${c}`, seatStatus: '0',
      x: c <= 4 ? c * 20 : c * 20 + 120, y: 100
    });
  }
  const layout = buildLayout(seats);
  const pairs = recommendSeats(layout, 2, { limit: 10 }).blocks;
  assert.ok(pairs.length > 0);
  // 4 and 5 straddle the aisle, so no recommended pair may contain both.
  for (const b of pairs) {
    const n = b.seats.map((s) => s.number);
    assert.ok(!(n.includes(4) && n.includes(5)), `pair ${b.labels} crosses the aisle`);
  }
});

test('SEATS=4 wants four in a row, and says so when four will not fit', () => {
  const roomy = recommendSeats(buildLayout(hall(6, 10)), 4);
  assert.equal(roomy.blocks[0].seats.length, 4);

  const tight = recommendSeats(buildLayout(hall(1, 6, ['A3'])), 4);
  assert.equal(tight.blocks.length, 0);
  assert.equal(tight.largestRun, 3);          // A4, A5, A6
});

test('SEATS=1 picks a single seat in the sweet spot', () => {
  const { blocks } = recommendSeats(buildLayout(hall(9, 9)), 1);
  assert.equal(blocks[0].seats.length, 1);
  assert.equal(blocks[0].row, 'F');           // 0.62 of 9 rows
  assert.equal(blocks[0].seats[0].number, 5); // dead centre of 9
});

test('the front row loses to the same distance behind the sweet spot', () => {
  const layout = buildLayout(hall(9, 9));
  const rec = recommendSeats(layout, 2, { limit: 9 });
  const rows = rec.blocks.map((b) => b.row);
  assert.ok(rows.indexOf('A') > rows.indexOf('I'), 'the front row should rank last');
});

test('scoring is tunable: ask for the back and you get the back', () => {
  const layout = buildLayout(hall(10, 10));
  const back = recommendSeats(layout, 2, { scoring: { idealRowFraction: 1 } });
  assert.equal(back.blocks[0].row, 'J');
  const front = recommendSeats(layout, 2, { scoring: { idealRowFraction: 0 } });
  assert.equal(front.blocks[0].row, 'A');
});

test('a measured seat map with no labels still yields rows and a pick', () => {
  // What the DOM reader returns: pixels, a status class, and a number.
  const records = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 8; c++) {
      records.push({
        label: String(c + 1),
        statusHint: (r === 2 && c === 3) ? 'seat _sold' : 'seat _available',
        x: 100 + c * 24,
        y: 200 + r * 24
      });
    }
  }
  const layout = buildLayout(records);
  assert.equal(layout.rowCount, 5);
  assert.equal(layout.total, 40);
  assert.equal(layout.available, 39);
  assert.ok(recommendSeats(layout, 2).blocks.length > 0);
});

test('a half-labelled map is still grouped into its real rows', () => {
  // The rendered-map reader only finds a row's letter when the hall draws one,
  // so a map can come back with some rows labelled and some not. Grouping by
  // label would then tip every unlabelled row into one '?' row spanning the
  // auditorium - and seats in different rows would read as neighbours.
  const records = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      records.push({
        label: String(c + 1),
        rowLabel: r === 0 ? 'A' : undefined,     // only the front row is named
        statusHint: 'seat _available',
        x: 100 + c * 24,
        y: 200 + r * 30
      });
    }
  }

  const layout = buildLayout(records);
  assert.equal(layout.rowCount, 4, 'four physical rows, not two');
  assert.equal(layout.rows[0].label, 'A', 'a named row keeps its name');
  for (const row of layout.rows) assert.equal(row.seats.length, 6);

  // Nothing recommended may straddle two rows.
  for (const b of recommendSeats(layout, 3, { limit: 10 }).blocks) {
    assert.equal(new Set(b.seats.map((s) => s.y)).size, 1,
      `block ${b.labels} spans more than one row`);
  }
});

test('a map with no seat numbers gets seats counted from the left', () => {
  // An SVG grid of plain rectangles: positions, statuses, no text anywhere.
  const records = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 8; c++) {
      records.push({ statusHint: 'seat _available', x: 40 + c * 30, y: 30 + r * 30 });
    }
  }

  const layout = buildLayout(records);
  assert.equal(layout.countedNumbers, true);
  assert.equal(layout.available, 32);

  const rec = recommendSeats(layout, 2);
  assert.match(rec.blocks[0].labels, /^\d+-\d+$/, 'no "?, ?" in the email');

  const text = formatSeatReport({ ok: true, recommendation: rec }, {}).join('\n');
  assert.match(text, /counted from the left/);
});

test('seatRange collapses a run and spells out a broken one', () => {
  assert.equal(seatRange([{ label: 'H11', number: 11 }, { label: 'H12', number: 12 }]), 'H11-H12');
  assert.equal(seatRange([{ label: 'H11', number: 11 }, { label: 'H14', number: 14 }]), 'H11, H14');
  assert.equal(seatRange([{ label: 'H11', number: 11 }]), 'H11');
});

// --- payload harvesting ------------------------------------------------------

test('seats are harvested from a nested payload, inheriting row and category', () => {
  const payload = {
    SeatLayout: {
      Areas: [{
        AreaName: 'GOLD',
        Price: 250,
        Rows: [
          { RowName: 'H', Seats: [
            { SeatNumber: 11, SeatStatus: '0' },
            { SeatNumber: 12, SeatStatus: '0' },
            { SeatNumber: 13, SeatStatus: '1' }
          ] },
          { RowName: 'J', Seats: [{ SeatNumber: 1, SeatStatus: '0' }] }
        ]
      }]
    }
  };

  const records = harvestSeatObjects(payload);
  assert.equal(records.length, 4);

  const layout = buildLayout(records);
  assert.deepEqual(layout.rows.map((r) => r.label), ['H', 'J']);
  assert.equal(layout.available, 3);
  assert.equal(layout.categories[0].category, 'GOLD');

  const rec = recommendSeats(layout, 2);
  assert.deepEqual(rec.blocks[0].seats.map((s) => s.label), ['11', '12']);
  assert.equal(rec.blocks[0].category, 'GOLD');
  assert.equal(rec.blocks[0].price, 250);
});

test('harvesting ignores containers and anything that is not a seat', () => {
  const payload = { widgets: [{ id: 'banner', title: 'The Odyssey' }], meta: { count: 3 } };
  assert.equal(harvestSeatObjects(payload).length, 0);
});

// --- showtimes ---------------------------------------------------------------

test('clock times parse in every spelling the site uses', () => {
  assert.equal(parseClockTime('07:30 PM'), 19 * 60 + 30);
  assert.equal(parseClockTime('7:30PM'), 19 * 60 + 30);
  assert.equal(parseClockTime('19:30'), 19 * 60 + 30);
  assert.equal(parseClockTime('12:15 AM'), 15);
  assert.equal(parseClockTime('12:15 PM'), 12 * 60 + 15);
  assert.equal(parseClockTime('The Odyssey'), undefined);
  assert.equal(parseClockTime('25:00'), undefined);
  assert.equal(clockLabel(19 * 60 + 30), '7:30 PM');
});

const SHOWS_PAYLOAD = {
  widgets: [{
    venueName: 'PVR IMAX: Sathyam, Chennai',
    shows: [
      { showTime: '10:15 AM', sessionId: 'S1', cta: { type: 'showtime', url: '/seat/1' } },
      { showTime: '07:00 PM', sessionId: 'S2', cta: { type: 'showtime', url: '/seat/2' } },
      { showTime: '07:35 PM', sessionId: 'S3', cta: { type: 'showtime', url: '/seat/3' } },
      { showTime: '11:45 PM', sessionId: 'S4', cta: { type: 'showtime', url: '/seat/4' } }
    ]
  }]
};

test('showtimes are read with their venue and link', () => {
  const shows = readShowtimes(SHOWS_PAYLOAD);
  assert.deepEqual(shows.map((s) => s.label),
    ['10:15 AM', '7:00 PM', '7:35 PM', '11:45 PM']);
  assert.equal(shows[1].venue, 'PVR IMAX: Sathyam, Chennai');
  assert.equal(shows[1].url, '/seat/2');
  assert.equal(shows[1].sessionId, 'S2');
});

test('the ~7:30 show is the nearest one, and sold-out shows are skipped', () => {
  const shows = readShowtimes(SHOWS_PAYLOAD);
  assert.equal(pickShowNearest(shows, 19 * 60 + 30, 45).label, '7:35 PM');

  const soldOut = shows.map((s) => (s.label === '7:35 PM' ? { ...s, soldOut: true } : s));
  assert.equal(pickShowNearest(soldOut, 19 * 60 + 30, 45).label, '7:00 PM');

  // Nothing within the window is nothing, not "the least bad show of the day".
  assert.equal(pickShowNearest(shows, 15 * 60, 30), undefined);
});

test('a show marked sold out in any field is read as sold out', () => {
  // The marker moves around: sometimes the styleId, sometimes a status beside
  // it. A show whose styleId looks ordinary must not read as bookable just
  // because that is the first field with something in it.
  const payload = { widgets: [{ venueName: 'PVR IMAX', shows: [
    { showTime: '07:30 PM', sessionId: 'A', styleId: 'showtime-default',
      status: 'SOLD_OUT' },
    { showTime: '07:40 PM', sessionId: 'B', styleId: 'showtime-default',
      availabilityStatus: 'UNAVAILABLE' },
    { showTime: '08:05 PM', sessionId: 'C', styleId: 'showtime-default',
      status: 'AVAILABLE' }
  ] }] };

  const shows = readShowtimes(payload);
  assert.deepEqual(shows.map((s) => s.soldOut), [true, true, false]);

  // The nearest show to 7:30 is sold out, so the pick moves to the bookable one.
  assert.equal(pickShowNearest(shows, 19 * 60 + 30, 45).label, '8:05 PM');
});

test('the selected date in the strip is what the embedded schedule belongs to', () => {
  const payload = { strip: [
    { id: '20260801', styleId: 'date-default' },
    { id: '20260802', styleId: 'date-selected' }
  ] };
  assert.equal(readSelectedDate(payload), '20260802');
});

// --- getting the right day's schedule ----------------------------------------
//
// The checker watches a date that is usually not today, while the page it loads
// embeds today's schedule. Everything below guards the one failure that would
// not look like a failure: asking for Sunday, being handed today, and
// recommending seats at a show that has already finished.

const withDate = (dateCode, sessionIds) => ({
  strip: [{ id: dateCode, styleId: 'date-selected', isSelected: true }],
  widgets: [{
    venueName: 'PVR IMAX: Sathyam, Chennai',
    shows: sessionIds.map((id, i) => ({
      showTime: `0${7 + i}:30 PM`, sessionId: id, cta: { type: 'showtime', url: `/s/${id}` }
    }))
  }]
});

test('a schedule that names the day it is showing is believed', () => {
  const v = verifySchedule(withDate('20260802', ['A1', 'A2']), { dateCode: '20260802' });
  assert.equal(v.ok, true);
  assert.equal(v.shows.length, 2);
});

test('a schedule showing a different day is refused', () => {
  const v = verifySchedule(withDate('20260731', ['A1']), { dateCode: '20260802' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /came back showing 20260731/);
});

test("today's schedule handed back for another date is refused", () => {
  // The site answers the request for Sunday with the very sessions we already
  // hold for today. Same sessions means same day, whatever the page claims.
  const today = withDate('20260731', ['S1', 'S2']);
  const reference = showtimeSignature(readShowtimes(today));

  const impostor = { widgets: withDate('20260731', ['S1', 'S2']).widgets };
  const v = verifySchedule(impostor, { dateCode: '20260802', referenceSignature: reference });
  assert.equal(v.ok, false);
  assert.match(v.reason, /same schedule/);
});

test('a different day with the same times but new sessions is believed', () => {
  // Cinemas run the same times every day; only the session ids move.
  const today = withDate('20260731', ['S1', 'S2']);
  const reference = showtimeSignature(readShowtimes(today));

  const sunday = { widgets: withDate('20260731', ['S9', 'S8']).widgets };
  const v = verifySchedule(sunday, { dateCode: '20260802', referenceSignature: reference });
  assert.equal(v.ok, true);
});

test('a schedule that proves nothing about its day is refused', () => {
  const anonymous = { widgets: [{ venueName: 'X', shows: [
    { showTime: '07:30 PM', cta: { type: 'showtime' } }
  ] }] };
  const v = verifySchedule(anonymous, { dateCode: '20260802' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /proves which day/);
});

test('an empty payload is refused rather than trusted', () => {
  assert.equal(verifySchedule(null, { dateCode: '20260802' }).ok, false);
  assert.equal(verifySchedule({}, { dateCode: '20260802' }).ok, false);
});

test('signatures ignore a schedule with too few session ids to fingerprint', () => {
  assert.equal(showtimeSignature([{ sessionId: 'A' }, {}, {}]), null);
  assert.equal(showtimeSignature([{ sessionId: 'B' }, { sessionId: 'A' }]), 'A|B');
});

test('the date strip hands over each date\'s own link', () => {
  const state = { showtimesFunctionalApi: { queries: { fetchPrimaryDynamic: { data: { data: {
    strip: [
      { id: '20260802', styleId: 'date-default',
        cta: { type: 'dateSelector', url: '/movies/chennai/the-odyssey/buytickets/ET1/20260802' } },
      { id: '20260803', styleId: 'date-default', cta: { type: 'dateSelector' } }
    ]
  } } } } } };

  const a = analyseState(state, ['20260802', '20260803']);
  assert.equal(a.ok, true);
  assert.equal(a.results[0].url, '/movies/chennai/the-odyssey/buytickets/ET1/20260802');
  assert.equal(a.results[0].onSale, true);
  assert.equal(a.results[1].url, undefined);
});

// --- the email --------------------------------------------------------------

test('the email names the seats, the show and the availability', () => {
  const layout = buildLayout(hall(10, 10, ['G5']));
  const report = {
    ok: true,
    show: { label: '7:35 PM', venue: 'PVR IMAX: Sathyam' },
    seatUrl: 'https://in.bookmyshow.com/seat/3',
    recommendation: recommendSeats(layout, 2)
  };
  const text = formatSeatReport(report, {
    showLabel: report.show.label, venue: report.show.venue, seatUrl: report.seatUrl
  }).join('\n');

  assert.match(text, /Seats at 7:35 PM - PVR IMAX: Sathyam/);
  assert.match(text, /Best 2 seats together:/);
  assert.match(text, /Row [A-J], seats \w+-\w+/);
  assert.match(text, /99 of 100 seats free \(99%\)/);
  assert.match(text, /https:\/\/in\.bookmyshow\.com\/seat\/3/);
  assert.ok(!text.includes('G5'), 'the sold seat must not be recommended');
});

test('a browser error reaches the email as one readable line', () => {
  // Playwright errors carry a call log and colour codes. An alert that opens
  // with a wall of escape sequences is an alert nobody reads.
  const raw = 'page.goto: net::ERR_ABORTED\n' +
    `Call log:\n  - [2mnavigating to "https://in.bookmyshow.com"[22m\n`;
  const line = brief(raw);
  assert.equal(line, 'page.goto: net::ERR_ABORTED');
  assert.ok(!line.includes(''));
  assert.ok(!line.includes('\n'));
  assert.ok(brief('x'.repeat(500)).length <= 200);
  assert.equal(brief(undefined), '');
});

test('an unreadable seat map says why, in the email', () => {
  const text = formatSeatReport(
    { ok: false, reason: 'no seat map on the page' },
    { showLabel: '7:35 PM' }
  ).join('\n');
  assert.match(text, /could not be read/);
  assert.match(text, /no seat map on the page/);
});

test('a full house is reported as a full house', () => {
  const full = hall(4, 6).map((s) => ({ ...s, seatStatus: '1' }));
  const report = { ok: true, recommendation: recommendSeats(buildLayout(full), 2) };
  const text = formatSeatReport(report, {}).join('\n');
  assert.match(text, /No 2 free seats together/);
  assert.match(text, /Nothing is free/);
});
