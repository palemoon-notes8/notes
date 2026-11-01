"""Compare popular Indian intraday strategies on the same free 5-min data (~60 days).
Each is tested as ATM option buying (delta 0.5, decay+spread cost) and as stock futures.
Same risk rules as paper.py. Usage: python compare.py <outdir>  -> strategies.json
"""
import json, os, sys
from datetime import datetime
import server, paper, backtest as bt

IST = server.IST
INSTR = {"options": {"delta": 0.5, "bps": paper.OPTION_COST_BPS},
         "futures": {"delta": 1.0, "bps": 4}}          # futures: STT + exchange fees + slippage, rough
MARGIN = 0.20                                         # futures margin, share of contract value


def hm(ts):
    t = datetime.fromtimestamp(ts, IST)
    return t.hour, t.minute


def supertrend(h, l, c, n=10, m=3.0):
    up, st, out = [True] * len(c), [0.0] * len(c), []
    atr = 0.0
    fu = fl = 0.0
    for i in range(len(c)):
        tr = h[i] - l[i] if i == 0 else max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        atr = tr if i == 0 else (atr * (n - 1) + tr) / n
        mid = (h[i] + l[i]) / 2
        bu, bl = mid + m * atr, mid - m * atr
        if i == 0:
            fu, fl = bu, bl
        else:
            fu = bu if bu < fu or c[i - 1] > fu else fu
            fl = bl if bl > fl or c[i - 1] < fl else fl
            up[i] = True if c[i] > fu else False if c[i] < fl else up[i - 1]
        st[i] = fl if up[i] else fu
    return up, st


def signals(name, d, s, e, prev, cache):
    """First signal of the day for one stock: (i, side, stop) or None. Uses only data up to i."""
    o, h, l, c, v, ts = d["open"], d["high"], d["low"], d["close"], d["volume"], d["timestamp"]
    pdh, pdl, pdc = prev
    if name == "ORB 15-min":
        if e - s < 4:
            return None
        hi, lo = max(h[s:s + 3]), min(l[s:s + 3])
        if (hi - lo) / c[s] > 0.015:
            return None
        for i in range(s + 3, e + 1):
            if hm(ts[i]) > (11, 0):
                return None
            if c[i] > hi:
                return i, "CALL", lo
            if c[i] < lo:
                return i, "PUT", hi
    elif name == "VWAP trend":
        pv = vv = 0.0
        vw = []
        for i in range(s, e + 1):
            tp = (h[i] + l[i] + c[i]) / 3
            pv += tp * (v[i] or 1); vv += v[i] or 1
            vw.append(pv / vv)
        for i in range(s + 1, e + 1):
            t = hm(ts[i])
            if t < (10, 0) or t > paper.ENTRY_TO:
                continue
            chg = c[i] / pdc - 1
            a, b = vw[i - 1 - s], vw[i - s]
            if chg > 0.005 and c[i - 1] < a and c[i] > b:
                return i, "CALL", min(l[i - 1], l[i])
            if chg < -0.005 and c[i - 1] > a and c[i] < b:
                return i, "PUT", max(h[i - 1], h[i])
    elif name == "Supertrend 10,3":
        if "st" not in cache:
            cache["st"] = supertrend(h, l, c)
        up, st = cache["st"]
        for i in range(s + 1, e + 1):
            t = hm(ts[i])
            if t < paper.ENTRY_FROM or t > paper.ENTRY_TO:
                continue
            if up[i] and not up[i - 1]:
                return i, "CALL", st[i]
            if not up[i] and up[i - 1]:
                return i, "PUT", st[i]
    elif name == "Prev-day high/low breakout":
        for i in range(s + 1, e + 1):
            t = hm(ts[i])
            if t < paper.ENTRY_FROM or t > (13, 0):
                continue
            if c[i] > pdh >= c[i - 1]:
                return i, "CALL", min(l[i - 1], l[i])
            if c[i] < pdl <= c[i - 1]:
                return i, "PUT", max(h[i - 1], h[i])
    return None


def simulate(name, data, lots, ins):
    delta, bps = ins["delta"], ins["bps"]
    by_day = {}
    for sym, d in data.items():
        cache, days = {}, d["day"]
        starts = [i for i in range(len(days)) if i == 0 or days[i] != days[i - 1]]
        for k in range(1, len(starts)):
            s = starts[k]
            e = (starts[k + 1] - 1) if k + 1 < len(starts) else len(days) - 1
            ps = starts[k - 1]
            prev = (max(d["high"][ps:s]), min(d["low"][ps:s]), d["close"][s - 1])
            sig = signals(name, d, s, e, prev, cache)
            if not sig:
                continue
            i, side, stop = sig
            entry = d["close"][i]
            risk = (entry - stop) if side == "CALL" else (stop - entry)
            if risk <= 0 or risk / entry * 100 > paper.MAX_STOP_PCT:
                continue
            by_day.setdefault(days[s], []).append((d["timestamp"][i], sym, side, entry, stop, risk, i, e))
    eq, trades, curve = float(paper.CAPITAL), [], []
    for day in sorted(by_day):
        realised, taken = [], 0                       # (exit_ts, pnl)
        for ts, sym, side, entry, stop, risk, i, e in sorted(by_day[day]):
            if taken >= paper.MAX_TRADES:
                break
            if sum(p for x, p in realised if x <= ts) <= -paper.CAPITAL * paper.DAY_STOP_PCT / 100:
                break
            lot = lots.get(sym, 0)
            if lot <= 0:
                continue
            n = int(eq * paper.RISK_PCT / 100 // (risk * delta * lot))
            if delta == 1.0:
                n = min(n, int(eq // (MARGIN * entry * lot)))
            if n < 1:
                continue
            d, bull, qty = data[sym], side == "CALL", n * lot
            tgt = entry + paper.TARGET_R * risk if bull else entry - paper.TARGET_R * risk
            px, why, xts = d["close"][e], "time exit", d["timestamp"][e]
            for j in range(i + 1, e + 1):
                if hm(d["timestamp"][j]) >= paper.EXIT_AT:
                    px, why, xts = d["close"][j], "time exit", d["timestamp"][j]
                    break
                if (d["low"][j] <= stop) if bull else (d["high"][j] >= stop):
                    px, why, xts = stop, "stop", d["timestamp"][j]
                    break
                if (d["high"][j] >= tgt) if bull else (d["low"][j] <= tgt):
                    px, why, xts = tgt, "target", d["timestamp"][j]
                    break
            pnl = round((px - entry) * (1 if bull else -1) * delta * qty - paper.CHARGES - bps / 1e4 * entry * qty)
            realised.append((xts, pnl)); taken += 1
            trades.append({"date": day.isoformat(), "sym": sym, "side": side, "why": why, "pnl": pnl})
        day_pnl = sum(p for _, p in realised)
        eq += day_pnl
        curve.append({"date": day.isoformat(), "equity": round(eq), "pnl": round(day_pnl)})
    return trades, curve


def board(data, lots, ins):
    saved = paper.DELTA, paper.OPTION_COST_BPS
    paper.DELTA, paper.OPTION_COST_BPS = ins["delta"], ins["bps"]
    try:
        return bt.run(data, lots)
    finally:
        paper.DELTA, paper.OPTION_COST_BPS = saved


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    futs = server.load_futures()
    data, fails = bt.fetch_all(futs)
    print(f"Loaded {len(data)} stocks, {fails} failed")
    if len(data) < 50:
        raise SystemExit("Too few stocks loaded")
    names = ["OB Board (yours)", "ORB 15-min", "VWAP trend", "Supertrend 10,3", "Prev-day high/low breakout"]
    rows = []
    for name in names:
        for kind, ins in INSTR.items():
            tr, cv = board(data, server.LOTS, ins) if name.startswith("OB") else simulate(name, data, server.LOTS, ins)
            s = bt.summarise(tr, cv)
            rows.append({"strategy": name, "instrument": kind} | {k: s[k] for k in (
                "trades", "final_equity", "total_pnl", "win_rate", "profit_factor", "max_drawdown", "green_days", "days")})
            print(rows[-1])
    with open(os.path.join(out, "strategies.json"), "w") as f:
        json.dump({"made": datetime.now(IST).strftime("%d %b %Y %H:%M"), "stocks": len(data),
                   "start": cv[0]["date"] if cv else None, "end": cv[-1]["date"] if cv else None,
                   "rows": rows}, f, separators=(",", ":"))
