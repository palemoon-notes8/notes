"""Skill: VWAP + RSI momentum (long only).

Rules from the README of arshadakl/intraday-trading-bot ("Enhanced VWAP + RSI strategy"),
re-written for Trade Lab - no code copied (that repository has no licence).
https://github.com/arshadakl/intraday-trading-bot

Differences, because the lab has no daily data: the bot scores NIFTY 50 stocks before the
open on ATR, volume, trend and RSI and watches the top 2; here the 2 stocks with the widest
previous-session range (%) that closed above their previous-session VWAP are watched.
The optional pivot-point filter is off by default in the bot and is left out.
"""
from skills._indicators import atr, rsi, vwap_series

SKILL = {
    "id": "vwap-rsi",
    "name": "VWAP + RSI momentum",
    "from": "arshadakl/intraday-trading-bot",
    "source": "https://github.com/arshadakl/intraday-trading-bot",
    "timeframe": 1,
    "universe": "NIFTY 50 stocks (2 picked each morning)",
    "instrument": "Equity intraday (MIS)",
    "summary": "Buy when a 1-minute candle closes back above VWAP on a volume surge with RSI in the "
               "40-70 zone; stop 2×ATR, target 4×ATR, exit early on RSI above 70 or a close below VWAP.",
    "rules": [
        "Watch 2 stocks: widest previous-day range %, closed above previous-day VWAP "
        "(approximation of the bot's pre-market score).",
        "From 09:30 to 15:00, on each 1-minute close: previous close at or below VWAP and this close above it (crossover).",
        "Not consolidating: fewer than 4 of the last 5 closes within 0.5% of VWAP.",
        "Volume of this candle at least 1.5× the average of the previous 20 candles.",
        "RSI(14) between 40 and 70.",
        "Stop = entry - 2×ATR(14), target = entry + 4×ATR(14), both on 1-minute candles.",
        "Exit early when RSI goes above 70 or a candle closes below VWAP. Square off at 15:15.",
        "Re-entry allowed after an exit; at most 5 trades a day.",
    ],
    "params": {
        "stocks": 2,
        "entry_from": "09:30",
        "no_new_trade_after": "15:00",
        "consolidation_percent": 0.5,
        "volume_surge": 1.5,
        "rsi_low": 40,
        "rsi_high": 70,
        "stop_atr": 2.0,
        "target_atr": 4.0,
        "max_trades_per_day": 5,
        "square_off": "15:15",
    },
}


class Skill:
    def __init__(self, params):
        self.p = params

    def start_day(self, ctx):
        self.watch = None

    def on_bar(self, ctx):
        p = self.p
        if self.watch is None:
            ok = [(v["range_pct"], s) for s, v in ctx.prev.items() if v["c"] > v["vwap"]]
            self.watch = [s for _, s in sorted(ok, reverse=True)[:int(p["stocks"])]]
            ctx.note("Watching " + (", ".join(f"{s} (prev range {ctx.prev[s]['range_pct']:.2f}%)"
                                              for s in self.watch) or "nothing - no stock closed above VWAP yesterday"))
        orders = []
        for s in self.watch:
            bars = ctx.bars.get(s) or []
            if len(bars) < 2 or bars[-1]["k"] != ctx.k:
                continue
            vw = vwap_series(bars)
            c, r = bars[-1]["c"], rsi([b["c"] for b in bars])
            if s in ctx.open:                                   # exits on candle close
                if c < vw[-1]:
                    orders.append({"exit": s, "why": f"closed {c:.2f} below VWAP {vw[-1]:.2f}"})
                elif r is not None and r > p["rsi_high"]:
                    orders.append({"exit": s, "why": f"RSI {r:.0f} above {p['rsi_high']}"})
                continue
            if not (p["entry_from"] <= ctx.start < p["no_new_trade_after"]) or r is None:
                continue
            if not (bars[-2]["c"] <= vw[-2] and c > vw[-1]):
                continue
            near = sum(abs(b["c"] - v) / v * 100 <= p["consolidation_percent"] for b, v in zip(bars[-5:], vw[-5:]))
            if near >= 4:
                continue
            prev20 = [b["v"] for b in bars[-21:-1]]
            avg_v = sum(prev20) / len(prev20)
            if avg_v <= 0 or bars[-1]["v"] < p["volume_surge"] * avg_v:
                continue
            if not (p["rsi_low"] <= r <= p["rsi_high"]):
                continue
            a = atr(bars)
            if not a:
                continue
            orders.append({"sym": s, "side": "LONG", "stop": c - p["stop_atr"] * a, "target": c + p["target_atr"] * a,
                           "why": f"crossed VWAP {vw[-1]:.2f}, volume {bars[-1]['v'] / avg_v:.1f}×, RSI {r:.0f}"})
        return orders
