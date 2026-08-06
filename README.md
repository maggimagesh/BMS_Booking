# BookMyShow IMAX Availability Checker

I built this to avoid repeatedly refreshing BookMyShow while waiting for tickets
to open. It watches a chosen movie, city, and format page, then emails me when
one of the dates I care about becomes bookable — and, when it can, tells me
which seats to book.

It is a notification tool only. It does not log in, reserve seats, add anything
to a cart, or complete a booking.

## How it works

On each run, the checker opens the BookMyShow buytickets page for the event I
configured. It reads the page's server-rendered state and checks the availability
status of the relevant dates. By default, it watches the next two Mondays in
India time (IST).

When a watched date opens:

- it sends an EmailJS email with a direct BookMyShow link;
- it records that alert in state.json, so the same date is not emailed again;
- if the date later disappears, its alert is re-armed.

### The seat recommendation

When a watched date is on sale, the checker goes one step further than "it is
open". It finds the show nearest SHOW_TIME (7:30 pm by default), opens that
show's seat map, and works out where SEATS people can sit **next to each other**
with the best view. The alert then reads:

~~~
IMAX OPEN - The Odyssey, Monday, 3 August 2026 - Row H seats H11-H12

Best 2 seats together:
  1. Row H, seats H11-H12 (Rs 250 each)
     62% of the way back, dead centre - GOLD
  2. Row J, seats J11-J12 (Rs 250 each)
     73% of the way back, dead centre - GOLD

Availability: 142 of 240 seats free (59%), 14 rows.
~~~

"Best" means as close as possible to the sweet spot for a large-format screen:
about 62% of the way back from the screen (SEAT_IDEAL_ROW) and centred in the
hall. Rows in front of the sweet spot are penalised harder than rows behind it,
and being off-centre sideways costs more than being a row out. Seats separated
by an aisle are never offered as "together", even when their numbers run
straight through it.

Two limits are worth knowing before you rely on it:

- **It reads the seat map, so it can only report what the map says.** A layout
  that needs a login, or a show not yet open for seat selection, produces an
  alert that says exactly that instead of a recommendation. The date alert
  itself is never held up by a seat check that fails.
- **Reading a future date's seats means going to that date's page.** The page
  the checker loads embeds only the currently selected day's schedule, so for
  any other date it goes and fetches that day's: first the link the date strip
  itself points at, then the date's URL, then the date chip, then the site's
  own showtimes API. Whatever comes back is checked before it is believed —
  being handed today's schedule again is the failure that would otherwise look
  like success, and it is caught by comparing session ids, which are unique per
  showing. If none of the four routes produces a schedule that provably belongs
  to the requested date, the alert says so and names what was tried, rather
  than recommending a seat at the wrong show. Dates whose seats could not be
  read yet get a short follow-up email once they can be.

Set the SEAT_CHECK variable to 0 to skip all of this and alert on the date
opening only.

The workflow also detects when it cannot reliably read the page (for example, a
Cloudflare block or a page-layout change). After three consecutive failed runs,
it sends a separate failure email and uploads the returned HTML and screenshot
as a GitHub Actions artifact.

Most runs make a single BookMyShow page request. A run only does more when a
watched date is on sale and still needs a seat recommendation: it then also
loads that date's page and, from there, one seat map. It never reads more than
one seat map per run, and once a date's seats have been reported it stops
asking. Please keep the cadence reasonable and comply with BookMyShow's terms
and policies.

## Use your own copy

1. Fork this repository, or clone it into a repository you control.
2. Keep .github/workflows/check-imax.yml; it is the GitHub Actions runner.
3. Configure EmailJS and repository settings as described below.
4. Run the **Check IMAX Availability** workflow once manually and verify that
   you receive the test result in the Actions log.

For GitHub Actions, open **Settings → Actions → General** and allow workflows
to have **Read and write permissions**. The workflow needs this to commit the
updated state.json file after each run. Without it, the checker can run but
will forget which alerts it has already sent.

## Configure the movie, city, format, and dates

### Find the target URL

Open the exact BookMyShow listing you want to watch and copy its buytickets
URL. It must contain the correct city and event code, for example:

~~~
https://in.bookmyshow.com/movies/chennai/example-film/buytickets/ET01234567
~~~

Use the URL **without a trailing date**. The event code is format-specific, so
the 2D, IMAX, 3D, and other listings for the same film may have different URLs.
Choose the listing for the format you actually want.

### Repository variables

In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and
add the following values.

| Variable        | Required | Value |
| --------------- | -------- | ----- |
| TARGET_URL_BASE | Yes      | The buytickets URL found above, with no trailing date. |
| WATCH_DATES     | No       | Specific dates to watch, comma-separated: 2026-08-15,2026-08-22. This overrides the weekday settings. |
| WATCH_WEEKDAY   | No       | Weekday to watch, such as monday or friday. Names and 0–6 (0 is Sunday) work. Default: monday. |
| DATES_TO_CHECK  | No       | Number of upcoming matching weekdays to watch. Default: 2. |
| STOP            | No       | A non-empty value pauses every run. Delete the variable to resume; STOP=0 also pauses it. |
| SEATS           | No       | How many seats together to look for. Default: 2. |
| SHOW_TIME       | No       | Which show to read seats for: 19:30 or 7:30 PM. Default: 19:30. |
| SHOW_TIME_WINDOW| No       | How many minutes from SHOW_TIME still counts as that show. Default: 45. |
| SEAT_CHECK      | No       | Set to 0 to alert on the date opening only, with no seat check. Default: on. |
| SEAT_IDEAL_ROW  | No       | Where the sweet spot is: 0 is the front row, 1 the back. Default: 0.62. |
| SEAT_OPTIONS    | No       | How many alternative blocks of seats to list. Default: 3. |

Use either WATCH_DATES or the weekday settings:

~~~
# Watch the next two Fridays
WATCH_WEEKDAY=friday
DATES_TO_CHECK=2

# Or watch only these exact dates
WATCH_DATES=2026-08-15,2026-08-22
~~~

BookMyShow generally exposes only a short booking window. A future date may
correctly show as unavailable until it enters that window.

## Configure email alerts with EmailJS

EmailJS delivers both the ticket-open alert and the checker-failure alert.

1. Create an account at [EmailJS](https://www.emailjs.com/).
2. Open **Email Services**, connect an email provider, and send its test email.
3. In **Email Templates**, create two templates:
   - a ticket-open template;
   - a failure-warning template.
4. In both templates set:
   - **To Email** to {{to_email}};
   - subject to {{subject}};
   - message/body to {{message}}.
5. On **Account → Security**, enable non-browser/API use and create or reveal a
   private key. This project runs from Node.js on GitHub, not from a browser.

EmailJS provides the values in its dashboard:

| Value needed | Where to get it |
| ------------ | --------------- |
| Service ID   | Open **Email Services** and select the connected service. |
| Template IDs | Open **Email Templates** and select each template. |
| Public key   | **Account** page. |
| Private key  | **Account → Security** after enabling private-key/API access. |

The send request needs the service ID, template ID, public key, and template
parameters; this is the EmailJS REST API contract. See the [EmailJS send API](https://www.emailjs.com/docs/rest-api/send/)
and [EmailJS template guide](https://www.emailjs.com/docs/user-guide/creating-email-templates/)
if the dashboard changes.

### Repository secrets

In GitHub, open **Settings → Secrets and variables → Actions → Secrets** and
create these secrets. Do not commit any of them to .env, state.json, or the
repository.

| Secret                      | Required                | What to store |
| --------------------------- | ----------------------- | ------------- |
| TO_EMAIL                    | Yes                     | The email address that should receive alerts. |
| EMAILJS_SERVICE_ID          | Yes                     | EmailJS service ID. |
| EMAILJS_TEMPLATE_ID         | Yes                     | Ticket-open template ID. |
| EMAILJS_FAILURE_TEMPLATE_ID | Yes, for failure emails | Failure-warning template ID. |
| EMAILJS_PUBLIC_KEY          | Yes                     | EmailJS public key. |
| EMAILJS_PRIVATE_KEY         | Yes                     | EmailJS private key. Keep this private. |
| PROXY_URL                   | No                      | A residential proxy URL, such as http://user:password@host:port, only if BookMyShow blocks the runner IP. |

TO_EMAIL is not a credential, but I still store it as a secret because the
workflow reads it from the secrets store and it avoids exposing a personal email
address in repository settings.

## Run and verify GitHub Actions

Go to **Actions → Check IMAX Availability → Run workflow**. Leave the inputs
blank to use the repository variables, or use watch_dates for a one-off test.

Check that the log shows the target URL, the watched dates, and a result for
each date. If a run cannot read the page, download its **debug-artifacts**
artifact from the workflow run before changing anything.

The included schedule triggers at :02, :17, :32, and :47 of every hour. Runs
are serialized so they cannot race while updating state.json.

## If the GitHub Actions schedule is unreliable: trigger it with cron-job.org

cron-job.org cannot run this Node.js project directly. Instead, it can call the
GitHub API to start the existing workflow_dispatch workflow. GitHub then runs
the project with the same repository variables, secrets, browser setup, and
state handling.

### 1. Prevent duplicate schedules

If you are moving to cron-job.org permanently, remove or comment out only the
schedule section in .github/workflows/check-imax.yml, while keeping
workflow_dispatch. Commit and push that change. Do **not** disable the whole
workflow: a disabled workflow cannot be started by the API.

The trigger section should begin like this after the change:

~~~yaml
on:
  workflow_dispatch:
    inputs:
      # keep the existing inputs below this line
~~~

If you leave the built-in schedule enabled, both schedulers can start runs. The
workflow will serialize them and state prevents duplicate ticket emails, but it
creates unnecessary requests and Actions usage.

### 2. Create a narrowly scoped GitHub token

In GitHub, open **Settings → Developer settings → Personal access tokens →
Fine-grained tokens**.

- Limit the token to this one repository.
- Give it **Actions: Read and write** repository permission.
- Set an expiry date and copy the token immediately.

Store this token only in cron-job.org's request header. It is a credential: do
not place it in the repository, GitHub variables, or the cron job URL. GitHub's
[workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
requires Actions: write for a fine-grained token.

### 3. Create the cron-job.org HTTP job

In [cron-job.org](https://cron-job.org/), create a new job with these settings.
Replace YOUR_OWNER, YOUR_REPOSITORY, and YOUR_BRANCH with your fork's values.
YOUR_BRANCH is usually main or master.

| Field          | Value |
| -------------- | ----- |
| Title          | BookMyShow availability checker |
| URL            | https://api.github.com/repos/YOUR_OWNER/YOUR_REPOSITORY/actions/workflows/check-imax.yml/dispatches |
| Request method | POST |
| Request body   | {"ref":"YOUR_BRANCH"} |
| Header         | Authorization: Bearer YOUR_FINE_GRAINED_TOKEN |
| Header         | Accept: application/vnd.github+json |
| Header         | Content-Type: application/json |
| Schedule       | Every 15 minutes, preferably at minutes 02, 17, 32, and 47 |

Enable failure notifications in cron-job.org as an extra signal that the GitHub
API request itself failed. A successful dispatch normally returns a no-content
response; the actual checker result will appear in the GitHub Actions run.

cron-job.org supports custom HTTP methods, headers, and request bodies. Its
[job setup documentation](https://docs.cron-job.org/creating-cron-jobs.html)
and [REST API reference](https://docs.cron-job.org/rest-api.html) are useful if
its UI changes.

### 4. Test the external trigger

Use cron-job.org's **Run now** option, then open the repository's **Actions**
tab. A new **Check IMAX Availability** run should appear. If cron-job.org shows
401 or 403, recreate the GitHub token, confirm its repository selection, and
confirm it has **Actions: Read and write** permission.

## Run it locally

Local runs are useful for testing configuration before committing anything:

~~~bash
npm install
npm run browsers
cp .env.example .env
# Fill in TARGET_URL_BASE and the EmailJS values in .env
npm run check:local
~~~

.env is ignored by Git. Keep it that way.

The seat picker has its own tests, which need neither a network nor a browser:

~~~bash
npm test
~~~

They cover which seats count as "together" (including the rule that an aisle
splits a block, however the seats either side of it are numbered), which
block of seats wins, how the statuses in a BookMyShow layout are read, and how
the ~7:30 pm show is chosen.

The local-only tuning values in .env.example are:

| Variable              | Default | Purpose |
| --------------------- | ------- | ------- |
| MAX_ATTEMPTS          | 3       | Page-load attempts in a single local run. |
| BLOCK_ALERT_THRESHOLD | 3       | Consecutive unreadable runs before a failure email. |
| FINGERPRINT_SEED      | Random  | Replays a fingerprint printed in an earlier log for debugging. |

The hosted workflow currently fixes the failure threshold at three and accepts a
fingerprint seed only through the manual workflow input. Adding these names as
repository variables will not change the hosted workflow.

## Operational notes

- state.json is intentionally committed by GitHub Actions. It holds the
  notification history and consecutive-failure count; do not delete it unless
  you deliberately want to reset those records.
- Set STOP to any non-empty value to pause safely. It makes no BookMyShow
  request and does not alter state.json.
- If BookMyShow blocks a GitHub-hosted IP, PROXY_URL is the available
  configuration escape hatch. It should be a legitimate proxy you are
  authorized to use.
- A CAPTCHA, an IP ban, or a BookMyShow page redesign can still prevent this
  checker from working. Treat its failure email as a prompt to check manually.
