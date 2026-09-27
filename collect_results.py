"""Collect results of awarded KPPP tenders into public/results-lite.json.

For each awarded tender KPPP publishes, without a login:
  * the winner (tenderAwardDatesDTO in the tender full view), and
  * for WORKS, a "Comparative Statement" spreadsheet with every bidder's
    total quoted amount, rank (L1, L2 ...) and % against the estimate.

  * for GOODS, a similar statement with every supplier's price per item.

Results never change once awarded, so each tender is fetched once and kept in
data/results-cache.json (the list) and data/awards/{nitId}.json (the award page: timeline,
officers and every bidder's item rates); each run only looks up newly awarded tenders.
"""

import io
import time
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

from kppp_polite import make_session as polite_session
from openpyxl import load_workbook

from build_lite import district_of, iso_ist, positive

CACHE = Path("data/results-cache.json")
# Older runs kept every tender's item rates in one file; they now live in data/awards/.
ITEMS_CACHE = Path("data/item-rates-cache.json")
AWARDS = Path("data/awards")
TARGET = Path("public/results-lite.json")
RATES = Path("public/rates-lite.json")
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
SEARCH = {"WORKS": "works/search-eproc-tenders", "GOODS": "search-eproc-tenders", "SERVICES": "services/search-eproc-tenders"}
FULL_VIEW = {"WORKS": "works-tender-full-view", "GOODS": "goods-tender-full-view", "SERVICES": "service-tender-full-view"}

# Pages of 100 awarded tenders (newest first) to list per run. Each run first catches up on
# newly awarded tenders, then spends what is left on older pages, continuing from where the
# last run stopped (data/results-state.json). KPPP can take up to ~40s a page on bad days;
# the time budget below keeps the run safe then.
LIST_PAGES = {"WORKS": int(os.getenv("RESULTS_WORKS_PAGES", "20")),
              "GOODS": int(os.getenv("RESULTS_GOODS_PAGES", "6")),
              "SERVICES": int(os.getenv("RESULTS_SERVICES_PAGES", "6"))}
# Only works results are wanted for now; add "GOODS" / "SERVICES" here to collect them again.
CATEGORIES = ("WORKS",)
# The website keeps the most recent results; older ones live in the history store
# (collect_history.py) with Excel downloads.
RECENT_LIMIT = int(os.getenv("RESULTS_RECENT_LIMIT", "6000"))
# Small batches every run so KPPP never sees a burst: newest results first.
MAX_LOOKUPS = int(os.getenv("RESULTS_MAX_LOOKUPS", "150"))
# Stop listing / starting lookups after this many seconds (from the start of the run) so the
# run always finishes and saves what it has.
TIME_BUDGET = int(os.getenv("RESULTS_TIME_BUDGET", "1200"))
STATE = Path("data/results-state.json")
WORKERS = int(os.getenv("RESULTS_WORKERS", "6"))
PAGE_SIZE = 100  # collect_history.py counts pages of 100
# The two-hourly update asks for a few results at a time and stops at the first page it already knows.
SMALL_PAGE_SIZE = int(os.getenv("RESULTS_PAGE_SIZE", "25"))

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://kppp.karnataka.gov.in",
    "Referer": "https://kppp.karnataka.gov.in/",
    "Post": "CONTRACTOR-EPROC-CONTRACTOR",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def make_session():
    return polite_session(pool=WORKERS)


def list_page(session, category, page, size=PAGE_SIZE):
    response = session.post(
        f"{API}/{SEARCH[category]}?page={page}&size={size}&order-by-tender-publish=true",
        json={"category": category, "status": "AWARDED", "title": ""}, headers=HEADERS, timeout=90)
    response.raise_for_status()
    return response.json() or []


def list_awarded(session, category, cache, state, out_of_time):
    """Newly awarded tenders, until a page is already fully known.

    Older results are collected by collect_history.py, so this no longer walks back in time.
    """
    rows, budget = [], LIST_PAGES[category] * (PAGE_SIZE // SMALL_PAGE_SIZE)
    page = 0
    while budget > 0 and not out_of_time():
        batch = list_page(session, category, page, SMALL_PAGE_SIZE)
        budget -= 1
        rows.extend(batch)
        if not batch or all(str(r.get("nitId")) in cache for r in batch):
            break
        page += 1
    return rows


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def item_key(code, name, unit):
    """Match the same BOQ item across tenders: schedule code + unit + first words of the name.

    Custom codes ("code01", "Item No. 3") mean nothing across tenders, so those items match by name.
    public/app.js has the same function; keep them in step.
    """
    c = re.sub(r"\s+", "", str(code or "").lower())
    if re.fullmatch(r"(code|itemno\.?|item|sl\.?no\.?)?\d*", c):
        c = ""
    n = " ".join(re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).split()[:10])
    u = re.sub(r"\s+", "", str(unit or "").lower())
    return f"{c}|{u}|{n}"


def num(value):
    try:
        return float(str(value).replace(",", "").strip())
    except Exception:
        return None


def parse_statement(content):
    """Bidders (total, rank) and item-wise quoted rates from a WORKS comparative statement.

    Layout: bidder names sit above their "Quoted Rate" column; the next column is that
    bidder's item amount, and the "Total Bid Amount" row carries "<total> (L<rank>)" there.
    KPPP lists every item twice, so items are de-duplicated.
    """
    rows = [list(r) for r in load_workbook(io.BytesIO(content)).worksheets[0].iter_rows(values_only=True)]
    text = lambda v: clean(v).lower()
    header_at = next(i for i, r in enumerate(rows) if r and text(r[0]).startswith(("sno", "sl. no", "sl.no")))
    header = [text(v) for v in rows[header_at]]
    col = {name: header.index(name) for name in ("item name", "item code", "unit", "estimate quantity", "estimate rate") if name in header}
    quoted_cols = [j for j, h in enumerate(header) if h == "quoted rate"]
    names_row = next((r for r in reversed(rows[:header_at]) if any(r[j] not in (None, "") for j in quoted_cols if j < len(r))), [])
    totals_row = next((r for r in rows if any(text(v).startswith("total bid amount") for v in r)), [])

    bidders = []
    for j in quoted_cols:
        total = clean(totals_row[j + 1]) if j + 1 < len(totals_row) else ""
        rank = re.search(r"\(L(\d+)\)", total)
        bidders.append({
            "name": clean(names_row[j]) if j < len(names_row) else "",
            "amount": positive(re.sub(r"\(.*?\)", "", total)),
            "rank": int(rank.group(1)) if rank else None,
            "_col": j,
        })

    items, seen = [], set()
    for r in rows[header_at + 1:]:
        if any(text(v).startswith("total summary") for v in r):
            break
        get = lambda name: r[col[name]] if name in col and col[name] < len(r) else None
        name, code, unit = clean(get("item name")), clean(get("item code")), clean(get("unit"))
        qty, est = num(get("estimate quantity")), num(get("estimate rate"))
        if not name or est is None:
            continue
        rates = [num(r[b["_col"]]) if b["_col"] < len(r) else None for b in bidders]
        sig = (code, name, qty, est, tuple(rates))
        if sig in seen:
            continue
        seen.add(sig)
        items.append({"key": item_key(code, name, unit), "code": code, "name": name[:140], "unit": unit,
                      "qty": qty, "est": est, "rates": rates})

    # Order bidders (and each item's rates) by rank, L1 first.
    order = sorted(range(len(bidders)), key=lambda i: (bidders[i]["rank"] is None, bidders[i]["rank"] or 0))
    bidders = [{k: v for k, v in bidders[i].items() if k != "_col"} for i in order]
    for item in items:
        item["rates"] = [item["rates"][i] for i in order]
    return bidders, items


def parse_goods_statement(content):
    """Suppliers and their price per item from a GOODS comparative statement.

    Layout: supplier names sit above their "Item Price" columns; "Item Rate" is the department's
    rate and "Selected Supplier By Approver" names who got each item. There is no totals row, so a
    supplier's total is worked out from the items (only for suppliers who priced every item).
    """
    rows = [list(r) for r in load_workbook(io.BytesIO(content)).worksheets[0].iter_rows(values_only=True)]
    text = lambda v: clean(v).lower()
    header_at = next(i for i, r in enumerate(rows) if r and text(r[0]).startswith(("sl. no", "sl.no", "sno")))
    header = [text(v) for v in rows[header_at]]
    col = {name: header.index(name) for name in ("item name", "item code", "unit", "item rate", "quantity",
                                                 "selected supplier by approver") if name in header}
    price_cols = [j for j, h in enumerate(header) if h == "item price"]
    names_row = rows[header_at - 1] if header_at else []
    names = [clean(names_row[j]) if j < len(names_row) else "" for j in price_cols]
    keep = [k for k, n in enumerate(names) if n]
    price_cols, names = [price_cols[k] for k in keep], [names[k] for k in keep]

    items = []
    for r in rows[header_at + 1:]:
        get = lambda name: r[col[name]] if name in col and col[name] < len(r) else None
        name, code, unit = clean(get("item name")), clean(get("item code")), clean(get("unit"))
        qty, est = num(get("quantity")), num(get("item rate"))
        if not name:
            continue
        rates = [num(r[j]) if j < len(r) else None for j in price_cols]
        items.append({"key": item_key(code, name, unit), "code": code, "name": name[:140], "unit": unit,
                      "qty": qty, "est": est, "rates": rates, "winner": clean(get("selected supplier by approver")) or None})
    if not names or not items:
        return [], []

    bidders = []
    for k, bidder in enumerate(names):
        priced = [i for i in items if i["rates"][k] is not None and i["qty"]]
        full = len(priced) == len(items)
        bidders.append({"name": bidder, "amount": round(sum(i["rates"][k] * i["qty"] for i in priced), 2) if full else None,
                        "items": sum(1 for i in items if i["winner"] == bidder)})
    ranked = sorted((b for b in bidders if b["amount"]), key=lambda b: b["amount"])
    for n, b in enumerate(ranked, 1):
        b["rank"] = n
    order = sorted(range(len(bidders)), key=lambda k: (bidders[k].get("rank") is None, bidders[k].get("rank") or 0, -bidders[k]["items"]))
    bidders = [{key: v for key, v in bidders[k].items() if v not in (None, 0) or key == "rank"} for k in order]
    for item in items:
        item["rates"] = [item["rates"][k] for k in order]
    return bidders, items


def fetch_statement(session, category, nit):
    if category not in ("WORKS", "GOODS"):
        return [], []
    sheet = session.get(
        f"{API}/tender-eval/{nit}/commercial-evaluation/tender-category/{category}/commercial-comparison/download-detailed",
        headers={**HEADERS, "Accept": "*/*"}, timeout=60)
    if sheet.status_code != 200 or sheet.content[:2] != b"PK":
        return [], []
    try:
        return (parse_statement if category == "WORKS" else parse_goods_statement)(sheet.content)
    except Exception:
        return [], []


def ms_iso(ms):
    try:
        return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds") if ms else None
    except Exception:
        return None


def full_view(session, category, nit):
    full = session.get(f"{API}/{nit}/{FULL_VIEW[category]}", headers=HEADERS, timeout=40)
    full.raise_for_status()
    return full.json() or {}


def award_page(nit, category, detail, bidders, items):
    """What the award page shows beyond the results list: timeline, officers and item rates."""
    award = detail.get("tenderAwardDatesDTO") or {}
    stages = detail.get("evalStagesCompletedInfoDTO") or {}
    notice = detail.get("noticeInvitingTenderDTO") or {}
    sched = detail.get("tenderSchedule") or {}
    pbg = [{"name": clean(w.get("name")), "date": ms_iso(w.get("date"))} for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
    timeline = {
        "published": iso_ist(notice.get("publishedDate")),
        "closed": iso_ist(notice.get("tenderReceiptClose")),
        "techOpened": iso_ist(notice.get("technicalBidOpen")),
        "techApproved": ms_iso(stages.get("technicalQualificationProcessApprovedDate")),
        "finOpened": ms_iso(stages.get("commercialQualificationProcessOpenDate")),
        "finApproved": ms_iso(stages.get("commercialQualificationProcessApprovedDate")),
        "pbg": pbg[0]["date"] if pbg else None,
        "awarded": ms_iso(award.get("awardedDates")),
    }
    people = {
        "publishedBy": clean(re.sub(r"^\S+\s+-\s+", "", str(notice.get("publishedByUser") or ""))),
        "techApprover": clean(stages.get("technicalQualificationProcessApprover")),
        "opener": clean(stages.get("commercialQualificationProcessOpenBy")),
        "approver": clean(stages.get("commercialQualificationProcessApprover")),
        "contact": clean(notice.get("contactPerson")),
        "mobile": clean(notice.get("mobileNumber") or notice.get("officeNumber")),
    }
    record = {
        "nit": str(nit), "cat": category,
        "description": clean(sched.get("description")),
        "evaluation": clean(notice.get("evaluationTypeText")),
        "bidType": clean(notice.get("bidValueTypeText")),
        "call": notice.get("noOfCalls"),
        "emd": positive(notice.get("emd")), "fee": positive(notice.get("tenderFee")),
        "timeline": {k: v for k, v in timeline.items() if v},
        "people": {k: v for k, v in people.items() if v},
        "pbg": pbg,
        "bidders": bidders,
        "items": items,
    }
    return {k: v for k, v in record.items() if v not in (None, "", [], {})}


def with_pct(bidders, estimate):
    # KPPP's own "% against Estimated Rate" is taken against a double-counted
    # estimate, so work it out from the tender's estimated contract value.
    for bidder in bidders:
        bidder["pct"] = round((bidder["amount"] / estimate - 1) * 100, 2) if estimate and bidder.get("amount") else None
    return bidders


def goods_estimate(items):
    if items and all(i.get("est") and i.get("qty") for i in items):
        return sum(i["est"] * i["qty"] for i in items)
    return None


def lookup(session, category, raw):
    nit = raw.get("nitId")
    detail = full_view(session, category, nit)
    award = detail.get("tenderAwardDatesDTO") or {}
    winners = [clean(w.get("name")) for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
    bidders, items = fetch_statement(session, category, nit)
    estimate = positive(raw.get("ecv")) if category == "WORKS" else (goods_estimate(items) or positive(raw.get("ecv")))
    with_pct(bidders, estimate)
    awarded_ms = award.get("awardedDates")
    office = clean(raw.get("locationName"))
    title = clean(raw.get("title"))
    record = {
        "nit": str(nit),
        "ref": clean(raw.get("tenderNumber")),
        "title": title,
        "cat": category,
        "dept": clean(raw.get("deptName")),
        "office": office,
        "district": district_of(office, title, raw.get("description")),
        "work": clean(raw.get("workCategoryName")),
        "value": positive(raw.get("ecv")) if raw.get("ecvtenderYn") else None,
        "published": iso_ist(raw.get("publishedDate")),
        "closed": iso_ist(raw.get("tenderClosureDate")),
        "awarded": ms_iso(awarded_ms),
        "winner": winners[0] if winners else (bidders[0]["name"] if bidders else None),
        "bidders": bidders,
    }
    record = {k: v for k, v in record.items() if v not in (None, "", [])}
    return record, award_page(nit, category, detail, bidders, items)


def backfill_award(session, record, old_items):
    """Award page for a result collected before award pages existed (and goods bidders)."""
    nit, category = record["nit"], record["cat"]
    detail = full_view(session, category, nit)
    bidders, items = list(record.get("bidders") or []), old_items
    if not bidders or items is None:
        bidders, items = fetch_statement(session, category, nit)
        sched = detail.get("tenderSchedule") or {}
        estimate = positive(sched.get("ecv")) if category == "WORKS" else (goods_estimate(items) or positive(sched.get("ecv")))
        with_pct(bidders, estimate)
    if bidders and not record.get("bidders"):
        record = {**record, "bidders": bidders}
        record.setdefault("winner", bidders[0]["name"])
    return record, award_page(nit, category, detail, record.get("bidders") or [], items or [])


def quantiles(values):
    v = sorted(values)
    pick = lambda q: round(v[min(len(v) - 1, int(q * (len(v) - 1) + 0.5))], 2)
    return [pick(0), pick(0.25), pick(0.5), pick(0.75), pick(1)]


def build_rates(results, items_by_nit):
    """Per BOQ item: what winners (L1) and all bidders quoted, against the department's rate."""
    groups = {}
    for nit, items in items_by_nit.items():
        result = results.get(nit) or {}
        if result.get("cat") != "WORKS":
            continue
        for item in items:
            rates = item.get("rates") or []
            est = item.get("est")
            if not rates or not est or est <= 0 or rates[0] is None or rates[0] <= 0:
                continue
            g = groups.setdefault(item["key"], {"names": {}, "unit": item.get("unit"), "code": item.get("code"),
                                                "l1": [], "all": [], "ratio": [], "est": [], "tenders": set(), "recent": []})
            g["names"][item["name"]] = g["names"].get(item["name"], 0) + 1
            g["l1"].append(rates[0])
            g["all"].extend(r for r in rates if r and r > 0)
            g["ratio"].append(rates[0] / est)
            g["est"].append(est)
            g["tenders"].add(nit)
            g["recent"].append((result.get("awarded") or "", rates[0], est, result.get("district") or "", nit))
    out = {}
    for key, g in groups.items():
        recent = sorted(g["recent"], reverse=True)[:5]
        out[key] = {
            "name": max(g["names"], key=g["names"].get),
            "code": g["code"], "unit": g["unit"],
            "tenders": len(g["tenders"]),
            "est": quantiles(g["est"])[2],
            "l1": quantiles(g["l1"]),
            "all": quantiles(g["all"])[1:4],
            "ratio": round(quantiles(g["ratio"])[2], 4),
            "recent": [{"date": d[:10], "rate": r, "est": e, "district": dist, "nit": n} for d, r, e, dist, n in recent],
        }
    return out


def award_path(nit):
    return AWARDS / f"{nit}.json"


def main():
    session = make_session()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    old_items = json.loads(ITEMS_CACHE.read_text(encoding="utf-8")) if ITEMS_CACHE.exists() else {}
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    AWARDS.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    out_of_time = lambda: time.monotonic() - started > TIME_BUDGET
    todo, seen = [], set()
    # Drop categories that are no longer collected.
    for nit in [n for n, r in cache.items() if r.get("cat") not in CATEGORIES]:
        cache.pop(nit)
        award_path(nit).unlink(missing_ok=True)
    for category in CATEGORIES:
        try:
            listed = list_awarded(session, category, cache, state, out_of_time)
        except Exception as exc:
            print(f"Could not list awarded {category}: {exc}", flush=True)
            continue
        print(f"{category}: {len(listed)} awarded tenders listed ({int(time.monotonic() - started)}s)", flush=True)
        for raw in listed:
            nit = str(raw.get("nitId") or "")
            if nit and nit not in cache and nit not in seen:
                seen.add(nit)
                todo.append((category, raw))
    # Results collected before award pages existed get one now (newest first).
    backfill = sorted((r for nit, r in cache.items() if not award_path(nit).exists()),
                      key=lambda r: r.get("awarded") or "", reverse=True)
    todo = todo[:MAX_LOOKUPS]
    backfill = backfill[:max(0, MAX_LOOKUPS - len(todo))]
    print(f"{len(todo)} new results to look up, {len(backfill)} award pages to backfill", flush=True)

    ok = failed = 0

    def save():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        STATE.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")

    def guarded(job):
        # Jobs queued after the time budget are skipped, not started.
        if out_of_time():
            return None
        kind, cat, payload = job
        if kind == "new":
            return lookup(session, cat, payload)
        return backfill_award(session, payload, old_items.get(payload["nit"]))

    jobs = [("new", cat, raw) for cat, raw in todo] + [("award", r["cat"], r) for r in backfill]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(guarded, job) for job in jobs]
        for future in as_completed(futures):
            try:
                done = future.result()
            except Exception:
                failed += 1
                continue
            if done is None:
                continue
            record, page = done
            cache[record["nit"]] = record
            award_path(record["nit"]).write_text(json.dumps(page, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            ok += 1
            if ok % 200 == 0:
                save()
                print(f"  {ok} done ({int(time.monotonic() - started)}s)", flush=True)

    # Keep only the most recent results for the website.
    recent = sorted(cache.values(), key=lambda r: r.get("awarded") or r.get("closed") or "", reverse=True)
    for record in recent[RECENT_LIMIT:]:
        cache.pop(record["nit"], None)
        award_path(record["nit"]).unlink(missing_ok=True)
    save()
    # The old single item-rates file is no longer needed once every tender has its award page.
    if ITEMS_CACHE.exists() and all(award_path(nit).exists() or nit not in cache for nit in old_items):
        ITEMS_CACHE.unlink()
    items_by_nit = {}
    for path in AWARDS.glob("*.json"):
        try:
            items = json.loads(path.read_text(encoding="utf-8")).get("items")
        except Exception:
            continue
        if items:
            items_by_nit[path.stem] = items
    for nit, items in old_items.items():
        if nit in cache:
            items_by_nit.setdefault(nit, items)

    results = sorted(cache.values(), key=lambda r: r.get("awarded") or r.get("closed") or "", reverse=True)
    TARGET.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(results),
        "results": results,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    rates = build_rates(cache, items_by_nit)
    RATES.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tenders": sum(1 for nit in items_by_nit if (cache.get(nit) or {}).get("cat") == "WORKS"),
        # The tender page only reads the winning-rate spread and how many tenders it comes from.
        "items": {key: {"l1": g["l1"], "tenders": g["tenders"]} for key, g in rates.items()},
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_bids = sum(1 for r in results if r.get("bidders"))
    pages = sum(1 for _ in AWARDS.glob("*.json"))
    print(f"Done {ok} jobs, {failed} failed. {len(results)} results, {with_bids} with bidder amounts "
          f"({TARGET.stat().st_size / 1e6:.2f} MB); {pages} award pages; {len(rates)} BOQ items with past rates "
          f"({RATES.stat().st_size / 1e6:.2f} MB).")


if __name__ == "__main__":
    main()
