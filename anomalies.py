"""Long-history test of documented calendar/behavioural effects on Indian markets (free daily data).
Each rule says which days (or nights) to be long; returns are compared with buy-and-hold.
Train = up to 2018, test = 2019 onward. Cost per round trip (futures, incl. slippage) is subtracted.
Usage: python anomalies.py <outdir>  -> anomalies.json
"""
import json, math, os, sys, time
from datetime import datetime, timedelta
import research

IST = research.IST
ASSETS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "SENSEX": "^BSESN", "GOLD (GOLDBEES)": "GOLDBEES.NS"}
COST = 0.0003           # 3 bps per round trip
SPLIT = "2019-01-01"


def load(sym):
    rows = research.yahoo(sym, "1d", "max")
    out = []
    for t, o, h, l, c in rows:
        d = datetime.fromtimestamp(t, IST).date()
        if c > 0 and o > 0 and (not out or d > out[-1][0]):
            out.append((d, o, c))
    return out


def valid_open_years(rows):
    """Yahoo's old Indian index opens are often just the previous close; keep only years with real opens."""
    by = {}
    for (d0, _, c0), (d1, o1, _) in zip(rows, rows[1:]):
        by.setdefault(d1.year, []).append(abs(o1 / c0 - 1) < 1e-6)
    return {y for y, v in by.items() if sum(v) / len(v) < 0.05}


def rules(rows):
    """Yield (name, list of (date, return)) — one entry per position taken (already net of cost)."""
    n = len(rows)
    closes = [r[2] for r in rows]
    dates = [r[0] for r in rows]
    good = valid_open_years(rows)
    cc = [(dates[i], closes[i] / closes[i - 1] - 1) for i in range(1, n)]
    out = {"Buy & hold (benchmark)": [(d, r) for d, r in cc]}

    on, intra = [], []
    for i in range(1, n):
        if dates[i].year in good:
            on.append((dates[i], rows[i][1] / closes[i - 1] - 1 - COST))
            intra.append((dates[i], closes[i] / rows[i][1] - 1 - COST))
    out["Overnight only (buy close, sell next open)"] = on
    out["Intraday only (buy open, sell close)"] = intra

    # turn of month: buy close of 4th-last trading day, sell close of 3rd trading day of next month
    tom, i = [], 1
    month_idx = {}
    for k, d in enumerate(dates):
        month_idx.setdefault((d.year, d.month), []).append(k)
    keys = sorted(month_idx)
    for a, b in zip(keys, keys[1:]):
        ka, kb = month_idx[a], month_idx[b]
        if len(ka) >= 5 and len(kb) >= 3:
            s, e = ka[-4], kb[2]
            tom.append((dates[e], closes[e] / closes[s] - 1 - COST))
    out["Turn of month (last 3 + first 3 days)"] = tom

    # pre-holiday: hold the day before a weekday market holiday
    pre = []
    for i in range(1, n - 1):
        gap_days = (dates[i + 1] - dates[i]).days
        weekend_only = dates[i].weekday() == 4 and gap_days == 3
        if gap_days > 1 and not weekend_only:
            pre.append((dates[i], closes[i] / closes[i - 1] - 1 - COST))
    out["Day before a holiday"] = pre

    for wd, name in enumerate(("Mon", "Tue", "Wed", "Thu", "Fri")):
        out[f"Only {name}"] = [(dates[i], closes[i] / closes[i - 1] - 1 - COST) for i in range(1, n) if dates[i].weekday() == wd]

    # trend filter: long next day when close > 200-day average; cost on each switch
    tf, inpos = [], False
    for i in range(200, n - 1):
        want = closes[i] > sum(closes[i - 199:i + 1]) / 200
        r = closes[i + 1] / closes[i] - 1 if want else 0.0
        if want != inpos:
            r -= COST / 2
            inpos = want
        tf.append((dates[i + 1], r))
    out["Trend filter (above 200-day avg, else cash)"] = tf

    # bounce: after 3 down closes in a row, buy close, hold 3 days
    mr, i = [], 3
    while i < n - 3:
        if closes[i] < closes[i - 1] < closes[i - 2] < closes[i - 3]:
            mr.append((dates[i + 3], closes[i + 3] / closes[i] - 1 - COST))
            i += 3
        i += 1
    out["Bounce after 3 down days (hold 3 days)"] = mr
    return out


def stat(rets, years):
    if len(rets) < 20:
        return None
    r = [x for _, x in rets]
    m = sum(r) / len(r)
    sd = math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) or 1e-12
    eq = peak = 1.0
    dd = 0.0
    for x in r:
        eq *= 1 + x
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
    return {"n": len(r), "avg_pct": round(m * 100, 3), "win": round(sum(x > 0 for x in r) / len(r) * 100),
            "t": round(m / (sd / math.sqrt(len(r))), 2), "cagr_pct": round((eq ** (1 / years) - 1) * 100, 1) if years > 0 else None,
            "max_dd_pct": round(dd * 100, 1)}


if __name__ == "__main__":
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    res = {"made": datetime.now(IST).strftime("%d %b %Y %H:%M"), "split": SPLIT, "cost_bps": COST * 1e4, "assets": {}}
    for name, sym in ASSETS.items():
        try:
            rows = load(sym)
        except Exception as e:
            print(name, "failed", e)
            continue
        if len(rows) < 1500:
            print(name, "too little data"); continue
        first, last = rows[0][0], rows[-1][0]
        split = datetime.strptime(SPLIT, "%Y-%m-%d").date()
        ytr = (split - first).days / 365.25
        yte = (last - split).days / 365.25
        table = {}
        for rule, rets in rules(rows).items():
            tr = [x for x in rets if x[0] < split]
            te = [x for x in rets if x[0] >= split]
            table[rule] = {"train": stat(tr, ytr), "test": stat(te, yte)}
        res["assets"][name] = {"from": first.isoformat(), "to": last.isoformat(), "rules": table}
        print(name, first, last)
        for k, v in table.items():
            print(f"  {k:46} train {v['train']}  test {v['test']}")
        time.sleep(1)
    with open(os.path.join(outdir, "anomalies.json"), "w") as f:
        json.dump(res, f, separators=(",", ":"))
