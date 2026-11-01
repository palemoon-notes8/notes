"""Index option-buying pattern research (Nifty, Bank Nifty, Sensex, Fin Nifty, Midcap Nifty).
Free Yahoo hourly data (~2 years) + India VIX daily. Trades are taken at 10:15 (after the first hour)
and closed by stop, target or 15:15. Option P&L = 0.5 x index move - decay/spread cost.
Patterns are searched on the first 2/3 of the period (train) and judged on the last 1/3 (test).
Usage: python research.py <outdir>  -> research.json
"""
import csv, itertools, json, os, sys, time, urllib.request
from datetime import datetime
from urllib.parse import quote
import server

IST = server.IST
INDICES = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "SENSEX": "^BSESN",
           "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "MIDCPNIFTY": "NIFTY_MID_SELECT.NS"}
DEFAULT_LOTS = {"NIFTY": 75, "BANKNIFTY": 35, "SENSEX": 20, "FINNIFTY": 65, "MIDCPNIFTY": 140}
DELTA, BPS, CHARGES = 0.5, 6, 60          # cost: 6 bps of index value per option unit (decay + spread)
MIN_TRAIN, MIN_TEST = 40, 15


def yahoo(sym, interval, rng):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(sym)}?interval={interval}&range={rng}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)["chart"]["result"][0]
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5)
    q = res["indicators"]["quote"][0]
    rows = [(t, q["open"][i], q["high"][i], q["low"][i], q["close"][i]) for i, t in enumerate(res.get("timestamp") or [])
            if None not in (q["open"][i], q["high"][i], q["low"][i], q["close"][i])]
    return rows


def index_lots():
    lots = dict(DEFAULT_LOTS)
    try:
        server.load_futures()                                # makes sure the scrip master is downloaded
        best = {}
        with open(server.SCRIP_FILE, newline="", encoding="utf-8", errors="replace") as f:
            for r in csv.DictReader(f):
                if r.get("SEM_INSTRUMENT_NAME", "").strip() != "FUTIDX":
                    continue
                sym = r["SEM_TRADING_SYMBOL"].rsplit("-", 2)[0]
                if sym in lots and r.get("SEM_LOT_UNITS"):
                    exp = r.get("SEM_EXPIRY_DATE", "")[:10]
                    if sym not in best or exp < best[sym][0]:
                        best[sym] = (exp, int(float(r["SEM_LOT_UNITS"])))
        lots.update({s: v[1] for s, v in best.items()})
    except Exception as e:
        print("lot sizes: using defaults:", e)
    return lots


def days_from_hourly(rows):
    days = {}
    for t, o, h, l, c in rows:
        dt = datetime.fromtimestamp(t, IST)
        days.setdefault(dt.date(), []).append(((dt.hour, dt.minute), o, h, l, c))
    out = []
    for d in sorted(days):
        bars = sorted(days[d])
        if len(bars) >= 6 and bars[0][0] == (9, 15):
            out.append((d, bars))
    return out


def build(name, rows, vix):
    """One record per day with features known at 10:15 and the outcome of each trade variant."""
    days = days_from_hourly(rows)
    recs = []
    for k in range(21, len(days)):
        d, bars = days[k]
        hist = days[k - 20:k]
        dh = [max(b[2] for b in bs) for _, bs in hist]
        dl = [min(b[3] for b in bs) for _, bs in hist]
        dc = [bs[-1][4] for _, bs in hist]
        pc, atr = dc[-1], sum(h - l for h, l in zip(dh, dl)) / 20
        ranges7 = [h - l for h, l in zip(dh[-7:], dl[-7:])]
        _, o0, h0, l0, c0 = bars[0]
        if c0 == o0 or atr <= 0:
            continue
        up = c0 > o0
        gap = o0 / pc - 1
        f = {"gap": "up" if gap > 0.003 else "down" if gap < -0.003 else "flat",
             "gap_with_move": (gap > 0.003 and up) or (gap < -0.003 and not up),
             "first_hour_big": (h0 - l0) / atr > 0.35,
             "nr7": ranges7[-1] == min(ranges7),
             "with_trend": (pc > sum(dc) / 20) == up,
             "weekday": d.strftime("%a"),
             "vix": vix.get(d)}
        later = bars[1:]
        outs = {}
        for direction in ("momentum", "reversal"):
            bull = up if direction == "momentum" else not up
            entry = c0
            for stop_kind in ("full", "half"):
                far = l0 if bull else h0
                stop = far if stop_kind == "full" else (entry + far) / 2
                risk = (entry - stop) if bull else (stop - entry)
                if risk <= 0:
                    continue
                for exit_kind in ("target2R", "hold"):
                    tgt = entry + 2 * risk if bull else entry - 2 * risk
                    px = later[-1][4]
                    for tm, o, h, l, c in later:
                        if (l <= stop) if bull else (h >= stop):
                            px = stop; break
                        if exit_kind == "target2R" and ((h >= tgt) if bull else (l <= tgt)):
                            px = tgt; break
                        if tm >= (15, 15):
                            px = o; break                      # exit at 15:15
                    move = (px - entry) * (1 if bull else -1)
                    outs[(direction, stop_kind, exit_kind)] = (move, risk, entry)
        recs.append({"index": name, "date": d.isoformat(), "f": f, "out": outs})
    return recs


def r_mult(move, risk, entry, bps):
    """Result in R (1R = planned loss on the option) after decay/spread cost."""
    return (DELTA * move - bps / 1e4 * entry) / (DELTA * risk)


def stats(rs):
    if not rs:
        return None
    wins = [x for x in rs if x > 0]
    loss = [x for x in rs if x <= 0]
    return {"n": len(rs), "avg_R": round(sum(rs) / len(rs), 3), "win": round(len(wins) / len(rs) * 100),
            "pf": round(sum(wins) / -sum(loss), 2) if loss and sum(loss) < 0 else None}


def conditions(vix_median):
    single = [("gap", v) for v in ("up", "down", "flat")] + \
             [(k, v) for k in ("gap_with_move", "first_hour_big", "nr7", "with_trend") for v in (True, False)] + \
             [("weekday", v) for v in ("Mon", "Tue", "Wed", "Thu", "Fri")] + [("vix", "high"), ("vix", "low")]
    combos = [()] + [(c,) for c in single] + [p for p in itertools.combinations(single, 2) if p[0][0] != p[1][0]]
    def match(f, combo):
        for k, v in combo:
            if k == "vix":
                if f["vix"] is None or (f["vix"] > vix_median) != (v == "high"):
                    return False
            elif f[k] != v:
                return False
        return True
    return combos, match


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    vix = {datetime.fromtimestamp(t, IST).date(): c for t, o, h, l, c in yahoo("^INDIAVIX", "1d", "3y")}
    vdates = sorted(vix)
    vix_prev = {d2: vix[d1] for d1, d2 in zip(vdates, vdates[1:])}      # yesterday's VIX, known at 10:15
    recs, loaded = [], []
    for name, sym in INDICES.items():
        try:
            r = build(name, yahoo(sym, "60m", "2y"), vix_prev)
            if len(r) > 100:
                recs += r; loaded.append(name)
            print(name, len(r), "days")
        except Exception as e:
            print(name, "failed:", e)
        time.sleep(1)
    if len(loaded) < 2:
        raise SystemExit("Too little data loaded")
    dates = sorted({r["date"] for r in recs})
    cut = dates[len(dates) * 2 // 3]
    train = [r for r in recs if r["date"] < cut]
    test = [r for r in recs if r["date"] >= cut]
    vix_vals = sorted(r["f"]["vix"] for r in train if r["f"]["vix"] is not None)
    vix_median = vix_vals[len(vix_vals) // 2] if vix_vals else 0
    combos, match = conditions(vix_median)

    variants = sorted({k for r in recs for k in r["out"]})
    found = []
    for var in variants:
        for combo in combos:
            tr = [r_mult(*r["out"][var], BPS) for r in train if var in r["out"] and match(r["f"], combo)]
            if len(tr) < MIN_TRAIN:
                continue
            st = stats(tr)
            if st["avg_R"] <= 0:
                continue
            te = [r_mult(*r["out"][var], BPS) for r in test if var in r["out"] and match(r["f"], combo)]
            found.append({"rule": " + ".join(f"{k}={v}" for k, v in combo) or "every day", "trade": var[0],
                          "stop": var[1], "exit": var[2], "train": st, "test": stats(te)})
    found.sort(key=lambda x: -x["train"]["avg_R"])
    top = found[:25]
    held = [x for x in found if x["test"] and x["test"]["n"] >= MIN_TEST and x["test"]["avg_R"] > 0]
    held.sort(key=lambda x: -(x["test"]["avg_R"] * min(1, x["test"]["n"] / 40)))

    lots = index_lots()
    def detail(x):
        """Per-index result and cost sensitivity for one rule over the whole period."""
        var = (x["trade"], x["stop"], x["exit"])
        combo = [c for c in combos if (" + ".join(f"{k}={v}" for k, v in c) or "every day") == x["rule"]][0]
        rows = [r for r in recs if var in r["out"] and match(r["f"], combo)]
        per = {}
        for name in loaded:
            rr = [r for r in rows if r["index"] == name]
            rupees = [lots[name] * (DELTA * r["out"][var][0] - BPS / 1e4 * r["out"][var][2]) - CHARGES for r in rr]
            per[name] = stats([r_mult(*r["out"][var], BPS) for r in rr]) or {"n": 0}
            if rr:
                per[name]["rs_per_lot_trade"] = round(sum(rupees) / len(rupees))
                per[name]["rs_per_lot_total"] = round(sum(rupees))
        sens = {b: stats([r_mult(*r["out"][var], b) for r in rows]) for b in (3, 6, 9, 12)}
        return x | {"per_index": per, "cost_sensitivity": sens}

    result = {"made": datetime.now(IST).strftime("%d %b %Y %H:%M"), "indices": loaded, "lots": lots,
              "period": [dates[0], dates[-1]], "train_until": cut, "days": len(dates),
              "hypotheses_tested": sum(1 for _ in variants) * len(combos), "positive_on_train": len(found),
              "held_on_test": len(held), "top_train": top, "best_holdouts": [detail(x) for x in held[:8]],
              "baseline": [{"trade": v[0], "stop": v[1], "exit": v[2],
                            "all": stats([r_mult(*r["out"][v], BPS) for r in recs if v in r["out"]])} for v in variants]}
    with open(os.path.join(out, "research.json"), "w") as f:
        json.dump(result, f, separators=(",", ":"))
    print(json.dumps({k: result[k] for k in ("indices", "period", "train_until", "hypotheses_tested",
                                             "positive_on_train", "held_on_test")}))
    for x in result["best_holdouts"][:8]:
        print(x["rule"], x["trade"], x["stop"], x["exit"], "train", x["train"], "test", x["test"])
