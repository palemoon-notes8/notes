# TenderOne

Karnataka tender desk — a Cloudflare Worker (`worker/index.js`) serving the site in `public/` (`index.html`, `app.js`, `app.css`). No login: every visitor sees the live tenders.

## Tender data

The hourly GitHub Action (`.github/workflows/collect-kppp.yml`) runs:

1. `fetch_kppp.py` — collects every published tender from KPPP into `public/tenders.json`.
2. `fix_financial_fields.py` — keeps the best tender value from the raw KPPP fields.
3. `enrich_fees.py` — adds EMD and tender fee from KPPP's public per-tender "general info" endpoint, cached in `data/kppp-fees.json` so each run only looks up new tenders.
4. `build_lite.py` — writes `public/tenders-lite.json`, the small file the website loads, with districts matched from KPPP office names.

An action every 2 hours (`.github/workflows/collect-results.yml`) runs `collect_results.py`, which stores awarded tenders — winner, every bidder's quoted total and rank from KPPP's public comparative statement (works and goods) — in `public/results-lite.json` (cached in `data/results-cache.json`). Each awarded tender also gets an award page, `data/awards/{nitId}.json`: timeline (closing → bids opened → approved → performance guarantee → award), officers, and every bidder's item-wise rates. From those it builds `public/rates-lite.json`: for each BOQ item (schedule code + unit + description), what winning (L1) bidders quoted against the department's rate. The bid % is computed against the tender's estimated value, because the % in KPPP's statement double-counts the estimate.

An hourly action (`.github/workflows/collect-details.yml`) runs `collect_details.py`, which keeps a copy of every live tender's full KPPP details and documents list in the `data` branch (`details/{CATEGORY}/{nitId}.json`, one snapshot commit that replaces the last). The website serves that copy, so tender pages open instantly, and asks KPPP live only for tenders not collected yet. When a department changes the closing date, EMD, fee, value or documents, the change is recorded and shown on the tender page.

Every 6 hours `.github/workflows/collect-history.yml` runs `collect_history.py`: four parts at once look up every awarded **works** tender since May 2023 (about 1 lakh) and merge them into the `history` branch (one snapshot commit): monthly results and item-wise rates, Excel downloads per year (`/downloads/works-results-YYYY.xlsx`, `/downloads/works-item-rates.xlsx`), `similar.json` (how similar tenders were won, per department / district and type of work, used by the tender page) and `rates.json.gz` (past winning rates per BOQ item, attached to each live works tender by `collect_details.py`). A bidder database (`works-bidders.xlsx`: every bidder's bids, wins, win rate and value won overall and by year, district, department and type of work) and `leaders.json` (top bidders by wins per district and year) are built with it, plus the data behind the **Bidders** tab: `bidders.json` (every bidder with bids, wins, value won, latest bid and districts), each bidder's full tender list in `contractors/{xx}.json`, and `bids/{YYYY-MM}/{xx}.json` (every bidder's amount and item-wise rates for each tender, served by the worker at `/api/tender-bids/{nitId}?m=YYYY-MM`). `quick.json` covers tenders published and closed fast (under 7 days, or the 7-day minimum): competition by time to bid, the months they cluster in, the offices that use short deadlines and who wins them. The website shows it as the Quick tenders panel on Past results, a ⚡ badge and "Time to bid" filter on live tenders, and a note on the tender page. Past tender pages also ask KPPP for the tender's conditions (EMD, fee, eligibility, required documents, contact) when opened.

KPPP only marks a tender "Reserved". `collect_details.py` reads the title, conditions and document names to tell who it is reserved for (SC, ST, Category I, II-A, II-B) and keeps every reserved tender it has seen in `details/reserved.json` on the data branch (served at `/reserved.json`), so reserved tenders can later be matched with their results. The website marks them on cards, results and tender pages. It has an "I can bid (SC)" / "SC reserved only" filter and a banner with the number of SC-reserved tenders open now. Item-wise bids (every BOQ item with the L1–L5 bidders' rates) are written as one Excel file per month and uploaded to the `itemwise` GitHub release (only changed months), so they do not grow the repository; the worker serves them at `/downloads/itemwise-YYYY-MM.xlsx`. The website's Past results list keeps the most recent 6,000 works results; goods and services results are no longer collected.

`.github/workflows/scheduler.yml` starts these collectors on time (GitHub's own cron is often hours late for small projects) and keeps itself running; the cron lines in each workflow are only a backup.

The website is private: without the sign-in cookie every address answers a plain 404. The sign-in page is at a secret address (only its SHA-256 is in `worker/index.js`); it asks for one password (only a double SHA-256 of it is stored) and remembers each device for a year with an HttpOnly cookie. `/logout` signs a device out. Lost the password or the sign-in address? Run `python reset_login.py`, which prints a new pair and updates the hashes, then push `worker/index.js` to main. The history collector runs once a day (22:00 UTC).

Data commits carry a skip-build marker: the website reads the data straight from GitHub, so only code changes need a redeploy.

The Worker serves the data files from this repo, falling back to the deployed copy.

## Deploying

Cloudflare builds and deploys the Worker (configured in `wrangler.jsonc`) from this repo's `main` branch through its Git integration (Worker → Settings → Build). No secrets are needed.

To run locally: `npm ci && npx wrangler dev`.


## Being gentle with KPPP

KPPP blocks callers that send too many requests too quickly (HTTP 503 for several minutes). Every collector connects through `kppp_polite.py`: at most one request every `KPPP_MIN_INTERVAL` seconds (1.5 by default, 4 for each of the four history jobs), and when KPPP says it is busy or does not answer, all requests pause for 30 seconds, doubling up to 5 minutes, instead of retrying at once. The tender list also pauses `KPPP_PAGE_DELAY` seconds (4) between pages.

Collection is done in small pieces:

- **Tender list (hourly):** only the newest tenders, 25 per page, stopping at the first page with nothing new (usually 3–5 small requests). Tenders already known stay on the list until they close. A slow full refresh runs once a day in the early morning (India time) to pick up changed dates and cancelled tenders (`last_full_at` in `public/tenders.json`; `KPPP_FULL=1` forces one).
- **Tender details:** at most 150 tenders per hourly run, new tenders first, each re-checked once a day.
- **EMD/fee checks:** at most 100 per run.
- **Results (every 2 hours):** 25 per page, stopping at the first page already known; at most 150 look-ups per run, newest first.
- **History:** daily runs look only at the newest awards; a full pass over every page runs on Sundays.
- **Likely competitors:** each nightly history build writes `competitors.json` (served at `/competitors.json`): for every office, and for every department + district + type of work as a fallback, the 8 contractors who bid most often in the last 3 years, with bids, wins, usual quote and last bid. Live works tender pages show it.
- `.github/pause-until` (a UTC time) pauses every collector until then.
- If KPPP refuses 3 times in a row, a run stops asking altogether (`KPPP_GIVE_UP`); the next scheduled run tries again.
