"""Keep a copy of every live tender's full KPPP details, so the website opens them instantly.

KPPP's tender page can be slow, so instead of asking KPPP each time someone opens a tender,
this collector fetches each live tender's full view and documents list in the background and
stores it in the "data" branch as details/{CATEGORY}/{nitId}.json. The website reads that copy
first and only asks KPPP live when a tender has not been collected yet.

Each run: new tenders first, then refreshes the oldest copies. When a department changes the
closing date, EMD, fee, value or documents (a corrigendum), the change is recorded so the
tender page can show it.
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import collections
import gzip
import re

import requests

from kppp_polite import make_session as polite_session

from build_lite import CATS, GEN, HINT
from collect_results import item_key

STORE = Path(sys.argv[1] if len(sys.argv) > 1 else "store") / "details"
LIVE = Path("public/tenders-lite.json")
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
VIEW = {"WORKS": "works-tender-full-view", "GOODS": "goods-tender-full-view", "SERVICES": "service-tender-full-view"}
FILES = {"WORKS": "get-works-tender-files", "GOODS": "get-goods-tender-files", "SERVICES": "get-services-tender-files"}
# Only what the website's tender page uses (worker/index.js shapeTender).
KEEP = ("noticeInvitingTenderDTO", "tenderSchedule", "tenderAddress", "generalCriterionList",
        "tenderEligibilityCriterionList", "technicalCriterionList", "tenderTechnicalCriterionList",
        "tenderCriterionDocumentList", "tenderSubEstimateList", "tenderGroups")
# Past winning rates for every BOQ item, built by collect_history.py from all awarded works.
RATES_URL = "https://raw.githubusercontent.com/palemoon-notes8/notes/history/rates.json.gz"
REFRESH_HOURS = float(os.getenv("DETAILS_REFRESH_HOURS", "24"))
# Small batches each hour so KPPP never sees a burst: new tenders first, then the oldest copies.
MAX_PER_RUN = int(os.getenv("DETAILS_MAX_PER_RUN", "150"))
TIME_BUDGET = int(os.getenv("DETAILS_TIME_BUDGET", "1500"))
WORKERS = int(os.getenv("DETAILS_WORKERS", "8"))

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://kppp.karnataka.gov.in",
    "Referer": "https://kppp.karnataka.gov.in/",
    "Post": "CONTRACTOR-EPROC-CONTRACTOR",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def make_session():
    return polite_session(pool=WORKERS)


def strip(value):
    """Drop KPPP's bookkeeping fields and empty values to keep the stored copy small."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in ("createdTs", "version", "createdDate", "modifiedDate", "id") or v in (None, "", [], {}):
                continue
            v = strip(v)
            if v not in (None, "", [], {}):
                out[k] = v
        return out
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


def watched(full, files):
    """The facts a corrigendum usually changes."""
    nit = full.get("noticeInvitingTenderDTO") or {}
    sched = full.get("tenderSchedule") or {}
    return {
        "Bid submission ends": nit.get("tenderReceiptClose"),
        "Bids open": nit.get("technicalBidOpen"),
        "Last date for questions": nit.get("tenderQueryClose"),
        "EMD": nit.get("emd"),
        "Tender fee": nit.get("tenderFee"),
        "Tender value": sched.get("ecv"),
        "Documents": len(files) if isinstance(files, list) else None,
    }


def fetch(session, cat, nit, old):
    full = session.get(f"{API}/{nit}/{VIEW[cat]}", headers=HEADERS, timeout=60)
    full.raise_for_status()
    full = full.json() or {}
    if not full.get("tenderSchedule"):
        raise ValueError("empty full view")
    try:
        files = session.get(f"{API}/{nit}/{FILES[cat]}", headers=HEADERS, timeout=90)
        files.raise_for_status()
        files = [{"uuid": f.get("uuid"), "fileName": f.get("fileName"), "documentType": f.get("documentType")}
                 for f in files.json() or [] if f.get("uuid")]
    except Exception:
        files = (old or {}).get("files")  # keep the last good list; the website asks KPPP live if none
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    changes = list((old or {}).get("changes") or [])
    if old and old.get("full"):
        before, after = watched(old["full"], old.get("files")), watched(full, files)
        for field, value in after.items():
            was = before.get(field)
            if value not in (None, "") and was not in (None, "") and str(value) != str(was):
                changes.append({"at": now, "field": field, "from": was, "to": value})
    record = {"nit": str(nit), "cat": cat, "fetched": now, "full": strip({k: full.get(k) for k in KEEP}),
              "files": files, "changes": changes[-20:]}
    return {k: v for k, v in record.items() if v not in (None, [])}


# ---------- Who a reserved tender is for (SC / ST / Category-I / II-A / II-B) ----------
# KPPP only says "Reserved"; the category is written in the title, conditions or document names.
# GEN, CATS and HINT (the category patterns) live in build_lite.py, which also uses them on the tender list.

def reservation(full):
    """SC / ST / Cat-1 / Cat-2A / Cat-2B for a reserved tender, from its title, conditions and document names."""
    title = (full.get("tenderSchedule") or {}).get("title") or ""
    texts = [title]
    texts += [e.get("description") or "" for e in full.get("generalCriterionList") or [] if isinstance(e, dict)]
    texts += [e.get("description") or "" for e in full.get("tenderEligibilityCriterionList") or [] if isinstance(e, dict)]
    texts += [x.get("documentName") or "" for x in full.get("tenderCriterionDocumentList") or [] if isinstance(x, dict)]
    votes = collections.Counter()
    for text in texts:
        text = GEN.sub(" ", text)
        if not HINT.search(text):
            continue
        found = {name for name, rx in CATS if rx.search(text)}
        if len(found) == 1:  # a sentence naming several categories is a general rule, not this tender's
            votes[found.pop()] += 1
    if not votes:
        return None
    top = max(votes.values())
    return "/".join(n for n, _ in CATS if votes[n] == top)


def write_reserved():
    """details/reserved.json: {nit: category} for every reserved tender seen, kept after it closes so past results can be matched."""
    path = STORE / "reserved.json"
    known = (load_json_file(path) or {}).get("tenders") or {}
    for file in STORE.glob("*/*.json"):
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        full = record.get("full") or {}
        if (full.get("noticeInvitingTenderDTO") or {}).get("invitingStrategyText") != "Reserved":
            continue
        known[str(record.get("nit"))] = reservation(full) or "Reserved"
    path.write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tenders": known},
                               separators=(",", ":")), encoding="utf-8")
    return len(known)


def load_json_file(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_rates():
    try:
        response = requests.get(RATES_URL, timeout=120)
        response.raise_for_status()
        return json.loads(gzip.decompress(response.content))
    except Exception as exc:
        print(f"Past item rates not available yet ({exc})", flush=True)
        return None


def add_past_rates(rates):
    """Attach past winning rates to each stored works tender's BOQ items (the tender page shows them)."""
    changed = 0
    for path in (STORE / "WORKS").glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        past = {}
        for group in (record.get("full") or {}).get("tenderSubEstimateList") or []:
            for item in group.get("itemList") or []:
                key = item_key(item.get("itemCode"), item.get("description"), item.get("uomName"))
                hit = rates.get(key)
                if hit:
                    past[key] = {"l1": hit["l1"], "tenders": hit["tenders"]}
        if past != record.get("past"):
            if past:
                record["past"] = past
            else:
                record.pop("past", None)
            path.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
    return changed


def main():
    started = time.monotonic()
    live = json.loads(LIVE.read_text(encoding="utf-8")).get("tenders") or []
    wanted = {}
    for t in live:
        if t.get("nit") and t.get("cat") in VIEW:
            wanted[(t["cat"], str(t["nit"]))] = t.get("published") or ""

    # Remove copies of tenders that are no longer live.
    removed = 0
    for path in STORE.glob("*/*.json"):
        if (path.parent.name, path.stem) not in wanted:
            path.unlink()
            removed += 1

    # File times are reset by git checkout, so the age comes from the "fetched" stamp inside.
    cutoff = datetime.now(timezone.utc).timestamp() - REFRESH_HOURS * 3600
    fresh, stale = [], []
    for (cat, nit), published in wanted.items():
        path = STORE / cat / f"{nit}.json"
        if not path.exists():
            fresh.append((published, cat, nit))
            continue
        try:
            fetched = datetime.fromisoformat(json.loads(path.read_text(encoding="utf-8"))["fetched"]).timestamp()
        except Exception:
            fetched = 0
        if fetched < cutoff:
            stale.append((fetched, cat, nit))
    # Newest tenders first (people open those most), then the oldest copies.
    jobs = [(c, n) for _, c, n in sorted(fresh, reverse=True)] + [(c, n) for _, c, n in sorted(stale)]
    jobs = jobs[:MAX_PER_RUN]
    print(f"{len(wanted)} live tenders: {len(fresh)} new, {len(stale)} to refresh, {removed} closed removed", flush=True)

    session = make_session()
    ok = failed = changed = 0

    def run(job):
        if time.monotonic() - started > TIME_BUDGET:
            return None
        cat, nit = job
        path = STORE / cat / f"{nit}.json"
        old = None
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                old = None
        record = fetch(session, cat, nit, old)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return len(record.get("changes") or []) > len((old or {}).get("changes") or [])

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(run, job) for job in jobs]
        for future in as_completed(futures):
            try:
                result = future.result()
            except Exception:
                failed += 1
                continue
            if result is None:
                continue
            ok += 1
            changed += bool(result)
            if ok % 500 == 0:
                print(f"  {ok} saved ({int(time.monotonic() - started)}s)", flush=True)

    rates = load_rates()
    if rates:
        print(f"Past item rates added or updated for {add_past_rates(rates)} works tenders ({len(rates)} items known)", flush=True)
    print(f"Reserved tenders on record: {write_reserved()}", flush=True)
    stored = sum(1 for _ in STORE.glob("*/*.json"))
    print(f"Saved {ok}, failed {failed}, {changed} with new changes. {stored} of {len(wanted)} live tenders stored "
          f"({int(time.monotonic() - started)}s).")


if __name__ == "__main__":
    main()
