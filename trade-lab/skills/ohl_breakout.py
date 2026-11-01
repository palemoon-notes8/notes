"""Skill: OHL (Open = High / Open = Low) opening breakout.

Rules from the README of arshadakl/intraday-trading-bot ("OHL Strategy"), re-written for
Trade Lab - no code copied (that repository has no licence).
https://github.com/arshadakl/intraday-trading-bot

Differences, because the lab has no daily or pre-market data: the bot's ATR % (1.5-4%) and
pre-market volume filters are left out; the previous-day trend filter uses the previous
session's range from 1-minute data.
"""

SKILL = {
    "id": "ohl-breakout",
    "name": "OHL opening breakout",
    "from": "arshadakl/intraday-trading-bot",
    "source": "https://github.com/arshadakl/intraday-trading-bot",
    "timeframe": 1,
    "universe": "NIFTY 50 stocks",
    "instrument": "Equity intraday (MIS)",
    "summary": "Buy gap-up stocks whose open stays the day's low (sell gap-down stocks whose open stays the "
               "high) when they break their first-15-minute range in NIFTY's direction, 09:30-09:45 only.",
    "rules": [
        "Filters: price ₹100-5,000; previous-day range above 1% of its close.",
        "09:16 - tag stocks with open = low (within 0.06%) and a gap up as possible LONG; "
        "open = high and a gap down as possible SHORT.",
        "09:16-09:30 - drop a stock as soon as its open stops being the day's low (high).",
        "09:30-09:45 - LONG if NIFTY is above its open and a 1-minute candle closes above the stock's "
        "09:15-09:30 high; SHORT if NIFTY is below its open and a candle closes below that low.",
        "Stop = day low (LONG) / day high (SHORT). Target = 2× the risk.",
        "At most 2 trades a day, biggest gap first. Square off at 15:15.",
    ],
    "params": {
        "ohl_buffer_percent": 0.06,
        "min_price": 100,
        "max_price": 5000,
        "min_prev_range_percent": 1.0,
        "range_until": "09:30",
        "entry_until": "09:45",
        "target_r": 2.0,
        "max_trades_per_day": 2,
        "square_off": "15:15",
    },
}


class Skill:
    def __init__(self, params):
        self.p = params

    def start_day(self, ctx):
        self.tags, self.done = None, set()

    def on_bar(self, ctx):
        p = self.p
        buf = p["ohl_buffer_percent"] / 100
        if self.tags is None:                                   # 09:16: first 1-minute candle closed
            self.tags = {}
            for s, bars in ctx.bars.items():
                if not bars or bars[0]["k"] != 0 or s not in ctx.prev:
                    continue
                b, pv = bars[0], ctx.prev[s]
                if not (p["min_price"] <= b["o"] <= p["max_price"]) or pv["range_pct"] <= p["min_prev_range_percent"]:
                    continue
                gap = (b["o"] / pv["c"] - 1) * 100
                if b["l"] >= b["o"] * (1 - buf) and gap > 0:
                    self.tags[s] = ("LONG", gap)
                elif b["h"] <= b["o"] * (1 + buf) and gap < 0:
                    self.tags[s] = ("SHORT", gap)
            ctx.note("Tagged " + (", ".join(f"{s} {side} (gap {g:+.2f}%)" for s, (side, g) in self.tags.items())
                                  or "nothing"))
            return []
        for s, (side, _) in list(self.tags.items()):            # OHL must hold
            bars = ctx.bars.get(s) or []
            o = bars[0]["o"]
            if (side == "LONG" and min(b["l"] for b in bars) < o * (1 - buf)) or \
               (side == "SHORT" and max(b["h"] for b in bars) > o * (1 + buf)):
                del self.tags[s]
        if ctx.start < p["range_until"] or ctx.start >= p["entry_until"] or not ctx.index:
            return []
        up = ctx.index[-1]["c"] > ctx.index[0]["o"]
        orders = []
        for s, (side, gap) in sorted(self.tags.items(), key=lambda x: -abs(x[1][1])):
            bars = ctx.bars.get(s) or []
            if s in self.done or not bars or bars[-1]["k"] != ctx.k or (side == "LONG") != up:
                continue
            first = [b for b in bars if b["t"] < p["range_until"]]
            hi, lo, c = max(b["h"] for b in first), min(b["l"] for b in first), bars[-1]["c"]
            day_lo, day_hi = min(b["l"] for b in bars), max(b["h"] for b in bars)
            if side == "LONG" and c > hi:
                stop = day_lo
                orders.append({"sym": s, "side": side, "stop": stop, "target": c + p["target_r"] * (c - stop),
                               "why": f"open = low, NIFTY up, closed {c:.2f} above 15-min high {hi:.2f}"})
            elif side == "SHORT" and c < lo:
                stop = day_hi
                orders.append({"sym": s, "side": side, "stop": stop, "target": c - p["target_r"] * (stop - c),
                               "why": f"open = high, NIFTY down, closed {c:.2f} below 15-min low {lo:.2f}"})
            else:
                continue
            self.done.add(s)
        return orders
