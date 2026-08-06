// Reads per-date IMAX availability from BookMyShow's server-rendered state.
//
// Two things here are non-obvious and were established by testing the live site:
//
// 1. Not the DOM. The client-side call to
//    /api/movies-data/v5/showtimes-by-event/primary-dynamic is 403'd for
//    automated clients, so the rendered page shows "Oops! Something went wrong"
//    with no showtimes. The same payload ships inside the HTML as
//    window.__INITIAL_STATE__, which is not behind that rule.
//
// 2. The date strip, not the showtime list. The embedded showtime list is
//    always TODAY's schedule whatever date the URL asks for (verified
//    byte-identical for dates months out). The date strip is genuinely
//    per-date. Also note the "IMAX 2D" chip's isDisabled flag means "IMAX is
//    the selected format", not "unavailable" - it is not an availability signal.

export function extractInitialState(html) {
  const marker = 'window.__INITIAL_STATE__';
  const at = html.indexOf(marker);
  if (at === -1) return null;

  const eq = html.indexOf('=', at + marker.length);
  if (eq === -1) return null;

  const stop = html.indexOf('</script>', eq);
  if (stop === -1) return null;

  try {
    return JSON.parse(html.slice(eq + 1, stop).trim().replace(/;+\s*$/, ''));
  } catch {
    return null;
  }
}

export function* walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  yield node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    yield* walk(value, depth + 1);
  }
}

const DATE_ID = /^\d{8}$/;

/**
 * Collect the date strip keyed by YYYYMMDD.
 *
 * Matched on shape rather than widget path so a layout change moves the strip
 * without breaking us. A date is on sale when it has a dateSelector cta and no
 * "disabled" styling; BookMyShow renders unavailable dates without a cta.
 */
function readDateStrip(payload) {
  const dates = new Map();

  for (const node of walk(payload)) {
    if (typeof node.id !== 'string' || !DATE_ID.test(node.id)) continue;

    const styleId = typeof node.styleId === 'string' ? node.styleId : '';
    if (!/^date-/.test(styleId) && node.cta?.type !== 'dateSelector') continue;

    const hasCta = node.cta?.type === 'dateSelector';
    const disabled = /disabled/i.test(styleId) ||
      (Array.isArray(node.data) &&
       node.data.some((d) => /disabled/i.test(d?.styleId ?? '')));

    if (!dates.has(node.id)) {
      dates.set(node.id, {
        dateCode: node.id,
        onSale: hasCta && !disabled,
        // Where this chip leads. The seat check needs a date's own page and
        // this is the site's own answer for where that is, which beats
        // assembling a URL out of guesses.
        url: typeof node.cta?.url === 'string' ? node.cta.url
          : typeof node.cta?.meta?.url === 'string' ? node.cta.meta.url
          : typeof node.url === 'string' ? node.url : undefined
      });
    }
  }

  return dates;
}

/** The showtimes payload inside the page state, or why it is not there. */
export function showtimesPayload(state) {
  const queries = state?.showtimesFunctionalApi?.queries ?? {};
  const key = Object.keys(queries).find((k) => k.includes('fetchPrimaryDynamic'));
  if (!key) return { ok: false, reason: 'no showtimes query in page state' };

  const payload = queries[key]?.data?.data;
  if (!payload) return { ok: false, reason: 'showtimes query has no payload' };

  return { ok: true, payload };
}

/**
 * @param state    parsed window.__INITIAL_STATE__
 * @param dateStrs "YYYYMMDD" dates to report on
 */
export function analyseState(state, dateStrs) {
  const found = showtimesPayload(state);
  if (!found.ok) return found;
  const payload = found.payload;

  const strip = readDateStrip(payload);
  if (strip.size === 0) {
    return { ok: false, reason: 'could not find the date strip in page state' };
  }

  const results = dateStrs.map((dateCode) => {
    const cell = strip.get(dateCode);
    if (!cell) {
      // Past the window BookMyShow currently publishes (~7 days).
      return { dateCode, onSale: false, note: 'not in booking window yet' };
    }
    return {
      dateCode,
      onSale: cell.onSale,
      url: cell.url,
      note: cell.onSale ? 'ON SALE' : 'listed but not on sale'
    };
  });

  return {
    ok: true,
    payload,
    selectedDate: readSelectedDate(payload),
    stripRange: [...strip.keys()].sort(),
    stripOnSale: [...strip.values()].filter((c) => c.onSale).map((c) => c.dateCode),
    results
  };
}

// --- showtimes ---------------------------------------------------------------
//
// Reading the showtime list is a different job from reading the date strip, and
// a more delicate one. Point 2 at the top of this file is the constraint that
// shapes all of it: the embedded showtime list is *today's* schedule whatever
// date the URL asks for. So a showtime read out of the page state can only be
// trusted for the date the page state says is selected, and the seat check has
// to check that before it recommends anything.

/** Which date's schedule is embedded, as YYYYMMDD, if the state admits it. */
export function readSelectedDate(payload) {
  for (const node of walk(payload)) {
    if (typeof node.id !== 'string' || !DATE_ID.test(node.id)) continue;
    const selected = node.isSelected === true || node.selected === true ||
      /selected/i.test(typeof node.styleId === 'string' ? node.styleId : '');
    if (selected) return node.id;
  }
  return undefined;
}

/**
 * "07:30 PM", "7:30PM", "19:30" -> minutes after midnight. Returns undefined
 * for anything that is not a clock time, which is most strings in the payload.
 */
export function parseClockTime(value) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*(AM|PM)?\s*$/i.exec(String(value ?? ''));
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return undefined;
  const suffix = m[3]?.toUpperCase();
  if (suffix) {
    if (h < 1 || h > 12) return undefined;
    if (h === 12) h = 0;
    if (suffix === 'PM') h += 12;
  } else if (h > 23) {
    return undefined;
  }
  return h * 60 + min;
}

export const clockLabel = (minutes) => {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = String(minutes % 60).padStart(2, '0');
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${m} ${suffix}`;
};

const TIME_KEYS = ['showtime', 'showTime', 'time', 'showTimeLabel', 'startTime',
                   'title', 'text', 'label'];
const SESSION_KEYS = ['sessionId', 'showTimeCode', 'sessionCode', 'showId',
                      'showTimeId', 'ssid'];
const VENUE_KEYS = ['venueName', 'venue', 'cinemaName', 'theatreName'];

/**
 * Every showtime in the payload, matched on shape: a node carrying something
 * that parses as a clock time, plus a session id or a cta to click. The venue
 * comes from the nearest ancestor that names one, because showtimes are nested
 * under their cinema rather than carrying its name.
 */
export function readShowtimes(payload) {
  const shows = [];
  const seen = new Set();

  const visit = (node, venue, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40) return;

    const named = VENUE_KEYS.map((k) => node[k]).find((v) => typeof v === 'string' && v.trim());
    const here = named ? named.trim() : venue;

    if (!Array.isArray(node)) {
      let minutes;
      for (const k of TIME_KEYS) {
        minutes = parseClockTime(node[k]);
        if (minutes !== undefined) break;
      }
      const session = SESSION_KEYS.map((k) => node[k] ?? node.cta?.meta?.[k] ?? node.meta?.[k])
        .find((v) => v !== undefined && v !== null && v !== '');
      const url = typeof node.cta?.url === 'string' ? node.cta.url
        : typeof node.url === 'string' ? node.url : undefined;
      const isShow = minutes !== undefined &&
        (session !== undefined || /show/i.test(String(node.cta?.type ?? node.styleId ?? '')));

      if (isShow) {
        const key = `${here || ''}|${minutes}|${session ?? url ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          shows.push({
            minutes,
            label: clockLabel(minutes),
            venue: here,
            sessionId: session !== undefined ? String(session) : undefined,
            url,
            // Sold-out shows are still listed; do not send anyone to one.
            // Every field is searched, not the first one that happens to be
            // set: a show with an ordinary styleId and status "SOLD_OUT" would
            // otherwise read as bookable, which is the wrong way to be wrong.
            soldOut: /sold|unavailable|disabled/i.test(
              [node.styleId, node.status, node.availabilityStatus]
                .filter((v) => typeof v === 'string').join(' '))
          });
        }
      }
    }

    for (const value of Array.isArray(node) ? node : Object.values(node)) {
      visit(value, here, depth + 1);
    }
  };

  visit(payload, undefined, 0);
  return shows.sort((a, b) => a.minutes - b.minutes);
}

/**
 * A fingerprint of a schedule, used to tell one day's from another's.
 *
 * Session ids are per showing, not per film or per screen, so two payloads
 * carrying the same ids are the same day's schedule - however different the
 * page that served them claimed to be. That is the trap this exists to catch:
 * asking for Sunday and being handed today's list again, silently.
 *
 * Falls back to nothing (rather than to the times, which repeat daily) when
 * there are no session ids to fingerprint, so the caller knows it has no
 * evidence rather than weak evidence.
 */
export function showtimeSignature(shows) {
  const ids = shows.map((s) => s.sessionId).filter(Boolean);
  if (ids.length < Math.max(1, shows.length / 2)) return null;
  return [...new Set(ids)].sort().join('|');
}

/**
 * Is this payload really `dateCode`'s schedule?
 *
 * Asking BookMyShow for another day and being handed today's list again is the
 * failure that matters: it looks exactly like success. So a payload is believed
 * only on positive evidence - it says which day it is showing, or its sessions
 * are demonstrably not the ones we already have - and refused otherwise.
 *
 * @param referenceSignature showtimeSignature() of the schedule already held
 */
export function verifySchedule(payload, { dateCode, referenceSignature }) {
  const shows = readShowtimes(payload || {});
  if (shows.length === 0) return { ok: false, reason: 'no showtimes in it' };

  const selected = readSelectedDate(payload);
  if (selected && selected !== dateCode) {
    return { ok: false, reason: `came back showing ${selected}` };
  }

  const signature = showtimeSignature(shows);
  if (signature && referenceSignature && signature === referenceSignature) {
    return { ok: false, reason: "served the same schedule as the day already held" };
  }
  if (!selected && !signature) {
    return { ok: false, reason: 'nothing in it proves which day it is' };
  }
  return { ok: true, shows };
}

/**
 * The show closest to `targetMinutes`, within `windowMinutes` either side.
 * Ties go to the earlier show: if 7:15 and 7:45 are equally close to 7:30, the
 * one that has not started yet by the time you have booked is the earlier one.
 */
export function pickShowNearest(shows, targetMinutes, windowMinutes = 45) {
  const usable = shows.filter((s) => !s.soldOut &&
    Math.abs(s.minutes - targetMinutes) <= windowMinutes);
  if (usable.length === 0) return undefined;
  return usable.reduce((best, s) => {
    const d = Math.abs(s.minutes - targetMinutes);
    const bd = Math.abs(best.minutes - targetMinutes);
    return d < bd || (d === bd && s.minutes < best.minutes) ? s : best;
  });
}
