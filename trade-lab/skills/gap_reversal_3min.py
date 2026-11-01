"""Skill: 3-minute gap reversal breakout.

Rules from arshadakl/intraday-trading-bot (STRATEGY_RULES.md, "Three-Minute Breakout
Strategy"), re-written for Trade Lab - no code copied (that repository has no licence).
https://github.com/arshadakl/intraday-trading-bot
"""

SKILL = {
    "id": "gap-reversal-3min",
    "name": "3-min gap reversal breakout",
    "from": "arshadakl/intraday-trading-bot",
    "source": "https://github.com/arshadakl/intraday-trading-bot",
    "timeframe": 3,
    "universe": "NIFTY 50 stocks",
    "instrument": "Equity intraday (MIS)",
    "summary": "When NIFTY opens with a gap, fade the stocks that gapped most in the same "
               "direction - but only after a 3-minute candle closes beyond the first 3-minute candle.",
    "rules": [
        "09:15 - NIFTY gap = open vs previous close. Above +0.2% = gap up, below -0.2% = gap down, else flat.",
        "Rank NIFTY 50 stocks by their own opening gap.",
        "Gap up: SHORT the 2 biggest gap-up stocks. Gap down: LONG the 2 biggest gap-down stocks. "
        "Flat: SHORT the top 1 and LONG the bottom 1.",
        "Reference candle = first 3-minute candle (09:15-09:18). No trade before 09:18.",
        "LONG when a 3-minute candle closes above the reference high; SHORT when one closes below the reference low. "
        "Wicks do not count. Entry at that candle's close.",
        "Stop: the other side of the reference candle; if the reference candle is wider than 1%, 1% from entry instead.",
        "Target: 1% from entry. No trailing.",
        "One trade per stock, at most 2 a day, no new entries from 15:00, square off at 15:15.",
    ],
    "params": {
        "gap_threshold_percent": 0.2,
        "large_candle_percent": 1.0,
        "stop_loss_percent": 1.0,
        "target_percent": 1.0,
        "max_trades_per_day": 2,
        "no_new_trade_after": "15:00",
        "square_off": "15:15",
    },
}


class Skill:
    def __init__(self, params):
        self.p = params

    def start_day(self, ctx):
        self.picks, self.ref, self.done = None, {}, set()

    def on_bar(self, ctx):
        p = self.p
        if self.picks is None:                    # the reference candle (09:15-09:18) just closed
            self.picks = {}
            if ctx.k != 0 or not ctx.index or ctx.index[0]["k"] != 0 or not ctx.index_prev_close:
                ctx.note("No NIFTY opening candle - no trades today")
                return []
            gap = (ctx.index[0]["o"] / ctx.index_prev_close - 1) * 100
            ranked = sorted(((b[0]["o"] / ctx.prev_close[s] - 1) * 100, s) for s, b in ctx.bars.items()
                            if b and b[0]["k"] == 0 and ctx.prev_close.get(s))
            ranked.reverse()                      # biggest gap up first
            n, th = int(p["max_trades_per_day"]), float(p["gap_threshold_percent"])
            if gap > th:
                kind, picks = "gap up", {s: "SHORT" for _, s in ranked[:n]}
            elif gap < -th:
                kind, picks = "gap down", {s: "LONG" for _, s in ranked[-n:]}
            else:
                half = max(1, n // 2)
                kind = "flat"
                picks = {s: "SHORT" for _, s in ranked[:half]} | {s: "LONG" for _, s in ranked[-half:]}
            self.picks = picks
            self.ref = {s: ctx.bars[s][0] for s in picks}
            gaps = {s: g for g, s in ranked}
            ctx.note(f"NIFTY {gap:+.2f}% → {kind}. Watching " +
                     ", ".join(f"{s} {side} (gap {gaps[s]:+.2f}%)" for s, side in picks.items()))
            return []
        if ctx.start >= p["no_new_trade_after"]:
            return []
        orders = []
        for s, side in self.picks.items():
            bars = ctx.bars.get(s)
            if s in self.done or not bars or bars[-1]["k"] != ctx.k:
                continue
            ref, c = self.ref[s], bars[-1]["c"]
            large = (ref["h"] - ref["l"]) / ref["c"] * 100 > float(p["large_candle_percent"])
            sl, tp = float(p["stop_loss_percent"]) / 100, float(p["target_percent"]) / 100
            if side == "LONG" and c > ref["h"]:
                stop = c * (1 - sl) if large else ref["l"]
                orders.append({"sym": s, "side": side, "stop": stop, "target": c * (1 + tp),
                               "why": f"closed {c:.2f} above reference high {ref['h']:.2f}"})
            elif side == "SHORT" and c < ref["l"]:
                stop = c * (1 + sl) if large else ref["h"]
                orders.append({"sym": s, "side": side, "stop": stop, "target": c * (1 - tp),
                               "why": f"closed {c:.2f} below reference low {ref['l']:.2f}"})
            else:
                continue
            self.done.add(s)
        return orders
