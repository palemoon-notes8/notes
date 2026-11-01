# Skills

A skill is one trading strategy. Every `.py` file in this folder that defines `SKILL` and
`Skill` is picked up automatically and paper-traded on the same past data as the others.

```python
SKILL = {
    "id": "my-skill",                 # unique, used in the website
    "name": "My skill",
    "from": "who wrote the idea",     # shown on the website
    "source": "https://...",          # link to the original
    "timeframe": 5,                   # minutes per candle the skill sees (1, 3, 5, 15 ...)
    "universe": "NIFTY 50 stocks",
    "instrument": "Equity intraday (MIS)",
    "summary": "One sentence.",
    "rules": ["Rule 1", "Rule 2"],
    "params": {"max_trades_per_day": 2, "square_off": "15:15"},   # both read by the engine too
}


class Skill:
    def __init__(self, params): ...
    def start_day(self, ctx): ...     # reset per-day state
    def on_bar(self, ctx):            # called each time a candle closes
        return [{"sym": "SBIN", "side": "LONG", "stop": 800.0, "target": 820.0, "why": "..."}]
        # or [{"exit": "SBIN", "why": "..."}] to close an open position at this candle's close
```

`ctx` (all in the past - a skill can never see the future):

| Field | Meaning |
|---|---|
| `ctx.bars[sym]` | today's closed candles, oldest first: `{"k","t","o","h","l","c","v"}` |
| `ctx.index` | NIFTY 50 index candles today, same shape |
| `ctx.prev_close[sym]`, `ctx.index_prev_close` | previous session close |
| `ctx.k`, `ctx.start`, `ctx.end` | number of the candle that just closed (0 = 09:15), its start and close time |
| `ctx.open` | `{sym: side}` positions open now |
| `ctx.note(text)` | a line in the day's log on the website |

The engine fills orders at the candle close (+slippage), sizes them with the lab's money
rules, checks stop and target every minute, and squares off at `square_off`.
Test before pushing: `python -m unittest discover tests`.

## Installed

| File | Skill | From |
|---|---|---|
| `gap_reversal_3min.py` | 3-min gap reversal breakout (the bot's active strategy, `STRATEGY_RULES.md`) | [arshadakl/intraday-trading-bot](https://github.com/arshadakl/intraday-trading-bot) |
| `vwap_rsi.py` | VWAP + RSI momentum (bot README) | same |
| `ohl_breakout.py` | OHL opening breakout (bot README) | same |

All three are re-written from that repo's rule descriptions; no code is copied (it has no licence).
Where the lab lacks the bot's daily or pre-market data, the skill file says what was approximated.
