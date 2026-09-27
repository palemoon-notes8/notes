"""Collect every awarded KPPP works tender since May 2023 into a history store.

The website keeps only recent results (collect_results.py). This collector walks back through all
of KPPP's awarded works tenders (about 1 lakh) and keeps, in the "history" branch:

  results/{YYYY-MM}.json      each tender: winner and every bidder's total, rank and % vs estimate
  items/{YYYY-MM}.json.gz     each tender's item-wise quoted rates of every bidder
  excel/works-results-{YYYY}.xlsx   one sheet of tenders, one of all bids (for download)
  excel/works-item-rates.xlsx       past winning rates for every BOQ item seen
  rates.json.gz               the same item rates, read by collect_details.py for live tenders
  similar.json                how similar tenders were won, per department / district and type of work
  itemwise.json               the item-wise Excel files (one per month: every bidder's rate for every
                              item), which are kept as downloads in the "itemwise" GitHub release
  contractors/{xx}.json       every bidder's record since 2023 (bids, wins, where, rivals, latest tenders),
                              split into 256 files by a hash of the name (worker/index.js looks them up)
  index.json                  what is there, for the website's download list

The work is split into parts that run at the same time (each looks up every Nth page of KPPP's
list), then merged. Tenders already in the history are skipped, so an unfinished run is simply
continued by the next one; once the whole history is in, each run only adds new awards.
"""

import gzip
import re
import zlib
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from openpyxl import Workbook

from build_lite import district_of, iso_ist, positive
from collect_results import (API, AWARDS, CACHE, HEADERS, SEARCH, clean, fetch_statement, full_view, list_page,
                             make_session, quantiles, with_pct)

TIME_BUDGET = int(os.getenv("HISTORY_TIME_BUDGET", "18000"))
WORKERS = int(os.getenv("HISTORY_WORKERS", "6"))
CATEGORY = "WORKS"


def month_of(record):
    return (record.get("closed") or record.get("published") or "unknown")[:7]


def load_json(path, default):
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                return json.load(fh)
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


class Store:
    """Results and item rates, one file per month, loaded when first needed."""

    def __init__(self, root):
        self.root = root
        self.results = {}   # month -> {nit: record}
        self.items = {}     # month -> {nit: items}
        self.dirty = set()
        for path in (root / "results").glob("*.json"):
            self.results[path.stem] = load_json(path, {})
        self.known = {nit for month in self.results.values() for nit in month}

    def month_items(self, month):
        if month not in self.items:
            self.items[month] = load_json(self.root / "items" / f"{month}.json.gz", {})
        return self.items[month]

    def add(self, record, items):
        month = month_of(record)
        self.results.setdefault(month, {})[record["nit"]] = record
        if items:
            self.month_items(month)[record["nit"]] = items
        self.known.add(record["nit"])
        self.dirty.add(month)

    def save(self):
        (self.root / "results").mkdir(parents=True, exist_ok=True)
        (self.root / "items").mkdir(parents=True, exist_ok=True)
        for month in self.dirty:
            (self.root / "results" / f"{month}.json").write_text(
                json.dumps(self.results.get(month, {}), ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
            if month in self.items:
                with gzip.open(self.root / "items" / f"{month}.json.gz", "wt", encoding="utf-8", compresslevel=6) as fh:
                    json.dump(self.items[month], fh, ensure_ascii=False, separators=(",", ":"))
        self.dirty.clear()

    def all_results(self):
        for month in sorted(self.results):
            yield from self.results[month].values()

    def all_items(self):
        for path in sorted((self.root / "items").glob("*.json.gz")):
            month = path.name[:-len(".json.gz")]
            yield from (self.items[month] if month in self.items else load_json(path, {})).items()


def compact(record):
    """Only what the Excel files and comparisons need."""
    keep = ("nit", "ref", "title", "dept", "office", "district", "work", "value", "published", "closed", "awarded", "winner", "bidders")
    out = {k: record[k] for k in keep if record.get(k) not in (None, "", [])}
    out["bidders"] = [{k: b[k] for k in ("name", "amount", "rank", "pct") if b.get(k) is not None} for b in record.get("bidders") or []]
    return out


def lookup(session, raw):
    nit = str(raw.get("nitId"))
    bidders, items = fetch_statement(session, CATEGORY, nit)
    estimate = positive(raw.get("ecv"))
    with_pct(bidders, estimate)
    office, title = clean(raw.get("locationName")), clean(raw.get("title"))
    winner = bidders[0]["name"] if bidders else None
    if not bidders:
        # No comparative statement: the winner is still in the tender's award details.
        try:
            award = full_view(session, CATEGORY, nit).get("tenderAwardDatesDTO") or {}
            names = [clean(w.get("name")) for w in award.get("listOfBidderDonePBGDTO") or [] if w.get("name")]
            winner = names[0] if names else None
        except Exception:
            pass
    record = {
        "nit": nit, "ref": clean(raw.get("tenderNumber")), "title": title,
        "dept": clean(raw.get("deptName")), "office": office,
        "district": district_of(office, title, raw.get("description")),
        "work": clean(raw.get("workCategoryName")),
        "value": estimate,
        "published": iso_ist(raw.get("publishedDate")), "closed": iso_ist(raw.get("tenderClosureDate")),
        "winner": winner, "bidders": bidders,
    }
    items = [[i["key"], i["code"], i["name"], i["unit"], i["qty"], i["est"], i["rates"]] for i in items]
    return compact(record), items


def seed_from_recent(store):
    """Results the website collector already has (with award pages) need no new lookup."""
    cache = load_json(CACHE, {})
    added = 0
    for nit, record in cache.items():
        if record.get("cat") != CATEGORY or nit in store.known:
            continue
        page = load_json(AWARDS / f"{nit}.json", {})
        items = [[i.get("key"), i.get("code"), i.get("name"), i.get("unit"), i.get("qty"), i.get("est"), i.get("rates")]
                 for i in page.get("items") or []]
        store.add(compact(record), items)
        added += 1
    return added


def build_rates(store):
    groups = {}
    for nit, items in store.all_items():
        for key, code, name, unit, qty, est, rates in items:
            if not rates or not est or est <= 0 or rates[0] is None or rates[0] <= 0:
                continue
            g = groups.setdefault(key, {"names": defaultdict(int), "code": code, "unit": unit, "l1": [], "all": [], "est": [], "n": 0})
            g["names"][name] += 1
            g["l1"].append(rates[0])
            g["all"].extend(r for r in rates if r and r > 0)
            g["est"].append(est)
            g["n"] += 1
    out = {}
    for key, g in groups.items():
        l1, est = quantiles(g["l1"]), quantiles(g["est"])[2]
        out[key] = {"name": max(g["names"], key=g["names"].get), "code": g["code"], "unit": g["unit"], "tenders": g["n"],
                    "est": est, "l1": l1, "all": quantiles(g["all"])[1:4], "ratio": round(l1[2] / est, 4) if est else None}
    return out


def build_similar(results):
    """Winning bid vs estimate per (department, type of work) and (district, type of work)."""
    groups = defaultdict(lambda: {"pcts": [], "bidders": [], "wins": defaultdict(int)})
    for r in results:
        bidders = r.get("bidders") or []
        pct = bidders[0].get("pct") if bidders else None
        for key in (f"d|{r.get('dept') or ''}|{r.get('work') or ''}", f"x|{r.get('district') or ''}|{r.get('work') or ''}"):
            g = groups[key]
            if pct is not None and -80 < pct < 80:
                g["pcts"].append(pct)
            if bidders:
                g["bidders"].append(len(bidders))
            if r.get("winner"):
                g["wins"][r["winner"]] += 1
    out = {}
    for key, g in groups.items():
        if len(g["pcts"]) < 3:
            continue
        q = quantiles(g["pcts"])
        out[key] = {"n": len(g["pcts"]), "q": [q[1], q[2], q[3]],
                    "bidders": round(sum(g["bidders"]) / len(g["bidders"]), 1) if g["bidders"] else None,
                    "top": sorted(g["wins"].items(), key=lambda kv: -kv[1])[:3]}
    return out


def name_key(name):
    """Same as nameKey() in public/app.js and worker/index.js: KPPP writes one bidder in several ways."""
    key = re.sub(r"\(\s*\d+\s*\)", " ", str(name or "").upper())
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9()]+", " ", key)).strip()


def contractor_shard(key):
    return f"{zlib.crc32(key.encode('utf-8')) & 0xff:02x}"


def build_contractors(results, root):
    """Every bidder's record across the whole history, for the contractor page."""
    people = {}
    for r in results:
        bidders = r.get("bidders") or []
        winner_key = name_key(r.get("winner"))
        entries = [(b.get("name"), b) for b in bidders] or ([(r["winner"], {"rank": 1})] if r.get("winner") else [])
        keys = [name_key(n) for n, _ in entries]
        for (name, b), key in zip(entries, keys):
            if not key or not re.search(r"[A-Z]{2}", key):
                continue
            won = b.get("rank") == 1 or key == winner_key
            p = people.setdefault(key, {"names": {}, "bids": 0, "wins": 0, "value": 0.0, "wpct": [], "bpct": [],
                                        "years": {}, "district": {}, "dept": {}, "work": {}, "rivals": {}, "recent": [], "dy": {}})
            p["names"][name] = p["names"].get(name, 0) + 1
            p["bids"] += 1
            year = (r.get("closed") or r.get("published") or "")[:4]
            y = p["years"].setdefault(year, [0, 0])
            y[0] += 1
            pct = b.get("pct")
            if pct is not None and -80 < pct < 80:
                p["bpct"].append(pct)
            if won:
                p["wins"] += 1
                y[1] += 1
                p["value"] += b.get("amount") or r.get("value") or 0
                if pct is not None and -80 < pct < 80:
                    p["wpct"].append(pct)
            if r.get("district") and year:
                dy = p["dy"].setdefault(f"{r['district']}|{year}", [0, 0, 0.0])
                dy[0] += 1
                if won:
                    dy[1] += 1
                    dy[2] += b.get("amount") or r.get("value") or 0
            for field in ("district", "dept", "work"):
                if r.get(field):
                    c = p[field].setdefault(r[field], [0, 0, 0.0])  # bids, wins, value won
                    c[0] += 1
                    if won:
                        c[1] += 1
                        c[2] += b.get("amount") or r.get("value") or 0
            for (other, ob), okey in zip(entries, keys):
                if okey == key or not okey:
                    continue
                rv = p["rivals"].setdefault(okey, [other, 0, 0])
                rv[1] += 1
                if b.get("rank") and ob.get("rank") and b["rank"] < ob["rank"]:
                    rv[2] += 1
            # [nit, closed date, tender number, work, district, department, estimate, their rank,
            #  their amount, their % vs estimate, winner (when not them), number of bidders]
            p["recent"].append((r.get("closed") or "", [
                r.get("nit"), (r.get("closed") or "")[:10], r.get("ref"), (r.get("title") or "")[:90],
                r.get("district"), r.get("dept"), r.get("value"), b.get("rank"), b.get("amount"), pct,
                None if won else r.get("winner"), len(bidders) or None,
            ]))
    top = lambda d, n: [[k, v[0]] for k, v in sorted(d.items(), key=lambda kv: -kv[1][0])[:n]]
    shards = {}
    for key, p in people.items():
        med = lambda v: round(sorted(v)[len(v) // 2], 2) if v else None
        entry = {
            "name": max(p["names"], key=p["names"].get), "bids": p["bids"], "wins": p["wins"], "value": round(p["value"]),
            "winPct": med(p["wpct"]), "bidPct": med(p["bpct"]),
            "years": dict(sorted(p["years"].items())),
            "districts": top(p["district"], 6), "depts": top(p["dept"], 6), "works": top(p["work"], 6),
            "rivals": sorted(p["rivals"].values(), key=lambda v: -v[1])[:8],
            "tenders": [x for _, x in sorted(p["recent"], key=lambda t: t[0], reverse=True)],
            "first": min((d for d, _ in p["recent"] if d), default="")[:10] or None,
            "last": max((d for d, _ in p["recent"] if d), default="")[:10] or None,
        }
        shards.setdefault(contractor_shard(key), {})[key] = entry
    folder = root / "contractors"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.json"):
        old.unlink()
    for shard, entries in shards.items():
        (folder / f"{shard}.json").write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return people


def write_bidders_index(people, root):
    """All bidders for the Bidders tab: [name, bids, wins, value won, latest bid, top districts, usual winning %, per district/year]."""
    all_districts = sorted({k.split("|")[0] for p in people.values() for k in p["dy"]})
    all_years = sorted({k.split("|")[1] for p in people.values() for k in p["dy"]})
    d_index = {d: i for i, d in enumerate(all_districts)}
    y_index = {y: i for i, y in enumerate(all_years)}
    rows = []
    for key, p in people.items():
        dates = [d for d, _ in p["recent"] if d]
        districts = [k for k, _ in sorted(p["district"].items(), key=lambda kv: -kv[1][0])[:3]]
        wp = sorted(p["wpct"])
        # Bids, wins and value won per district and year, flat: [district index, year index, bids, wins, value, ...]
        split = []
        for k, (bids, wins, value) in p["dy"].items():
            d, y = k.split("|")
            split += [d_index[d], y_index[y], bids, wins, round(value)]
        rows.append([max(p["names"], key=p["names"].get), p["bids"], p["wins"], round(p["value"]),
                     max(dates)[:10] if dates else None, districts, round(wp[len(wp) // 2], 1) if wp else None, split])
    rows.sort(key=lambda r: (-r[2], -r[1]))
    (root / "bidders.json").write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                    "districts": all_districts, "years": all_years,
                                                    "bidders": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


BID_BUCKETS = 128


def write_tender_bids(store, root):
    """Every tender's bidders and item-wise rates, for the tender view on contractor pages.

    Split by month and 128 buckets (crc32 of the NIT id) so the worker only reads a small file:
    bids/{YYYY-MM}/{xx}.json -> {nit: {"b": [[name, amount, rank, pct]...], "i": [[code, name, unit, qty, rate, [rates]]...]}}
    """
    folder = root / "bids"
    for month in sorted(store.results):
        if month == "unknown":
            continue
        buckets = {}
        items = store.month_items(month)
        for nit, r in store.results[month].items():
            entry = {"b": [[b.get("name"), b.get("amount"), b.get("rank"), b.get("pct")] for b in r.get("bidders") or []]}
            its = items.get(nit)
            if its:
                entry["i"] = [[code, name, unit, qty, est, rates] for _key, code, name, unit, qty, est, rates in its]
            buckets.setdefault(f"{zlib.crc32(str(nit).encode()) % BID_BUCKETS:02x}", {})[nit] = entry
        out = folder / month
        out.mkdir(parents=True, exist_ok=True)
        for name, data in buckets.items():
            text = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            path = out / f"{name}.json"
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                path.write_text(text, encoding="utf-8")


def split_name(name):
    """'PERSON (1)( FIRM )' -> (firm, person), like splitName() in public/app.js."""
    m = re.match(r"^(.*?)\s*(?:\(\s*\d+\s*\)\s*)?\(\s*(.+?)\s*\)\s*$", name or "")
    if m and m.group(1) and m.group(2) and not m.group(2).isdigit():
        return m.group(2), re.sub(r"\s*\(\s*\d+\s*\)\s*$", "", m.group(1))
    return re.sub(r"\s*\(\s*\d+\s*\)\s*$", "", name or ""), ""


def write_bidder_database(people, root):
    """Every bidder with bids and wins overall, by year, district, department and type of work
    (excel/bidders.xlsx), and the top bidders per district and year for the website (leaders.json)."""
    rows = []
    for key, p in people.items():
        name = max(p["names"], key=p["names"].get)
        firm, person = split_name(name)
        med = lambda v: round(sorted(v)[len(v) // 2], 2) if v else None
        dates = [d for d, _ in p["recent"] if d]
        main = lambda d: max(d.items(), key=lambda kv: kv[1][0])[0] if d else None
        rows.append((key, name, firm, person, p, med(p["wpct"]), med(p["bpct"]),
                     min(dates)[:10] if dates else None, max(dates)[:10] if dates else None,
                     main(p["district"]), main(p["dept"]), main(p["work"])))
    rows.sort(key=lambda r: (-r[4]["wins"], -r[4]["bids"]))
    years = sorted({y for r in rows for y in r[4]["years"] if y})

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Bidders")
    ws.append(["Firm", "Person", "Name as on KPPP", "Tenders bid", "Tenders won", "Win rate %", "Value won (Rs)",
               "Usual winning bid vs estimate %", "Usual bid vs estimate %", "First bid", "Latest bid",
               "Main district", "Main department", "Main type of work"]
              + [f"{label} {y}" for y in years for label in ("Bid", "Won")])
    for key, name, firm, person, p, wpct, bpct, first, last, district, dept, work in rows:
        ws.append([firm, person, name, p["bids"], p["wins"], round(p["wins"] / p["bids"] * 100, 1) if p["bids"] else None,
                   round(p["value"]), wpct, bpct, first, last, district, dept, work]
                  + [v for y in years for v in (p["years"].get(y, [0, 0])[0] or None, p["years"].get(y, [0, 0])[1] or None)])
    for sheet, field, label in (("By district", "district", "District"), ("By department", "dept", "Department"),
                                ("By type of work", "work", "Type of work")):
        ws = wb.create_sheet(sheet)
        ws.append(["Firm", "Person", label, "Tenders bid", "Tenders won", "Win rate %", "Value won (Rs)"])
        for key, name, firm, person, p, *_ in rows:
            for place, (bids, wins, value) in sorted(p[field].items(), key=lambda kv: -kv[1][0]):
                ws.append([firm, person, place, bids, wins or None, round(wins / bids * 100, 1) if bids else None, round(value) or None])
    ws = wb.create_sheet("By year")
    ws.append(["Firm", "Person", "Year", "Tenders bid", "Tenders won", "Win rate %"])
    for key, name, firm, person, p, *_ in rows:
        for y, (bids, wins) in sorted(p["years"].items()):
            if y:
                ws.append([firm, person, y, bids, wins or None, round(wins / bids * 100, 1) if bids else None])
    folder = root / "excel"
    folder.mkdir(parents=True, exist_ok=True)
    wb.save(folder / "works-bidders.xlsx")

    # Top 50 bidders by wins for every district (and all of Karnataka), overall and per year.
    leaders = {}
    for key, name, firm, person, p, *_ in rows:
        places = {"": [p["bids"], p["wins"], p["value"]], **p["district"]}
        for place, (bids, wins, value) in places.items():
            leaders.setdefault(place, {}).setdefault("", []).append([name, bids, wins, round(value)])
        for y, (bids, wins) in p["years"].items():
            if y:
                leaders.setdefault("", {}).setdefault(y, []).append([name, bids, wins, None])
        for place_year, (bids, wins, value) in p["dy"].items():
            place, y = place_year.split("|", 1)
            leaders.setdefault(place, {}).setdefault(y, []).append([name, bids, wins, round(value)])
    for place, by_year in leaders.items():
        for y, lst in by_year.items():
            lst.sort(key=lambda v: (-v[2], -v[1]))
            by_year[y] = [v for v in lst[:50] if v[1]]
    (root / "leaders.json").write_text(json.dumps(leaders, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"file": "works-bidders.xlsx", "year": None, "bidders": len(rows), "bytes": (folder / "works-bidders.xlsx").stat().st_size}


def bid_days(record):
    """Days between publishing and bid closing, or None."""
    try:
        return (datetime.fromisoformat(record["closed"]) - datetime.fromisoformat(record["published"])).total_seconds() / 86400
    except (KeyError, TypeError, ValueError):
        return None


def write_quick(results, root):
    """Tenders published and closed fast (quick.json): how they compare, which offices use them, who wins them.

    "Under 7 days" is below the usual minimum time to bid; "7 days" is the minimum itself.
    """
    bands = [("Under 7 days", 0, 7), ("7 days", 7, 8), ("8-10 days", 8, 11), ("11-15 days", 11, 16),
             ("16-30 days", 16, 31), ("Over 30 days", 31, 10 ** 6)]
    groups = {label: [] for label, _, _ in bands}
    months = {m: [0, 0, 0] for m in range(1, 13)}
    offices, quick = {}, []
    for r in results:
        days = bid_days(r)
        if days is None or days < 0:
            continue
        bidders = r.get("bidders") or []
        for label, lo, hi in bands:
            if lo <= days < hi:
                groups[label].append(r)
        month = int(r["published"][5:7])
        months[month][0] += 1
        months[month][1] += days < 7
        months[month][2] += days < 8
        o = offices.setdefault(r.get("office") or "", {"n": 0, "nb": 0, "q7": 0, "q8": 0, "qb": 0, "w": {},
                                                        "district": r.get("district"), "dept": r.get("dept")})
        o["n"] += 1
        o["nb"] += len(bidders)
        if days < 8:
            o["q8"] += 1
            o["q7"] += days < 7
            o["qb"] += len(bidders)
            if r.get("winner"):
                o["w"][r["winner"]] = o["w"].get(r["winner"], 0) + 1
        if days < 7:
            l1 = bidders[0].get("pct") if bidders else None
            quick.append([r.get("nit"), (r.get("closed") or "")[:10], round(days, 1), r.get("office"), r.get("district"),
                          r.get("dept"), (r.get("title") or "")[:90], r.get("value"), r.get("winner"), len(bidders), l1])

    def summary(rows):
        nb = [len(r.get("bidders") or []) for r in rows]
        pct = sorted(r["bidders"][0]["pct"] for r in rows if r.get("bidders") and r["bidders"][0].get("pct") is not None)
        return {"tenders": len(rows), "bidders": round(sum(nb) / len(nb), 2) if nb else None,
                "single": round(sum(n == 1 for n in nb) * 100 / len(nb)) if nb else None,
                "l1": round(pct[len(pct) // 2], 1) if pct else None}

    office_rows = []
    for name, o in offices.items():
        if o["q8"] < 2 or not name:
            continue
        top = sorted(o["w"].items(), key=lambda kv: -kv[1])[:3]
        office_rows.append([name, o["district"], o["dept"], o["n"], o["q8"], o["q7"], round(o["nb"] / o["n"], 1),
                            round(o["qb"] / o["q8"], 1), top])
    office_rows.sort(key=lambda r: (-r[5], -r[4]))
    quick.sort(key=lambda r: r[1], reverse=True)
    (root / "quick.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bands": [dict(label=label, **summary(groups[label])) for label, _, _ in bands],
        "months": [[m, *months[m]] for m in range(1, 13)],
        "offices": office_rows,
        "quick": quick,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_competitors(results, root, top=8, since_months=36):
    """Likely competitors for a live tender (competitors.json): who bid most often on works from the same
    office, or failing that the same department + district + type of work, how often they won and their
    usual quote against the estimate. Only contractors who bid within the last `since_months` count.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=since_months * 30)).strftime("%Y-%m-%d")
    groups = {"office": {}, "group": {}}
    for r in results:
        closed = (r.get("closed") or "")[:10]
        if not closed or closed < cutoff or not r.get("bidders"):
            continue
        keys = [("office", r.get("office"))]
        if r.get("dept") and r.get("district"):
            keys.append(("group", f"{r['dept']}|{r['district']}|{r.get('work') or ''}"))
        for kind, key in keys:
            if not key:
                continue
            g = groups[kind].setdefault(key, {"n": 0, "bids": 0, "people": {}})
            g["n"] += 1
            g["bids"] += len(r["bidders"])
            for b in r["bidders"]:
                name = b.get("name")
                if not name or not re.search(r"[A-Za-z]{2}", name):
                    continue
                p = g["people"].setdefault(name_key(name), {"names": {}, "bids": 0, "wins": 0, "pct": [], "last": ""})
                p["names"][name] = p["names"].get(name, 0) + 1
                p["bids"] += 1
                p["wins"] += b.get("rank") == 1
                if b.get("pct") is not None and -80 < b["pct"] < 80:
                    p["pct"].append(b["pct"])
                p["last"] = max(p["last"], closed)
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    for kind, entries in groups.items():
        rows = {}
        for key, g in entries.items():
            if g["n"] < 3:
                continue
            people = sorted(g["people"].values(), key=lambda p: (-p["bids"], -p["wins"]))[:top]
            rows[key] = [g["n"], round(g["bids"] / g["n"], 1), [
                [max(p["names"], key=p["names"].get), p["bids"], p["wins"],
                 round(sorted(p["pct"])[len(p["pct"]) // 2], 1) if p["pct"] else None, p["last"]]
                for p in people]]
        out[kind] = rows
    (root / "competitors.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_itemwise(store, root, out):
    """One Excel file per month: every BOQ item of every tender with each bidder's quoted rate.

    Only months whose data changed are written to `out` (they are uploaded to the "itemwise"
    GitHub release by the workflow); root/itemwise.json remembers what each file holds.
    """
    import hashlib
    out.mkdir(parents=True, exist_ok=True)
    meta = load_json(root / "itemwise.json", {})
    for month in sorted(store.results):
        if month == "unknown":
            continue
        src = [root / "results" / f"{month}.json", root / "items" / f"{month}.json.gz"]
        digest = hashlib.sha1(b"v1" + b"".join(p.read_bytes() for p in src if p.exists())).hexdigest()
        if meta.get(month, {}).get("hash") == digest:
            continue
        results, items = store.results[month], store.month_items(month)
        wb = Workbook(write_only=True)
        ws = wb.create_sheet("Item bids")
        head = ["Tender number", "Work", "District", "Department", "Type of work", "Bids closed", "Item code", "Item",
                "Unit", "Qty", "Dept. rate", "Bidders"]
        for k in range(1, 6):
            head += [f"L{k} bidder" + (" (winner)" if k == 1 else ""), f"L{k} rate", f"L{k} vs dept %"]
        ws.append(head)
        rows = 0
        for nit, its in items.items():
            r = results.get(nit) or {}
            names = [b.get("name") for b in r.get("bidders") or []]
            for _key, code, name, unit, qty, est, rates in its:
                rates = rates or []
                row = [r.get("ref"), (r.get("title") or "")[:120], r.get("district"), r.get("dept"), r.get("work"),
                       date_only(r.get("closed")), code, name, unit, qty, est, len(rates) or None]
                for k in range(5):
                    rate = rates[k] if k < len(rates) else None
                    row += [names[k] if k < len(names) else None, rate,
                            round((rate / est - 1) * 100, 2) if rate and est else None]
                ws.append(row)
                rows += 1
        name = f"itemwise-{month}.xlsx"
        wb.save(out / name)
        meta[month] = {"file": name, "hash": digest, "tenders": len(items), "rows": rows, "bytes": (out / name).stat().st_size}
        print(f"  item-wise {month}: {len(items)} tenders, {rows} rows", flush=True)
    (root / "itemwise.json").write_text(json.dumps(meta, indent=1, sort_keys=True), encoding="utf-8")
    return [{"month": m, **{k: v for k, v in info.items() if k != "hash"}} for m, info in sorted(meta.items())]


def date_only(value):
    return (value or "")[:10] or None


def write_excel(results, rates, root):
    folder = root / "excel"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.xlsx"):
        old.unlink()
    by_year = defaultdict(list)
    for r in results:
        by_year[(r.get("closed") or r.get("published") or "unknown")[:4]].append(r)
    files = []
    for year, rows in sorted(by_year.items()):
        rows.sort(key=lambda r: r.get("closed") or "", reverse=True)
        wb = Workbook(write_only=True)
        ws = wb.create_sheet("Tenders")
        ws.append(["Tender number", "NIT id", "Work", "Department", "Office", "District", "Type of work", "Estimate (Rs)",
                   "Published", "Bids closed", "Winner", "Winning bid (Rs)", "Winner vs estimate %", "Bidders",
                   "L2 bidder", "L2 bid (Rs)", "L1 below L2 %"])
        bids = wb.create_sheet("All bids")
        bids.append(["Tender number", "NIT id", "Work", "Department", "District", "Type of work", "Estimate (Rs)",
                     "Bids closed", "Rank", "Bidder", "Quoted amount (Rs)", "vs estimate %"])
        n_bids = 0
        for r in rows:
            b = r.get("bidders") or []
            l1 = b[0] if b else {}
            l2 = b[1] if len(b) > 1 else {}
            gap = round((l2["amount"] - l1["amount"]) / l2["amount"] * 100, 2) if l1.get("amount") and l2.get("amount") else None
            ws.append([r.get("ref"), r.get("nit"), r.get("title"), r.get("dept"), r.get("office"), r.get("district"), r.get("work"),
                       r.get("value"), date_only(r.get("published")), date_only(r.get("closed")), r.get("winner"),
                       l1.get("amount"), l1.get("pct"), len(b) or None, l2.get("name"), l2.get("amount"), gap])
            for bidder in b:
                bids.append([r.get("ref"), r.get("nit"), r.get("title"), r.get("dept"), r.get("district"), r.get("work"), r.get("value"),
                             date_only(r.get("closed")), f"L{bidder['rank']}" if bidder.get("rank") else None,
                             bidder.get("name"), bidder.get("amount"), bidder.get("pct")])
                n_bids += 1
        name = f"works-results-{year}.xlsx"
        wb.save(folder / name)
        files.append({"file": name, "year": year, "tenders": len(rows), "bids": n_bids, "bytes": (folder / name).stat().st_size})

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Item rates")
    ws.append(["Item code", "Item", "Unit", "Tenders", "Department rate (median, Rs)", "Winning rate lowest", "Winning rate 25%",
               "Winning rate median", "Winning rate 75%", "Winning rate highest", "Winning median vs department %",
               "All bidders 25%", "All bidders median", "All bidders 75%"])
    # Items seen in only one tender make the file huge (hundreds of thousands of rows) and say
    # little about a "usual" rate, so the workbook keeps items seen in two or more tenders.
    shared = {k: g for k, g in rates.items() if g["tenders"] >= 2}
    for key, g in sorted(shared.items(), key=lambda kv: -kv[1]["tenders"]):
        l1 = g["l1"]
        ws.append([g["code"], g["name"], g["unit"], g["tenders"], g["est"], *l1,
                   round((g["ratio"] - 1) * 100, 2) if g.get("ratio") else None, *g["all"]])
    name = "works-item-rates.xlsx"
    wb.save(folder / name)
    files.append({"file": name, "year": None, "items": len(shared), "bytes": (folder / name).stat().st_size})
    return files


def total_pages(session):
    # KPPP sometimes does not answer for a few minutes; keep trying instead of losing the whole part.
    for attempt in range(8):
        try:
            response = session.post(f"{API}/{SEARCH[CATEGORY]}?page=0&size=1&order-by-tender-publish=true",
                                    json={"category": CATEGORY, "status": "AWARDED", "title": ""}, headers=HEADERS, timeout=60)
            response.raise_for_status()
            return (int(response.headers.get("X-Total-Count") or 0) + 99) // 100
        except Exception as exc:
            print(f"KPPP did not answer ({exc.__class__.__name__}), trying again in a minute", flush=True)
            time.sleep(60)
    raise SystemExit("KPPP is not answering; this part will be collected by the next run.")


def collect(history, out, shard, shards):
    """Look up one part of KPPP's awarded list (pages shard, shard + shards, ...) into a new store."""
    started = time.monotonic()
    out_of_time = lambda: time.monotonic() - started > TIME_BUDGET
    known = Store(history).known
    # "filled_all": every part of an earlier run went through all its pages, so the history is
    # complete and this run only needs the new awards at the front of the list.
    was_filled = load_json(history / "state.json", {}).get("filled_all", False)
    # Small daily runs: only the newest awards (stop once caught up). A full pass over every page
    # happens on Sundays (fills any gaps), or when HISTORY_QUICK=0.
    quick = os.getenv("HISTORY_QUICK", "auto")
    sunday = datetime.now(timezone.utc).weekday() == 6
    if quick == "auto":
        quick = "0" if sunday or os.getenv("HISTORY_FOCUS", "").strip() else "1"
    filled = quick == "1"
    store = Store(out)
    session = make_session()
    pages = total_pages(session)
    print(f"KPPP lists {pages} pages of awarded works ({int(time.monotonic() - started)}s)", flush=True)
    # Interleaved pages spread old and new tenders evenly over the parts.
    mine = list(range(shard, pages + 1, shards))
    # Catch-up mode: every job works on one part's pages (a part that failed before), shared out.
    focus = os.getenv("HISTORY_FOCUS", "").strip()
    if focus.isdigit():
        mine = list(range(int(focus), pages + 1, shards))[shard::shards]
        print(f"Catch-up: sharing part {int(focus) + 1}'s pages over {shards} jobs", flush=True)
    print(f"Part {shard + 1}/{shards}: {len(mine)} of {pages} pages; {len(known)} already in history", flush=True)
    ok = failed = 0
    known_in_a_row, caught_up = 0, False
    stats = {"pages_done": 0, "pages": len(mine)}

    def run(raw):
        return None if out_of_time() else lookup(session, raw)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for n, page in enumerate(mine, 1):
            if out_of_time():
                break
            try:
                batch = list_page(session, CATEGORY, page)
            except Exception as exc:
                print(f"Could not list page {page}: {exc}", flush=True)
                continue
            todo = [raw for raw in batch if str(raw.get("nitId")) not in known and str(raw.get("nitId")) not in store.known]
            # New awards push rows to later pages, so one fully known page can be a fluke; three in a
            # row means this part has caught up with what the history already has.
            known_in_a_row = 0 if todo else known_in_a_row + 1
            if filled and known_in_a_row >= 3:
                caught_up = True
                break
            for future in as_completed([pool.submit(run, raw) for raw in todo]):
                try:
                    done = future.result()
                except Exception:
                    failed += 1
                    continue
                if done is not None:
                    store.add(*done)
                    ok += 1
            stats["pages_done"] = n
            if n % 25 == 0 or n <= 3:
                print(f"  {n}/{len(mine)} pages, {ok} new, {failed} failed ({int(time.monotonic() - started)}s)", flush=True)
    store.save()
    # A catch-up run covers only one part's pages, so it never marks the whole history complete.
    # Only a pass over every page (or catching up on a history that was already complete) counts as complete.
    stats.update(new=ok, failed=failed, finished=not focus.isdigit() and (stats["pages_done"] == len(mine) or (caught_up and was_filled)))
    (out / "part.json").write_text(json.dumps(stats), encoding="utf-8")
    print(f"Part {shard + 1} done: {ok} new, {failed} failed, {stats['pages_done']}/{len(mine)} pages ({int(time.monotonic() - started)}s)")


def build(history, parts, itemwise_out=None):
    """Merge the parts into the history, then write the Excel files and comparison figures."""
    started = time.monotonic()
    store = Store(history)
    state = load_json(history / "state.json", {})
    print(f"History has {len(store.known)} works results; seeded {seed_from_recent(store)} from the website's recent results", flush=True)
    # Complete only when every part ran and went through all of its pages.
    expected = int(os.getenv("HISTORY_PARTS", "4"))
    finished = len(parts) == expected
    for part in parts:
        info = load_json(part / "part.json", {})
        finished = finished and bool(info.get("finished"))
        other = Store(part)
        for month, records in other.results.items():
            items = other.month_items(month)
            for nit, record in records.items():
                store.add(record, items.get(nit))
        print(f"  merged {part.name}: {info}", flush=True)
    state.pop("filled", None)  # older runs set this too early
    state["filled_all"] = finished
    store.save()
    (history / "state.json").write_text(json.dumps(state), encoding="utf-8")

    results = list(store.all_results())
    rates = build_rates(store)
    with gzip.open(history / "rates.json.gz", "wt", encoding="utf-8") as fh:
        json.dump(rates, fh, ensure_ascii=False, separators=(",", ":"))
    similar = build_similar(results)
    (history / "similar.json").write_text(json.dumps(similar, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    files = write_excel(results, rates, history)
    people = build_contractors(results, history)
    contractors = len(people)
    files.append(write_bidder_database(people, history))
    write_bidders_index(people, history)
    write_tender_bids(store, history)
    write_quick(results, history)
    write_competitors(results, history)
    itemwise = write_itemwise(store, history, itemwise_out) if itemwise_out else []
    closed = sorted(r["closed"] for r in results if r.get("closed"))
    (history / "index.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tenders": len(results),
        "with_bids": sum(1 for r in results if r.get("bidders")),
        "from": closed[0][:10] if closed else None,
        "to": closed[-1][:10] if closed else None,
        "complete": bool(state.get("filled_all")),
        "contractors": contractors,
        "itemwise": itemwise,
        "files": files,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Done: {len(results)} works results in history, {len(rates)} BOQ items, "
          f"{len(similar)} comparison groups ({int(time.monotonic() - started)}s).")


if __name__ == "__main__":
    # collect_history.py collect HISTORY OUT SHARD SHARDS  |  collect_history.py build HISTORY PART...
    # (build writes changed item-wise Excel files to $ITEMWISE_OUT when it is set)
    if sys.argv[1] == "collect":
        collect(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
    else:
        out = os.getenv("ITEMWISE_OUT")
        build(Path(sys.argv[2]), [Path(p) for p in sys.argv[3:]], Path(out) if out else None)
