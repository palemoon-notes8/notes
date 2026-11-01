"""15-20 minute index option scalps: pattern search on free 5-min data (~60 days).
At each 5-min close, features use only data up to that bar. A trade buys an ATM call (long) or
put (short), holds 3 or 4 bars (15/20 min), one trade at a time per index.
Net result per trade = 0.5 x index move - cost, in basis points (bps) of the index.
Cost ~1.5 bps covers spread + slippage + 20 min of decay for liquid weekly ATM options.
Train = first 2/3 of days, test = last 1/3.  Usage: python scalp.py <outdir> -> scalp.json
"""
import itertools, json, math, os, random, sys, time
from datetime import datetime
import research

IST = research.IST
COST_BPS = 1.5
HORIZONS = (3, 4)
MIN_TRAIN, MIN_TEST = 60, 25


def day_bars(rows):
    days = {}
    for t, o, h, l, c in rows:
        dt = datetime.fromtimestamp(t, IST)
        days.setdefault(dt.date(), []).append(((dt.hour, dt.minute), o, h, l, c))
    return [(d, sorted(b)) for d, b in sorted(days.items()) if len(b) >= 60]


def tod(hm):
    return ("open" if hm < (9, 45) else "morning" if hm < (11, 0) else "midday" if hm < (13, 0)
            else "afternoon" if hm < (14, 30) else "close")


def features(days):
    """List of (date, i, bars, feature-dict) for bars where a 20-min hold still ends before 15:20."""
    out = []
    prev_close = None
    rng_hist = []                                     # recent 5-min ranges for scale
    for d, bars in days:
        o0 = bars[0][1]
        orh = max(b[2] for b in bars[:3]); orl = min(b[3] for b in bars[:3])
        cum = n = 0.0
        hi, lo = bars[0][2], bars[0][3]
        for i, (hm, o, h, l, c) in enumerate(bars):
            cum += (h + l + c) / 3; n += 1
            vwap = cum / n                             # index has no volume: typical-price average
            hi, lo = max(hi, h), min(lo, l)
            rng_hist = (rng_hist + [h - l])[-75:]
            scale = sum(rng_hist) / len(rng_hist)
            if i < 3 or hm > (15, 0) or i + max(HORIZONS) >= len(bars) or prev_close is None:
                continue
            r1 = c - bars[i - 1][4]
            r3 = c - bars[i - 3][4]
            f = {"time": tod(hm),
                 "last_bar": "big_up" if r1 > scale else "big_down" if r1 < -scale else "small",
                 "last_15m": "up" if r3 > 0 else "down",
                 "vs_vwap": "above" if c > vwap else "below",
                 "vs_open": "above" if c > o0 else "below",
                 "gap": "up" if o0 > prev_close * 1.003 else "down" if o0 < prev_close * 0.997 else "flat",
                 "orb": "broke_high" if (c > orh and bars[i - 1][4] <= orh) else
                        "broke_low" if (c < orl and bars[i - 1][4] >= orl) else "none",
                 "new_day_extreme": "high" if h >= hi and i > 3 else "low" if l <= lo and i > 3 else "no",
                 "wide_bar": (h - l) > 1.8 * scale,
                 "weekday": d.strftime("%a")}
            fwd = {k: bars[i + k][4] - c for k in HORIZONS}
            out.append((d, i, c, f, fwd))
        prev_close = bars[-1][4]
    return out


def evaluate(recs, combo, side, hz, bps, match):
    """Net bps per trade, one trade at a time per index (no overlapping holds)."""
    res, busy = [], {}
    for idx, (d, i, c, f, fwd) in recs:
        key = (idx, d)
        if busy.get(key, -1) >= i or not match(f, combo):
            continue
        move = fwd[hz] * (1 if side == "long" else -1)
        res.append((0.5 * move / c - bps / 1e4) * 1e4)
        busy[key] = i + hz
    return res


def stats(r):
    if not r:
        return None
    m = sum(r) / len(r)
    sd = math.sqrt(sum((x - m) ** 2 for x in r) / max(1, len(r) - 1)) or 1e-9
    return {"n": len(r), "avg_bps": round(m, 2), "win": round(sum(x > 0 for x in r) / len(r) * 100),
            "t": round(m / (sd / math.sqrt(len(r))), 2)}


if __name__ == "__main__":
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    allrecs, loaded = [], []
    for name, sym in research.INDICES.items():
        try:
            days = day_bars(research.yahoo(sym, "5m", "60d"))
            recs = features(days)
            if len(recs) > 1000:
                allrecs += [(name, r) for r in recs]; loaded.append(name)
            print(name, len(days), "days", len(recs), "bars")
        except Exception as e:
            print(name, "failed:", e)
        time.sleep(1)
    if not loaded:
        raise SystemExit("no data")
    allrecs.sort(key=lambda x: (x[1][0], x[0], x[1][1]))
    dates = sorted({r[0] for _, r in allrecs})
    cut = dates[len(dates) * 2 // 3]
    train = [x for x in allrecs if x[1][0] < cut]
    test = [x for x in allrecs if x[1][0] >= cut]

    values = {}
    for _, r in allrecs:
        for k, v in r[3].items():
            values.setdefault(k, set()).add(v)
    single = [(k, v) for k in sorted(values) for v in sorted(values[k], key=str)]
    combos = [(c,) for c in single] + [p for p in itertools.combinations(single, 2) if p[0][0] != p[1][0]]
    match = lambda f, combo: all(f[k] == v for k, v in combo)

    found, tested = [], 0
    for combo in combos:
        for side in ("long", "short"):
            for hz in HORIZONS:
                tested += 1
                tr = evaluate(train, combo, side, hz, COST_BPS, match)
                if len(tr) < MIN_TRAIN:
                    continue
                st = stats(tr)
                if st["avg_bps"] <= 0 or st["t"] < 2:
                    continue
                te = stats(evaluate(test, combo, side, hz, COST_BPS, match))
                found.append({"rule": " + ".join(f"{k}={v}" for k, v in combo), "side": side,
                              "hold_min": hz * 5, "train": st, "test": te})
    held = [x for x in found if x["test"] and x["test"]["n"] >= MIN_TEST and x["test"]["avg_bps"] > 0]
    held.sort(key=lambda x: -x["test"]["t"])

    # how many would "hold" by luck: same search with test outcomes' signs randomly flipped
    random.seed(1)
    luck = 0
    for x in found:
        combo = [c for c in combos if " + ".join(f"{k}={v}" for k, v in c) == x["rule"]][0]
        side = x["side"] if random.random() < 0.5 else ("short" if x["side"] == "long" else "long")
        te = stats(evaluate(test, combo, side, x["hold_min"] // 5, COST_BPS, match))
        luck += bool(te and te["n"] >= MIN_TEST and te["avg_bps"] > 0)

    def detail(x):
        combo = [c for c in combos if " + ".join(f"{k}={v}" for k, v in c) == x["rule"]][0]
        hz = x["hold_min"] // 5
        sens = {b: stats(evaluate(allrecs, combo, x["side"], hz, b, match)) for b in (0, 1, 1.5, 2, 3)}
        per = {n: stats(evaluate([r for r in allrecs if r[0] == n], combo, x["side"], hz, COST_BPS, match)) for n in loaded}
        return x | {"cost_sensitivity": sens, "per_index": per}

    base = {f"{s} {h*5}min every bar": {b: stats(evaluate(allrecs, (), s, h, b, match)) for b in (0, 1.5)}
            for s in ("long", "short") for h in HORIZONS}
    res = {"made": datetime.now(IST).strftime("%d %b %Y %H:%M"), "indices": loaded, "period": [dates[0].isoformat(), dates[-1].isoformat()],
           "train_until": cut.isoformat(), "cost_bps": COST_BPS, "hypotheses_tested": tested, "strong_on_train": len(found),
           "held_on_test": len(held), "expected_by_luck": luck, "baseline": base,
           "best": [detail(x) for x in held[:10]]}
    with open(os.path.join(outdir, "scalp.json"), "w") as f:
        json.dump(res, f, separators=(",", ":"))
    print(json.dumps({k: res[k] for k in ("indices", "period", "train_until", "hypotheses_tested",
                                          "strong_on_train", "held_on_test", "expected_by_luck")}))
    for x in res["best"]:
        print(x["rule"], x["side"], x["hold_min"], "train", x["train"], "test", x["test"])
