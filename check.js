import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import {
  windowsUserAgent, launchArgs, contextOptions, stealthInitScript,
  probeClientHints, fixAcceptLanguage, actHuman, rand
} from './stealth.js';
import { buildProfile, describeProfile } from './fingerprint.js';
import {
  extractInitialState, analyseState, showtimesPayload, readShowtimes,
  showtimeSignature, verifySchedule, pickShowNearest, parseClockTime, clockLabel
} from './extract.js';
import { inspectSeats, brief } from './seatmap.js';
import { formatSeatReport, rowName } from './seats.js';

// The event code in this URL is the IMAX 2D event (the-odyssey-imax-2d), so a
// date going on sale on this page is IMAX going on sale.
const BASE_URL = (process.env.TARGET_URL_BASE ||
  'https://in.bookmyshow.com/movies/chennai/the-odyssey/buytickets/ET00480917')
  .replace(/\/+$/, '');

const STATE_FILE = 'state.json';
const DEBUG_DIR = 'debug';

// Kill switch. Any non-empty value pauses the checker whatever the caller is -
// an external cron, the Actions schedule, a manual run. The value is never
// interpreted, only its presence: STOP=0 pauses just like STOP=1, because
// "set means stopped" is the rule you can remember at 2am. Delete or blank it
// to resume.
const STOP = (process.env.STOP || '').trim();

// Which weekday to watch, as a name ("monday") or a number (0=Sunday..6=Saturday).
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday',
                       'thursday', 'friday', 'saturday'];

function parseWeekday(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (/^\d$/.test(raw)) return Number(raw);
  const i = WEEKDAY_NAMES.findIndex((n) => n.startsWith(raw));
  if (i === -1) throw new Error(`WATCH_WEEKDAY: not a weekday: "${value}"`);
  return i;
}

const WATCH_WEEKDAY = parseWeekday(process.env.WATCH_WEEKDAY, 1);   // Monday

// Pin specific dates instead of a weekday, e.g. "2026-08-15,2026-08-22".
// Set, it wins over WATCH_WEEKDAY/DATES_TO_CHECK; blank, the weekday rule runs.
const WATCH_DATES = (process.env.WATCH_DATES || '').trim();

// BookMyShow only publishes ~7 days, so dates beyond the second read
// "not in booking window yet" until they come into range.
const DATES_TO_CHECK = Number(process.env.DATES_TO_CHECK || 2);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const PROXY_URL = process.env.PROXY_URL || '';

const FINGERPRINT_SEED = process.env.FINGERPRINT_SEED ||
  (process.env.GITHUB_RUN_ID &&
    `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}`) ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Consecutive blind runs before the failure alert fires. Counts any run that
// could not read availability, not just HTTP blocks.
const BLOCK_ALERT_THRESHOLD = Number(process.env.BLOCK_ALERT_THRESHOLD || 3);

// --- seat check -------------------------------------------------------------
//
// How many of you are going, and which show. When a watched date is on sale the
// checker goes one step further than "it is open": it opens the seat map for
// the show nearest SHOW_TIME and works out where SEATS people can sit together.

// Bad configuration is collected rather than thrown, and reported by main()
// once STOP has had its say. A paused checker stays paused even when the
// settings it is not using are wrong.
const CONFIG_ERRORS = [];

/**
 * A number from the environment, or a loud complaint. A typo in SEATS must not
 * quietly become NaN and turn every seat check into "nothing fits", which is
 * exactly what a silent fallback would look like from the inbox.
 */
function numberFromEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = (process.env[name] || '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    CONFIG_ERRORS.push(`${name}: expected a number between ${min} and ${max}, got "${raw}"`);
    return fallback;
  }
  return n;
}

const SEATS = Math.floor(numberFromEnv('SEATS', 2, { min: 1, max: 40 }));

// Any non-empty value other than 0/false/no/off keeps the seat step on.
const SEAT_CHECK = !/^(0|false|no|off)$/i.test((process.env.SEAT_CHECK || '1').trim());

const SHOW_TIME = (process.env.SHOW_TIME || '19:30').trim();
const SHOW_TIME_MINUTES = parseClockTime(SHOW_TIME) ?? parseClockTime('19:30');
if (parseClockTime(SHOW_TIME) === undefined) {
  CONFIG_ERRORS.push(`SHOW_TIME: not a clock time: "${SHOW_TIME}" (try 19:30 or 7:30 PM)`);
}

// How far from SHOW_TIME a show may be and still count as "the 7:30 show".
const SHOW_TIME_WINDOW = numberFromEnv('SHOW_TIME_WINDOW', 45, { min: 0, max: 720 });

// Where the sweet spot is, as a fraction of the way back from the screen, and
// how many alternatives to list. Defaults live in seats.js.
const SEAT_SCORING = (process.env.SEAT_IDEAL_ROW || '').trim()
  ? { idealRowFraction: numberFromEnv('SEAT_IDEAL_ROW', 0.62, { min: 0, max: 1 }) }
  : {};
const SEAT_OPTIONS_LISTED = numberFromEnv('SEAT_OPTIONS', 3, { min: 1, max: 20 });

// Separate EmailJS templates so a "checker is broken" mail looks different
// from a "tickets are open" mail in the inbox.
const TEMPLATE_ALERT = process.env.EMAILJS_TEMPLATE_ID;
const TEMPLATE_FAILURE =
  process.env.EMAILJS_FAILURE_TEMPLATE_ID;

// --- state ------------------------------------------------------------------

function loadState() {
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      notified: p.notified || {},
      // Dates whose alert already carried a seat recommendation. Separate from
      // `notified` because a date can open before its seat map is readable.
      seatAlerts: p.seatAlerts || {},
      consecutiveBlocks: p.consecutiveBlocks || 0,
      blockAlertSent: p.blockAlertSent || false,
      lastRun: p.lastRun || null
    };
  } catch {
    return {
      notified: {}, seatAlerts: {},
      consecutiveBlocks: 0, blockAlertSent: false, lastRun: null
    };
  }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// --- dates (IST, the timezone BookMyShow's date codes are in) ----------------

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/**
 * Upcoming dates that fall on `weekday`, starting with the coming one. Today
 * counts if it already is that weekday - the day's shows are still bookable.
 */
function nextWeekdays(weekday, count) {
  const [y, m, d] = todayIST().split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));   // UTC: no DST, no off-by-one
  const out = [];
  while (out.length < count) {
    if (cursor.getUTCDay() === weekday) out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Explicit dates from WATCH_DATES: comma-separated, YYYY-MM-DD or YYYYMMDD.
 *
 * Rejects rather than silently rounds a date that does not exist (a "31st" of
 * a 30-day month), because a typo here means the checker watches the wrong day
 * and never says so.
 */
function parseWatchDates(spec) {
  const out = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    if (!m) throw new Error(`WATCH_DATES: not a YYYY-MM-DD date: "${s}"`);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (urlDate(d) !== `${m[1]}${m[2]}${m[3]}`) {
      throw new Error(`WATCH_DATES: no such date: "${s}"`);
    }
    return d;
  });
  if (out.length === 0) throw new Error('WATCH_DATES is set but lists no dates');
  return out.sort((a, b) => a - b);
}

const urlDate = (d) =>
  `${d.getUTCFullYear()}` +
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
  `${String(d.getUTCDate()).padStart(2, '0')}`;

const humanDate = (d) => d.toLocaleDateString('en-IN', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

// --- notification -----------------------------------------------------------

async function sendEmail(templateId, subject, message) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: templateId,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: { subject, message, to_email: process.env.TO_EMAIL }
    })
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
}

/** Tickets are open. Failing here should fail the run - it is the whole point. */
async function notifyAvailable(subject, message) {
  await sendEmail(TEMPLATE_ALERT, subject, message);
  console.log('   alert email sent');
}

/** Link back to the run that produced this, when running in Actions. */
function workflowRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

/**
 * The checker is blind. Best-effort: a failure to deliver this must not mask
 * the underlying failure we are trying to report.
 */
async function notifyBlocked(runs, reason) {
  const runUrl = workflowRunUrl();
  const body = [
    `The IMAX checker has failed to read the page on ${runs} runs in a row.`,
    `It is not currently able to tell whether tickets have opened.`,
    ``,
    `Last reason: ${reason}`,
    ``,
    runUrl ? `Check the workflow run: ${runUrl}` : `Check the workflow run in the Actions tab.`,
    `The run's "debug-artifacts" download has a screenshot and the raw HTML of`,
    `exactly what came back.`,
    ``,
    `Meanwhile, check by hand: ${BASE_URL}`
  ].join('\n');

  try {
    await sendEmail(TEMPLATE_FAILURE, `IMAX checker is blocked (${runs} runs)`, body);
    console.log('   failure email sent');
    return true;
  } catch (e) {
    console.error('   failure email could not be sent:', e.message);
    return false;
  }
}

// --- block detection --------------------------------------------------------

const BLOCK_SIGNALS = [
  /sorry, you have been blocked/i,
  /attention required/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
  /verify (you are|you're) (a )?human/i,
  /captcha/i,
  /cloudflare ray id/i,
  /unusual traffic/i
];

function classifyBlock(status, html) {
  if (status === 403 || status === 429 || status === 503) return `HTTP ${status}`;
  const hit = BLOCK_SIGNALS.find((re) => re.test(html.slice(0, 8000)));
  return hit ? `challenge/block page (${hit})` : null;
}

async function dumpDebug(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = label.replace(/[^\w.-]+/g, '_');
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), await page.content());
    console.log(`   wrote ${DEBUG_DIR}/${safe}.{png,html}`);
  } catch (e) {
    console.error('   could not write debug artifacts:', e.message);
  }
}

// --- fetch ------------------------------------------------------------------

/**
 * The window size is a launch flag, so the browser is launched per attempt
 * rather than once per run - a retry that reuses the blocked attempt's window
 * geometry is only half a new machine.
 */
async function launchBrowser(profile) {
  const opts = {
    headless: true,
    args: launchArgs(profile),
    ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {})
  };
  try {
    const b = await chromium.launch({ ...opts, channel: 'chrome' });
    console.log(`   Google Chrome ${b.version()}`);
    return b;
  } catch {
    const b = await chromium.launch(opts);
    console.log(`   bundled Chromium ${b.version()} (Chrome channel unavailable)`);
    return b;
  }
}

/**
 * Load the showtimes page once.
 *
 * Do not add a homepage warm-up. Visiting the homepage first makes Cloudflare
 * issue a bot-management cookie that gets the next request 403'd; going
 * straight to the target on a cold context returns 200. Each attempt therefore
 * uses a brand-new browser and context so no cookie is ever carried over.
 *
 * Each attempt also draws a *different* hardware profile: retrying a block with
 * the fingerprint that was just refused is the one thing guaranteed not to
 * help.
 *
 * `whileOpen(page, html, apiUrls)` runs on the loaded page before the browser
 * closes - that is the only window in which the seat map can be opened, since
 * it is drawn client-side and is not in the HTML. Whatever it returns comes
 * back as `.live`.
 */
async function fetchPage(whileOpen) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const profile = buildProfile(`${FINGERPRINT_SEED}#${attempt}`);
    console.log(`\n   attempt ${attempt}/${MAX_ATTEMPTS}`);
    console.log(`   posing as: ${describeProfile(profile)}`);

    const browser = await launchBrowser(profile);

    // The UA has to be built from the browser that actually launched, so the
    // major version in the UA string matches the engine behind it.
    profile.chromeVersion = browser.version();
    const userAgent = windowsUserAgent(profile.chromeVersion);

    // Client-hint brands come from the browser itself, with "HeadlessChrome"
    // rewritten. Has to happen before the real context exists, because
    // extraHTTPHeaders are fixed at context creation.
    profile.uaBrands = await probeClientHints(browser);

    const context = await browser.newContext(contextOptions(profile, userAgent));
    await fixAcceptLanguage(context, profile);
    await context.addInitScript(stealthInitScript, profile);
    const page = await context.newPage();

    // The page asks its own API for the showtimes as it loads. That call is
    // refused for automated clients, but its URL is worth keeping: it is the
    // exactly-right query string for this event, which the seat step can reuse
    // with a different date rather than trying to guess BookMyShow's parameters.
    const apiUrls = [];
    page.on('request', (req) => {
      const u = req.url();
      if (/showtimes-by-event|primary-dynamic/i.test(u)) apiUrls.push(u);
    });

    try {
      const res = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = res?.status() ?? 0;
      await page.waitForTimeout(rand(2500, 4500));
      await actHuman(page, profile);

      const html = await page.content();
      const block = classifyBlock(status, html);

      if (block) {
        console.log(`   blocked: ${block}`);
        await dumpDebug(page, `blocked-attempt${attempt}`);
        await browser.close();
        if (attempt < MAX_ATTEMPTS) {
          const backoff = rand(8000, 20000) * attempt;
          console.log(`   backing off ${Math.round(backoff / 1000)}s`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return { blocked: true, reason: block };
      }

      console.log(`   loaded ok (HTTP ${status}, ${html.length} bytes)`);

      let live = null;
      if (whileOpen) {
        try {
          live = await whileOpen(page, html, apiUrls);
        } catch (e) {
          // The page loaded; something we did with it afterwards did not. That
          // is a failure to read availability, not a block - reporting it as
          // one would retry with a fresh browser against a bug that will
          // happen again, and eventually raise "BookMyShow is blocking us".
          live = { failure: `page loaded but could not be used: ${brief(e.message)}` };
        }
      }

      await browser.close();
      return { blocked: false, html, live };
    } catch (e) {
      console.log(`   error: ${e.message}`);
      await dumpDebug(page, `error-attempt${attempt}`).catch(() => {});
      await browser.close().catch(() => {});
      if (attempt === MAX_ATTEMPTS) {
        return { blocked: true, reason: `navigation error: ${e.message}` };
      }
      await new Promise((r) => setTimeout(r, rand(5000, 12000) * attempt));
    }
  }
}

// --- seat check -------------------------------------------------------------

/**
 * Which day's schedule is embedded in the page.
 *
 * The showtime list in the HTML is the *currently selected* day's, which for a
 * page loaded without a date in the URL is today in IST. The page state's own
 * "selected" marker is used only to catch disagreement: if the two do not
 * match, we do not know whose schedule we are holding, and a seat
 * recommendation for the wrong day is worse than none.
 */
function embeddedScheduleDate(analysis) {
  const today = todayIST().replace(/-/g, '');
  if (analysis.selectedDate && analysis.selectedDate !== today) return null;
  return today;
}

/**
 * Find the ~SHOW_TIME show for `dateCode` and read its seat map.
 *
 * Never throws and never returns nothing: the caller puts the reason in the
 * email when the seats could not be read, so "why not" is always in hand.
 */
async function checkSeats(page, dateCode, analysis, apiUrls) {
  const scheduleDate = embeddedScheduleDate(analysis);
  const embedded = readShowtimes(analysis.payload);
  console.log(`   the page embeds ${embedded.length} showtime(s) for ` +
    `${scheduleDate ?? 'a day it does not agree with'}`);

  let shows = embedded;
  if (dateCode !== scheduleDate) {
    // The embedded list is the wrong day's. Go and get the right one.
    const fetched = await showtimesForDate(page, {
      dateCode,
      dateUrl: analysis.results.find((r) => r.dateCode === dateCode)?.url,
      embedded,
      apiUrls
    });
    if (!fetched.ok) {
      return { ok: false, reason:
        `${dateCode}'s schedule could not be read - ${fetched.reason}` };
    }
    shows = fetched.shows;
    console.log(`   got ${dateCode}'s schedule from the ${fetched.how}`);
  }

  if (shows.length === 0) return { ok: false, reason: 'no showtimes in the page state' };

  const show = pickShowNearest(shows, SHOW_TIME_MINUTES, SHOW_TIME_WINDOW);
  if (!show) {
    return { ok: false, reason:
      `no show within ${SHOW_TIME_WINDOW} min of ${clockLabel(SHOW_TIME_MINUTES)} ` +
      `(listed: ${shows.map((s) => s.label).join(', ') || 'none'})` };
  }

  console.log(`   nearest show to ${clockLabel(SHOW_TIME_MINUTES)}: ` +
    `${show.label}${show.venue ? ` at ${show.venue}` : ''}`);

  return inspectSeats(page, show, {
    seats: SEATS,
    scoring: SEAT_SCORING,
    limit: SEAT_OPTIONS_LISTED,
    debugDir: DEBUG_DIR,
    baseUrl: BASE_URL,
    log: (m) => console.log(m)
  });
}

/**
 * Get a specific date's schedule, by whatever means the site allows.
 *
 * The date the checker is watching is usually not today, and the page it loads
 * embeds today's schedule. There are three ways to the right day and none of
 * them is reliable on its own, so all three are tried in order of how little
 * they ask of the site:
 *
 *   1. the date's own page, at the URL the date strip itself points at;
 *   2. clicking the date's chip, for when that page is built client-side;
 *   3. the site's showtimes API, copied from a request the page made.
 *
 * Every answer is checked before it is believed. Being handed today's schedule
 * again is the failure mode that matters here: it looks like success, and it
 * would send somebody to a seat at the wrong show on the wrong day.
 */
async function showtimesForDate(page, { dateCode, dateUrl, embedded, apiUrls }) {
  const tried = [];
  const embeddedSignature = showtimeSignature(embedded);

  /** Believe a payload only with positive evidence that it is the right day. */
  const accept = (payload, how) => {
    if (!payload) { tried.push(`${how}: no page state`); return null; }
    const verdict = verifySchedule(payload, {
      dateCode, referenceSignature: embeddedSignature
    });
    if (!verdict.ok) { tried.push(`${how}: ${verdict.reason}`); return null; }
    return { ok: true, shows: verdict.shows, how };
  };

  const stateOfPage = async () => {
    const parsed = extractInitialState(await page.content());
    const found = parsed ? showtimesPayload(parsed) : { ok: false };
    return found.ok ? found.payload : null;
  };

  // 1. The date's own page.
  const urls = [...new Set([
    dateUrl ? absoluteUrl(dateUrl) : null,
    `${BASE_URL}/${dateCode}`
  ].filter(Boolean))];

  for (const url of urls) {
    const how = url === urls[0] && dateUrl ? "date strip's own link" : 'date page';
    try {
      console.log(`   trying the ${how}: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(rand(1500, 3000));
      const good = accept(await stateOfPage(), how);
      if (good) return good;
    } catch (e) {
      tried.push(`${how}: ${brief(e.message)}`);
    }
  }

  // 2. The chip itself, for a strip that switches dates without a page load.
  try {
    const chip = page.locator(
      `[href*="${dateCode}"], [data-date="${dateCode}"], [id*="${dateCode}"]`).first();
    if (await chip.count() > 0) {
      await chip.click({ timeout: 10000 });
      await page.waitForTimeout(rand(2500, 4000));
      const good = accept(await stateOfPage(), 'date chip');
      if (good) return good;
    } else {
      tried.push('date chip: not on the page');
    }
  } catch (e) {
    tried.push(`date chip: ${brief(e.message)}`);
  }

  // 3. The API the page uses, with the date swapped. Usually refused for
  // automated clients, and on a server-rendered page there may be no request
  // to copy in the first place.
  const api = await fetchShowtimesApi(page, apiUrls, dateCode);
  if (api.ok) {
    const good = accept(api.payload, 'site API');
    if (good) return good;
  } else {
    tried.push(`site API: ${api.reason}`);
  }

  return { ok: false, reason: tried.join('; ') };
}

const absoluteUrl = (url) => {
  try { return new URL(url, BASE_URL).toString(); } catch { return null; }
};

/**
 * Re-issue the page's own showtimes request for a different date, from inside
 * the page. Only the date changes; every other parameter is whatever the site
 * decided it needed, which is not something worth reverse-engineering.
 */
async function fetchShowtimesApi(page, apiUrls, dateCode) {
  if (!apiUrls || apiUrls.length === 0) {
    return { ok: false, reason: 'the page made no showtimes request to copy' };
  }

  let url;
  try {
    url = new URL(apiUrls[apiUrls.length - 1]);
  } catch {
    return { ok: false, reason: 'the showtimes request URL could not be parsed' };
  }
  let swapped = false;
  for (const [k, v] of [...url.searchParams]) {
    if (/date/i.test(k) && /^\d{8}$/.test(v)) { url.searchParams.set(k, dateCode); swapped = true; }
  }
  if (!swapped) {
    if (/\/\d{8}(\/|$)/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/\d{8}(\/|$)/, `/${dateCode}$1`);
    } else {
      url.searchParams.set('dateCode', dateCode);
    }
  }

  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
      return { status: r.status, text: (await r.text()).slice(0, 8_000_000) };
    } catch (e) {
      return { status: 0, text: '', error: String(e && e.message ? e.message : e) };
    }
  }, url.toString()).catch((e) => ({ status: 0, text: '', error: e.message }));

  if (res.status !== 200) {
    return { ok: false, reason: res.error ? `request failed: ${res.error}` : `HTTP ${res.status}` };
  }
  try {
    const body = JSON.parse(res.text);
    return { ok: true, payload: body?.data?.data ?? body?.data ?? body };
  } catch {
    return { ok: false, reason: 'the response was not JSON' };
  }
}

// --- seat copy --------------------------------------------------------------

const seatSection = (report) => formatSeatReport(report, {
  showLabel: report.show?.label || clockLabel(SHOW_TIME_MINUTES),
  venue: report.show?.venue,
  seatUrl: report.seatUrl
});

/**
 * The subject line carries the answer when there is one. A phone shows about
 * sixty characters of it, and "Row H 11-12" in those sixty characters saves
 * opening the mail at all.
 */
function alertSubject(label, report) {
  const best = report?.ok ? report.recommendation.blocks[0] : null;
  if (!best) return `IMAX OPEN - The Odyssey, ${label}`;
  return `IMAX OPEN - The Odyssey, ${label} - ${rowName(best)} seat` +
    `${best.seats.length > 1 ? 's' : ''} ${best.labels}`;
}

function logSeatReport(report) {
  if (!report.ok) {
    console.log(`   seats: not read (${report.reason})`);
    return;
  }
  const { blocks, summary, wanted, largestRun } = report.recommendation;
  console.log(`   seats: ${summary.available}/${summary.total} free at ` +
    `${report.show.label}${report.show.venue ? ` (${report.show.venue})` : ''}`);
  if (blocks.length === 0) {
    console.log(`   no ${wanted} together; longest run is ${largestRun}`);
    return;
  }
  for (const b of blocks) {
    console.log(`   -> ${rowName(b)} ${b.labels} - ${b.why} (score ${b.score.toFixed(3)})`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  // Before anything else: no page load, no email, no state write, exit 0 so a
  // paused checker never looks like a broken one to cron or to Actions.
  if (STOP) {
    console.log(`STOPPED - the STOP variable is set (STOP=${STOP}).`);
    if (/^(0|false|no|off)$/i.test(STOP)) {
      console.log('Note: the value is ignored - being set at all is what pauses it.');
    }
    console.log('Nothing was checked; state.json was left untouched.');
    console.log('Delete the STOP variable to resume.');
    return;
  }

  if (CONFIG_ERRORS.length) {
    throw new Error(`Bad configuration - ${CONFIG_ERRORS.join('; ')}`);
  }

  const state = loadState();
  const watchDates = WATCH_DATES
    ? parseWatchDates(WATCH_DATES)
    : nextWeekdays(WATCH_WEEKDAY, DATES_TO_CHECK);

  const today = todayIST();
  console.log(`Today (IST): ${today}`);
  console.log(`Watching:    ${watchDates.map(humanDate).join(', ')}` +
    (WATCH_DATES ? '  (pinned via WATCH_DATES)' : ''));

  // A pinned date that has passed can never go on sale, so the run would look
  // healthy forever while watching nothing. Say so loudly.
  const stale = watchDates.filter((d) => urlDate(d) < today.replace(/-/g, ''));
  if (stale.length) {
    console.warn(`\nWARNING: ${stale.map(humanDate).join(', ')} ` +
      `${stale.length > 1 ? 'are' : 'is'} in the past - update WATCH_DATES.`);
  }
  if (PROXY_URL) console.log('Using proxy from PROXY_URL');

  const watchCodes = watchDates.map(urlDate);
  if (SEAT_CHECK) {
    console.log(`Seats:       ${SEATS} together, show nearest ` +
      `${clockLabel(SHOW_TIME_MINUTES)} (+/- ${SHOW_TIME_WINDOW} min)`);
  }

  console.log(`\nLoading ${BASE_URL}`);

  // The date strip is read from the HTML, but a seat map only exists in a live
  // page, so both happen here while the browser is still open. The seat step is
  // wrapped tightly: nothing it does may cost the "tickets are open" email.
  const seatReports = new Map();
  const fetched = await fetchPage(async (page, html, apiUrls) => {
    const parsed = extractInitialState(html);
    if (!parsed) {
      return { failure: 'window.__INITIAL_STATE__ not found - page layout may have changed' };
    }
    const analysis = analyseState(parsed, watchCodes);
    if (!analysis.ok) return { failure: analysis.reason };

    // One seat map per run at most - it is several more requests to
    // BookMyShow - and only for a date that still needs one.
    const needsSeats = analysis.results.find((r) => r.onSale &&
      (!state.notified[r.dateCode] || !state.seatAlerts[r.dateCode]));

    if (SEAT_CHECK && needsSeats) {
      console.log(`\nChecking seats for ${needsSeats.dateCode}`);
      try {
        const report = await checkSeats(page, needsSeats.dateCode, analysis, apiUrls);
        seatReports.set(needsSeats.dateCode, report);
        if (!report.ok) console.log(`   no seat recommendation: ${report.reason}`);
      } catch (e) {
        seatReports.set(needsSeats.dateCode,
          { ok: false, reason: `seat check failed: ${brief(e.message)}` });
        console.error(`   seat check failed: ${brief(e.message)}`);
      }
    }

    return { analysis };
  });

  // Every way of ending up unable to read availability funnels through here,
  // so a page that loads but no longer parses raises the alarm just like a 403.
  async function blindRun(reason) {
    state.consecutiveBlocks++;
    console.error(`\nCOULD NOT READ AVAILABILITY - ${reason}`);
    console.error(`Consecutive failed runs: ${state.consecutiveBlocks}`);

    if (state.consecutiveBlocks >= BLOCK_ALERT_THRESHOLD && !state.blockAlertSent) {
      // Only mark as sent if it actually went out, so a transient EmailJS
      // outage does not permanently swallow the warning.
      state.blockAlertSent = await notifyBlocked(state.consecutiveBlocks, reason);
    } else if (state.blockAlertSent) {
      console.error('Failure alert already sent for this outage.');
    } else {
      const left = BLOCK_ALERT_THRESHOLD - state.consecutiveBlocks;
      console.error(`Will alert after ${left} more consecutive failure(s).`);
    }

    saveState(state);
    process.exit(2);
  }

  if (fetched.blocked) await blindRun(fetched.reason);
  if (fetched.live?.failure) await blindRun(fetched.live.failure);

  const analysis = fetched.live?.analysis;
  if (!analysis) await blindRun('the page state could not be read');

  if (state.consecutiveBlocks > 0) console.log('\nRecovered - page readable again.');
  state.consecutiveBlocks = 0;
  state.blockAlertSent = false;

  console.log(`\nBooking window on sale: ${analysis.stripOnSale.join(', ') || '(none)'}`);
  console.log(`Strip covers:           ${analysis.stripRange.join(', ')}`);

  for (let i = 0; i < analysis.results.length; i++) {
    const r = analysis.results[i];
    const label = humanDate(watchDates[i]);
    console.log(`\n${label} [${r.dateCode}] -> ${r.note}`);

    const seats = seatReports.get(r.dateCode);
    if (seats) logSeatReport(seats);

    if (r.onSale && !state.notified[r.dateCode]) {
      await notifyAvailable(
        alertSubject(label, seats),
        [
          `IMAX tickets for The Odyssey are now on sale for ${label} (Chennai).`,
          ``,
          `Book now: ${BASE_URL}/${r.dateCode}`,
          ...(seats ? ['', ...seatSection(seats)] : [])
        ].join('\n')
      );
      state.notified[r.dateCode] = new Date().toISOString();
      if (seats?.ok) state.seatAlerts[r.dateCode] = new Date().toISOString();
    } else if (r.onSale && seats?.ok && !state.seatAlerts[r.dateCode]) {
      // The date's alert went out before its seat map could be read - a
      // reopened date, or a date that opened while the show was still hours
      // from being seatable. The seats are the new information, so send them.
      await notifyAvailable(
        `${SEATS} seats together - The Odyssey IMAX, ${label}`,
        [
          `Seats are now readable for ${label} (Chennai); the on-sale alert for`,
          `this date has already gone out.`,
          ``,
          `Book now: ${BASE_URL}/${r.dateCode}`,
          ``,
          ...seatSection(seats)
        ].join('\n')
      );
      state.seatAlerts[r.dateCode] = new Date().toISOString();
    } else if (r.onSale) {
      console.log('   already notified - not re-sending');
    } else if (state.notified[r.dateCode]) {
      // Went off sale again; re-arm so a reopen alerts.
      console.log('   was on sale, no longer - re-arming');
      delete state.notified[r.dateCode];
      delete state.seatAlerts[r.dateCode];
    }
  }

  saveState(state);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
