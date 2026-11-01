"""Past market data for Trade Lab: free Yahoo Finance 1-minute candles for the NIFTY 50
stocks and the NIFTY 50 index. Yahoo keeps 1-minute data for ~30 days only, so every
run saves complete days to an archive (bars/YYYY-MM-DD.json.gz); the test period grows
with each run. Stdlib only.
"""
import csv, gzip, io, json, os, time, urllib.error, urllib.request
from datetime import date, datetime
from urllib.parse import quote
from engine import IST, OPEN_MIN, MINUTES

INDEX = "^NSEI"
NIFTY50_CSV = "https://archives.nseindia.com/content/indices/ind_nifty50list.csv"
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1m&period1={}&period2={}"
UA = {"User-Agent": "Mozilla/5.0"}
# Used when NSE's list can't be downloaded (NSE often blocks cloud servers).
FALLBACK = """ADANIENT ADANIPORTS APOLLOHOSP ASIANPAINT AXISBANK BAJAJ-AUTO BAJAJFINSV BAJFINANCE BEL
BHARTIARTL CIPLA COALINDIA DRREDDY EICHERMOT ETERNAL GRASIM HCLTECH HDFCBANK HDFCLIFE HINDALCO
HINDUNILVR ICICIBANK INDIGO INFY ITC JIOFIN JSWSTEEL KOTAKBANK LT M&M MARUTI MAXHEALTH NESTLEIND
NTPC ONGC POWERGRID RELIANCE SBILIFE SBIN SHRIRAMFIN SUNPHARMA TATACONSUM TMPV TATASTEEL TCS
TECHM TITAN TRENT ULTRACEMCO WIPRO""".split()


def get(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < 2:
                time.sleep(3)
                continue
            raise


def nifty50():
    """(symbols, where the list came from)."""
    try:
        rows = list(csv.DictReader(io.StringIO(get(NIFTY50_CSV, 15).decode("utf-8", "replace"))))
        syms = [r["Symbol"].strip() for r in rows if r.get("Symbol")]
        if len(syms) >= 45:
            return syms, "NSE list"
    except Exception as e:
        print(f"NIFTY 50 list from NSE not available ({e}); using the built-in list")
    return FALLBACK, "built-in list"


def fetch_1m(yahoo_sym, days_back=29):
    """{date: {m, o, h, l, c, v}} of 1-minute candles, 09:15-15:29 IST, last ~29 days."""
    out, now = {}, int(time.time())
    start = now - days_back * 86400
    while start < now:                                   # Yahoo gives at most 8 days per 1-minute request
        end = min(start + 7 * 86400, now)
        d = json.loads(get(CHART.format(quote(yahoo_sym), start, end)))
        res = (d.get("chart") or {}).get("result") or []
        if res and res[0].get("timestamp"):
            q = res[0]["indicators"]["quote"][0]
            for i, ts in enumerate(res[0]["timestamp"]):
                o, h, l, c = (q[k][i] for k in ("open", "high", "low", "close"))
                if None in (o, h, l, c):
                    continue
                t = datetime.fromtimestamp(ts, IST)
                m = t.hour * 60 + t.minute - OPEN_MIN
                if not 0 <= m < MINUTES:
                    continue
                day = out.setdefault(t.date(), {})
                day[m] = (o, h, l, c, (q["volume"][i] or 0))
        start = end
        time.sleep(0.3)
    return {dt: pack(rows) for dt, rows in out.items()}


def pack(rows):
    ms = sorted(rows)
    r2 = lambda x: round(x, 2)
    return {"m": ms, "o": [r2(rows[m][0]) for m in ms], "h": [r2(rows[m][1]) for m in ms],
            "l": [r2(rows[m][2]) for m in ms], "c": [r2(rows[m][3]) for m in ms], "v": [int(rows[m][4] or 0) for m in ms]}


def complete(dt):
    now = datetime.now(IST)
    return dt < now.date() or (dt == now.date() and now.hour * 60 + now.minute >= 15 * 60 + 40)


def update_archive(folder, symbols):
    """Download the last ~29 days and save every complete day. Returns (days saved, symbols failed)."""
    os.makedirs(folder, exist_ok=True)
    fresh, fails = {}, []
    for sym in [INDEX] + symbols:
        try:
            for dt, d in fetch_1m(sym if sym == INDEX else sym + ".NS").items():
                if complete(dt) and len(d["m"]) >= 300:          # skip half-empty days
                    fresh.setdefault(dt, {})[sym] = d
        except Exception as e:
            fails.append(sym)
            print(f"{sym}: {e}")
    saved = 0
    for dt, data in fresh.items():
        if INDEX not in data or len(data) < 30:                  # not a usable day
            continue
        path = os.path.join(folder, f"{dt.isoformat()}.json.gz")
        old = load_file(path)
        if old:                                                  # keep symbols this run failed to get
            data = old["symbols"] | ({INDEX: old["index"]} if old.get("index") else {}) | data
        index = data.pop(INDEX)
        with gzip.open(path, "wt") as f:
            json.dump({"date": dt.isoformat(), "index": index, "symbols": data}, f, separators=(",", ":"))
        saved += 1
    return saved, fails


def load_file(path):
    try:
        with gzip.open(path, "rt") as f:
            d = json.load(f)
        d["date"] = date.fromisoformat(d["date"])
        return d
    except (OSError, ValueError, KeyError):
        return None


def load_archive(folder):
    """Every saved day, oldest first."""
    if not os.path.isdir(folder):
        return []
    days = [load_file(os.path.join(folder, n)) for n in sorted(os.listdir(folder)) if n.endswith(".json.gz")]
    return [d for d in days if d]
