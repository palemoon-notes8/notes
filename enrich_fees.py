"""Fill EMD and tender fee from KPPP's public per-tender "general info" endpoint.

The KPPP search list (fetch_kppp.py) never includes EMD or tender fee, but the
portal's tender page loads them from
    /portal-service/{nitId}/get-{works|goods|services}-tender-general-info
without a login. Results are cached in data/kppp-fees.json so each hourly run
only looks up new tenders (plus a slice of stale ones), not all ~5,000.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from kppp_polite import make_session as polite_session

TENDERS = Path("public/tenders.json")
CACHE = Path("data/kppp-fees.json")
API = "https://kppp.karnataka.gov.in/supplier-registration-service/v1/api/portal-service"
SECTION = {"WORKS": "works", "GOODS": "goods", "SERVICES": "services"}

# Small batches each hour (new tenders first) so KPPP never sees a burst.
MAX_LOOKUPS = int(os.getenv("KPPP_FEE_MAX_LOOKUPS", "100"))
WORKERS = int(os.getenv("KPPP_FEE_WORKERS", "6"))
# EMD/fee can change through a corrigendum, so re-check entries after a few days.
REFRESH_AFTER = timedelta(days=int(os.getenv("KPPP_FEE_REFRESH_DAYS", "3")))

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://kppp.karnataka.gov.in",
    "Referer": "https://kppp.karnataka.gov.in/",
    "Post": "CONTRACTOR-EPROC-CONTRACTOR",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def positive(value):
    try:
        number = float(str(value).replace(",", "").strip())
        return round(number, 2) if number > 0 else None
    except Exception:
        return None


def make_session():
    return polite_session(pool=WORKERS)


def lookup(session, category, nit_id):
    url = f"{API}/{nit_id}/get-{SECTION[category]}-tender-general-info"
    response = session.get(url, headers=HEADERS, timeout=20)
    if response.status_code != 200:
        return None
    info = (response.json() or {}).get("invitingTenderDTO") or {}
    return {"emd": positive(info.get("emd")), "fee": positive(info.get("tenderFee"))}


def main():
    data = json.loads(TENDERS.read_text(encoding="utf-8"))
    tenders = data.get("tenders") or []
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    now = datetime.now(timezone.utc)

    def stale(entry):
        try:
            return now - datetime.fromisoformat(entry["checked"]) > REFRESH_AFTER
        except Exception:
            return True

    todo, seen = [], set()
    for tender in tenders:
        raw = tender.get("raw") if isinstance(tender.get("raw"), dict) else {}
        nit_id = str(raw.get("nitId") or "").strip()
        category = str(tender.get("category") or "").upper()
        if not nit_id or category not in SECTION or nit_id in seen:
            continue
        seen.add(nit_id)
        entry = cache.get(nit_id)
        if entry is None or stale(entry):
            # New tenders first, then the oldest checks.
            todo.append((entry is not None, (entry or {}).get("checked", ""), category, nit_id))
    todo.sort()
    todo = todo[:MAX_LOOKUPS]

    session = make_session()
    ok = failed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(lookup, session, cat, nit): nit for _, _, cat, nit in todo}
        for future in as_completed(futures):
            nit_id = futures[future]
            try:
                result = future.result()
            except Exception:
                result = None
            if result is None:
                failed += 1
                continue
            cache[nit_id] = {**result, "checked": now.isoformat(timespec="seconds")}
            ok += 1

    # Drop cache entries for tenders that are no longer listed.
    cache = {nit: entry for nit, entry in cache.items() if nit in seen}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")

    filled = {"emd": 0, "fee": 0}
    for tender in tenders:
        raw = tender.get("raw") if isinstance(tender.get("raw"), dict) else {}
        entry = cache.get(str(raw.get("nitId") or "").strip()) or {}
        for field in ("emd", "fee"):
            if entry.get(field):
                tender[field] = entry[field]
            if positive(tender.get(field)):
                filled[field] += 1
    TENDERS.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Looked up {len(todo)} tenders: {ok} ok, {failed} failed. "
          f"EMD known for {filled['emd']}/{len(tenders)}, fee for {filled['fee']}/{len(tenders)}.")


if __name__ == "__main__":
    main()
