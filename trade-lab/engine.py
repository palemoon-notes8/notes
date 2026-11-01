"""Trade Lab paper-trading engine: replays past 1-minute candles day by day and lets each
skill trade them as if live. No real orders are ever placed.

How a day is replayed
- Every minute from 09:15 to 15:29: open positions are checked against that minute's
  candle (stop first if both stop and target are inside it - the cautious assumption).
- When a skill-timeframe candle closes (e.g. every 3 min), the skill gets every closed
  candle of the day so far - never the future - and may return orders.
- Orders fill at that candle's close plus slippage; stop and square-off fills get
  slippage too, a target (limit order) does not. A candle that opens beyond the stop
  fills at its open (gap-through).
- Positions still open at the skill's square-off time close at that minute's open.

The money rules below are the same for every skill, so skills can be compared fairly.
"""
from datetime import timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
OPEN_MIN = 9 * 60 + 15          # 09:15
MINUTES = 375                   # 09:15 .. 15:29

# ---- lab money rules (same for every skill) ----
CAPITAL = 100_000               # starting paper capital, Rs
RISK_PCT = 1.0                  # loss at the stop, % of current equity, per trade
LEVERAGE = 5.0                  # intraday (MIS) buying power = 5 x equity (20% margin)
DAY_STOP_PCT = 2.0              # no new trades once the day's realised loss reaches this % of equity
SLIPPAGE_BPS = 2.0              # 0.02% worse fill on market orders (entry, stop, square-off)

# ---- NSE equity intraday charges, discount broker (2026) ----
BROKERAGE_PCT, BROKERAGE_CAP = 0.03, 20.0     # per executed order: 0.03% or Rs 20, lower
STT_SELL_PCT = 0.025                          # on the sell side
EXCHANGE_PCT = 0.00297                        # NSE transaction charge, both sides
SEBI_PCT = 0.0001                             # Rs 10 per crore
STAMP_BUY_PCT = 0.003                         # on the buy side
GST_PCT = 18.0                                # on brokerage + exchange + SEBI


def charges(buy_value, sell_value):
    """Total charges in Rs for one intraday round trip."""
    brok = sum(min(BROKERAGE_CAP, v * BROKERAGE_PCT / 100) for v in (buy_value, sell_value))
    turnover = buy_value + sell_value
    exch, sebi = turnover * EXCHANGE_PCT / 100, turnover * SEBI_PCT / 100
    stt, stamp = sell_value * STT_SELL_PCT / 100, buy_value * STAMP_BUY_PCT / 100
    return brok + exch + sebi + stt + stamp + (brok + exch + sebi) * GST_PCT / 100


def hhmm(minute_index):
    m = OPEN_MIN + minute_index
    return f"{m // 60:02d}:{m % 60:02d}"


def to_index(text):
    """'15:15' -> minute index from 09:15."""
    h, m = map(int, text.split(":"))
    return h * 60 + m - OPEN_MIN


class Ctx:
    """What a skill sees when a candle closes. Everything here is in the past."""

    def __init__(self, date, prev_close, index_prev_close, prev=None):
        self.date = date                        # datetime.date
        self.prev_close = prev_close            # {sym: previous session close}
        self.prev = prev or {}                  # {sym: {"h", "l", "c", "vwap", "range_pct"}} previous session
        self.index_prev_close = index_prev_close
        self.bars = {}                          # {sym: [closed candles today, oldest first]}
        self.index = []                         # NIFTY 50 closed candles today
        self.k = -1                             # number of the candle that just closed (0 = first)
        self.start = self.end = ""              # its start and close time, "HH:MM"
        self.open = {}                          # {sym: "LONG"/"SHORT"} positions open now
        self.notes = []

    def note(self, text):
        self.notes.append(f"{self.end} {text}" if self.end else text)


def candle(day_sym, pos, lo, hi, k):
    """Merge the 1-minute candles lo..hi (pos = {minute: list index}) into one candle, or None."""
    idx = [pos[m] for m in range(lo, hi + 1) if m in pos]
    if not idx:
        return None
    return {"k": k, "t": hhmm(lo), "o": day_sym["o"][idx[0]], "h": max(day_sym["h"][i] for i in idx),
            "l": min(day_sym["l"][i] for i in idx), "c": day_sym["c"][idx[-1]],
            "v": sum(day_sym["v"][i] or 0 for i in idx)}


def session(d):
    """Previous-session summary of one symbol's 1-minute candles."""
    vol = sum(d["v"])
    tp = [(h + l + c) / 3 for h, l, c in zip(d["h"], d["l"], d["c"])]
    h, l, c = max(d["h"]), min(d["l"]), d["c"][-1]
    return {"h": h, "l": l, "c": c, "range_pct": (h - l) / c * 100,
            "vwap": sum(t * v for t, v in zip(tp, d["v"])) / vol if vol else sum(tp) / len(tp)}


def run_day(skill, meta, day, prev_close, index_prev_close, equity, prev=None):
    """Replay one day for one skill. day = {"date", "symbols": {sym: {m,o,h,l,c,v}}, "index": {...}|None}.
    Returns (trades, notes)."""
    tf = int(meta["timeframe"])
    p = meta["params"]
    square = to_index(p.get("square_off", "15:15"))
    max_trades = int(p.get("max_trades_per_day", 99))
    syms = day["symbols"]
    by_min = {s: {m: i for i, m in enumerate(d["m"])} for s, d in syms.items()}
    index_pos = {m: i for i, m in enumerate(day["index"]["m"])} if day.get("index") else {}
    ctx = Ctx(day["date"], prev_close, index_prev_close, prev)
    ctx.bars = {s: [] for s in syms}
    skill.start_day(ctx)
    open_, trades, taken, day_pnl = [], [], 0, 0.0
    slip = SLIPPAGE_BPS / 1e4

    def close(t, px, why, minute):
        nonlocal day_pnl
        long_ = t["side"] == "LONG"
        if why != "target":
            px *= (1 - slip) if long_ else (1 + slip)
        buy, sell = (t["entry"], px) if long_ else (px, t["entry"])
        gross = (sell - buy) * t["qty"]
        cost = charges(buy * t["qty"], sell * t["qty"])
        t.update(exit=round(px, 2), exit_time=hhmm(minute), why=why, gross=round(gross, 2),
                 costs=round(cost, 2), pnl=round(gross - cost, 2),
                 r=round((gross - cost) / t["risk_rs"], 2) if t["risk_rs"] else 0)
        open_.remove(t)
        ctx.open.pop(t["sym"], None)
        trades.append(t)
        day_pnl += t["pnl"]

    for minute in range(MINUTES):
        # 1) manage open positions on this minute's candle
        for t in list(open_):
            i = by_min[t["sym"]].get(minute)
            if minute >= square:
                if i is not None:
                    close(t, syms[t["sym"]]["o"][i], "square-off", minute)
                continue
            if i is None or minute <= t["_entry_min"]:
                continue
            d, long_ = syms[t["sym"]], t["side"] == "LONG"
            o, h, l = d["o"][i], d["h"][i], d["l"][i]
            if long_:
                if o <= t["stop"]:
                    close(t, o, "stop", minute)
                elif l <= t["stop"]:
                    close(t, t["stop"], "stop", minute)
                elif o >= t["target"]:
                    close(t, o, "target", minute)
                elif h >= t["target"]:
                    close(t, t["target"], "target", minute)
            else:
                if o >= t["stop"]:
                    close(t, o, "stop", minute)
                elif h >= t["stop"]:
                    close(t, t["stop"], "stop", minute)
                elif o <= t["target"]:
                    close(t, o, "target", minute)
                elif l <= t["target"]:
                    close(t, t["target"], "target", minute)
        # 2) a skill candle closes at the end of this minute
        if (minute + 1) % tf:
            continue
        k, lo = minute // tf, minute - tf + 1
        for s, d in syms.items():
            b = candle(d, by_min[s], lo, minute, k)
            if b:
                ctx.bars[s].append(b)
        if day.get("index"):
            b = candle(day["index"], index_pos, lo, minute, k)
            if b:
                ctx.index.append(b)
        ctx.k, ctx.start, ctx.end = k, hhmm(lo), hhmm(minute + 1)
        orders = skill.on_bar(ctx) or []
        for od in orders:
            if "exit" in od:                                    # skill asks to close a position
                for t in open_:
                    if t["sym"] == od["exit"]:
                        bars = ctx.bars[t["sym"]]
                        close(t, bars[-1]["c"], "skill exit", minute + 1)
                        t["why_out"] = od.get("why", "")
                        break
                continue
            s, side = od["sym"], od["side"]
            bars = ctx.bars.get(s) or []
            why_not = None
            if minute + 1 >= square:
                why_not = "past square-off"
            elif taken >= max_trades:
                why_not = "max trades for the day reached"
            elif day_pnl <= -equity * DAY_STOP_PCT / 100:
                why_not = "daily loss limit reached"
            elif s in ctx.open:
                why_not = "already in a position"
            elif not bars or bars[-1]["k"] != k:
                why_not = "no candle for it now"
            if why_not:
                ctx.note(f"skipped {s} {side}: {why_not}")
                continue
            long_ = side == "LONG"
            entry = bars[-1]["c"] * ((1 + slip) if long_ else (1 - slip))
            stop, target = float(od["stop"]), float(od["target"])
            risk = (entry - stop) if long_ else (stop - entry)
            room = (target - entry) if long_ else (entry - target)
            if risk <= 0 or room <= 0:
                ctx.note(f"skipped {s} {side}: stop or target on the wrong side of the fill")
                continue
            exposure = sum(t["entry"] * t["qty"] for t in open_)
            qty = min(int(equity * RISK_PCT / 100 // risk), int((equity * LEVERAGE - exposure) // entry))
            if qty < 1:
                ctx.note(f"skipped {s} {side}: position size below 1 share")
                continue
            t = {"date": day["date"].isoformat(), "sym": s, "side": side, "time": ctx.end,
                 "entry": round(entry, 2), "stop": round(stop, 2), "target": round(target, 2), "qty": qty,
                 "risk_rs": round(risk * qty, 2), "why_in": od.get("why", ""), "_entry_min": minute}
            open_.append(t)
            ctx.open[s] = side
            taken += 1
    for t in list(open_):                                       # data ended before square-off
        d = syms[t["sym"]]
        close(t, d["c"][-1], "square-off", d["m"][-1])
    for t in trades:
        t.pop("_entry_min", None)
    return trades, ctx.notes


def run_skill(module, days, params=None):
    """Replay every day (oldest first). days[0] only provides the previous close."""
    meta = dict(module.SKILL)
    meta["params"] = dict(meta.get("params", {}), **(params or {}))
    skill = module.Skill(meta["params"])
    equity, curve, log, trades = float(CAPITAL), [], [], []
    for prev, day in zip(days, days[1:]):
        if (day["date"] - prev["date"]).days > 5:              # a hole in the data: no reliable previous close
            continue
        pc = {s: d["c"][-1] for s, d in prev["symbols"].items() if d["c"]}
        ps = {s: session(d) for s, d in prev["symbols"].items() if d["c"]}
        ipc = prev["index"]["c"][-1] if prev.get("index") and prev["index"]["c"] else None
        tr, notes = run_day(skill, meta, day, pc, ipc, equity, ps)
        pnl = sum(t["pnl"] for t in tr)
        equity += pnl
        trades += tr
        curve.append({"date": day["date"].isoformat(), "equity": round(equity), "pnl": round(pnl)})
        log.append({"date": day["date"].isoformat(), "pnl": round(pnl), "notes": notes, "trades": tr})
    return {"meta": meta, "summary": summarise(trades, curve), "curve": curve, "days": log}


def summarise(trades, curve):
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    loss = [t["pnl"] for t in trades if t["pnl"] <= 0]
    peak, dd, dd_pct = CAPITAL, 0.0, 0.0
    for c in curve:
        peak = max(peak, c["equity"])
        dd = max(dd, peak - c["equity"])
        dd_pct = max(dd_pct, (peak - c["equity"]) / peak * 100)
    end = curve[-1]["equity"] if curve else CAPITAL
    side = lambda s: [t["pnl"] for t in trades if t["side"] == s]
    n = len(trades)
    return {
        "start": curve[0]["date"] if curve else None, "end": curve[-1]["date"] if curve else None,
        "days": len(curve), "trades": n, "capital": CAPITAL, "final_equity": round(end),
        "total_pnl": round(sum(t["pnl"] for t in trades)), "return_pct": round((end / CAPITAL - 1) * 100, 2),
        "costs": round(sum(t["costs"] for t in trades)),
        "win_rate": round(len(wins) / n * 100) if n else None,
        "avg_win": round(sum(wins) / len(wins)) if wins else 0,
        "avg_loss": round(sum(loss) / len(loss)) if loss else 0,
        "profit_factor": round(sum(wins) / -sum(loss), 2) if loss and sum(loss) < 0 else None,
        "avg_r": round(sum(t["r"] for t in trades) / n, 2) if n else None,
        "max_drawdown": round(dd), "max_drawdown_pct": round(dd_pct, 2),
        "green_days": sum(c["pnl"] > 0 for c in curve), "trade_days": sum(c["pnl"] != 0 for c in curve),
        "best_day": max((c["pnl"] for c in curve), default=0), "worst_day": min((c["pnl"] for c in curve), default=0),
        "by_exit": {w: sum(t["why"] == w for t in trades) for w in ("target", "stop", "square-off", "skill exit")},
        "long": {"trades": len(side("LONG")), "pnl": round(sum(side("LONG")))},
        "short": {"trades": len(side("SHORT")), "pnl": round(sum(side("SHORT")))},
    }
