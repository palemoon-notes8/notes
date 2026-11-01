"""Backtest of the paper-trading rules on free Yahoo 5-min data (~last 60 days).
Replays the board every 15 minutes, takes trades with paper.py's rules (rules only, no AI),
and writes backtest.json.  Usage: python backtest.py <outdir>
Option P&L is estimated from the stock move (ATM delta 0.5) minus paper.cost() for decay and spread.
"""
import json, os, sys, time
from datetime import datetime
import server, paper

IST, STEP = server.IST, 3            # evaluate every 3rd 5-min candle = every 15 min


def fetch_all(futs):
    data, fails = {}, 0
    server.YAHOO = server.YAHOO.replace("range=5d", "range=60d")
    for sym in futs:
        try:
            d = server.fetch_yahoo(sym)
            if d and len(d["close"]) > 100:
                d["day"] = [datetime.fromtimestamp(t, IST).date() for t in d["timestamp"]]
                data[sym] = d
        except Exception as e:
            fails += 1
            print(f"{sym}: {e}")
        time.sleep(0.35)
    return data, fails


def window(d, i):
    """Candles of the previous session + today up to and including index i (what the live board sees)."""
    today = d["day"][i]
    s = i
    while s > 0 and d["day"][s - 1] == today:
        s -= 1
    if s == 0:
        return None
    p = s - 1
    while p > 0 and d["day"][p - 1] == d["day"][s - 1]:
        p -= 1
    return {k: d[k][p:i + 1] for k in ("open", "high", "low", "close", "volume", "timestamp", "oi")}


def run(data, lots):
    days = sorted({x for d in data.values() for x in d["day"]})[1:]       # first day only provides history
    eq, trades, curve = float(paper.CAPITAL), [], []
    idx = {s: {} for s in data}                                            # sym -> {timestamp: index}
    for s, d in data.items():
        idx[s] = {t: i for i, t in enumerate(d["timestamp"])}
    for day in days:
        slots = sorted({t for d in data.values() for t, x in zip(d["timestamp"], d["day"]) if x == day})
        open_, day_pnl, taken, used = [], 0.0, 0, set()
        for k, ts in enumerate(slots):
            hm = datetime.fromtimestamp(ts, IST)
            hm = (hm.hour, hm.minute)
            # manage open trades on this candle
            for t in list(open_):
                i = idx[t["sym"]].get(ts)
                if i is None:
                    continue
                d, bull = data[t["sym"]], t["side"] == "CALL"
                stop = d["low"][i] <= t["stop"] if bull else d["high"][i] >= t["stop"]
                tgt = d["high"][i] >= t["target"] if bull else d["low"][i] <= t["target"]
                px = t["stop"] if stop else t["target"] if tgt else d["close"][i] if hm >= paper.EXIT_AT else None
                if px is not None:
                    move = (px - t["entry"]) * (1 if bull else -1)
                    t.update(exit=round(px, 2), why="stop" if stop else "target" if tgt else "time exit",
                             pnl=round(move * paper.DELTA * t["qty"] - paper.cost(t)))
                    open_.remove(t); trades.append(t); day_pnl += t["pnl"]; eq += t["pnl"]
            # new entries every 15 min inside the entry window
            if k % STEP or not (paper.ENTRY_FROM <= hm <= paper.ENTRY_TO):
                continue
            if taken >= paper.MAX_TRADES or day_pnl <= -paper.CAPITAL * paper.DAY_STOP_PCT / 100:
                continue
            rows = []
            for s, d in data.items():
                i = idx[s].get(ts)
                w = window(d, i) if i is not None else None
                if w and len(w["close"]) > 20:
                    rows.append(server.analyse(s, w)[0])
            board = {"bull": sorted([r for r in rows if r["score"] > 0], key=lambda r: -r["score"])[:20],
                     "bear": sorted([r for r in rows if r["score"] < 0], key=lambda r: r["score"])[:20]}
            for c in paper.candidates(board, lots, eq):
                if taken >= paper.MAX_TRADES or c["sym"] in used:
                    continue
                c.update(date=day.isoformat(), time=f"{hm[0]:02d}:{hm[1]:02d}")
                open_.append(c); used.add(c["sym"]); taken += 1
        for t in open_:                                                    # data ended before 15:15
            d = data[t["sym"]]
            last = max(i for i, x in enumerate(d["day"]) if x == day)
            move = (d["close"][last] - t["entry"]) * (1 if t["side"] == "CALL" else -1)
            t.update(exit=round(d["close"][last], 2), why="time exit", pnl=round(move * paper.DELTA * t["qty"] - paper.cost(t)))
            trades.append(t); day_pnl += t["pnl"]; eq += t["pnl"]
        curve.append({"date": day.isoformat(), "equity": round(eq), "pnl": round(day_pnl)})
    return trades, curve


def summarise(trades, curve):
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    loss = [t["pnl"] for t in trades if t["pnl"] <= 0]
    peak, dd = paper.CAPITAL, 0
    for c in curve:
        peak = max(peak, c["equity"]); dd = max(dd, peak - c["equity"])
    return {"start": curve[0]["date"] if curve else None, "end": curve[-1]["date"] if curve else None,
            "days": len(curve), "trades": len(trades), "capital": paper.CAPITAL,
            "final_equity": curve[-1]["equity"] if curve else paper.CAPITAL,
            "total_pnl": round(sum(t["pnl"] for t in trades)),
            "win_rate": round(len(wins) / len(trades) * 100) if trades else None,
            "avg_win": round(sum(wins) / len(wins)) if wins else 0,
            "avg_loss": round(sum(loss) / len(loss)) if loss else 0,
            "profit_factor": round(sum(wins) / -sum(loss), 2) if loss and sum(loss) < 0 else None,
            "max_drawdown": round(dd), "green_days": sum(c["pnl"] > 0 for c in curve),
            "by_exit": {w: sum(t["why"] == w for t in trades) for w in ("target", "stop", "time exit")},
            "made": datetime.now(IST).strftime("%d %b %Y %H:%M")}


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    futs = server.load_futures()
    data, fails = fetch_all(futs)
    print(f"Loaded {len(data)} stocks, {fails} failed")
    if len(data) < 50:
        raise SystemExit("Too few stocks loaded; not writing a misleading backtest")
    trades, curve = run(data, server.LOTS)
    summary = summarise(trades, curve) | {"stocks": len(data)}
    keep = ("date", "time", "sym", "side", "lots", "entry", "stop", "target", "exit", "why", "pnl")
    with open(os.path.join(out, "backtest.json"), "w") as f:
        json.dump({"summary": summary, "curve": curve,
                   "trades": [{k: t[k] for k in keep} for t in trades]}, f, separators=(",", ":"))
    print(json.dumps(summary))
