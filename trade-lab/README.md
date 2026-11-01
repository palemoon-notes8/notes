# Trade Lab

Personal trading website: install trading **skills** (strategies), paper-trade each one on
past market data with the same money rules and real NSE charges, and compare them.
Paper trading only - nothing here places real orders. Separate from OB Board.

Stage 1 (now): backtest on past data. Next: live paper trading of the skills that hold up,
then (only if you choose) a broker connection.

## Run on your PC

Python 3.9+, no packages to install. Run from this `trade-lab` folder.

```
python skilltest.py out      # downloads ~29 days of 1-minute NIFTY 50 data, tests every skill
python serve.py              # open http://127.0.0.1:8100
```

`python -m unittest discover tests` checks the engine and skills on made-up data.

## Online

`.github/workflows/lab-backtest.yml` (repository root) runs the test on GitHub and publishes `skills.json`
and the data archive to the `lab-data` branch. Open `site/index.html` from any static host
(it reads `lab-data/skills.json`), or locally with `serve.py`.

## Files

| File | What it does |
|---|---|
| `engine.py` | Replays each day minute by minute; fills, stops, targets, square-off, sizing, charges, summary |
| `market.py` | Free Yahoo 1-minute data for NIFTY 50 + index; keeps an archive so the test period grows |
| `skilltest.py` | Runs every skill, writes `out/skills.json` |
| `skills/` | One file per skill - see `skills/README.md` to add one |
| `site/index.html` | The website |
| `serve.py` | Local web server |

## Money rules (same for every skill, top of `engine.py`)

Start ₹1,00,000 · risk 1% of equity per trade · buying power 5× equity · stop for the day
after a 2% loss · 0.02% slippage on market orders · brokerage 0.03%/₹20, STT, NSE, SEBI,
stamp duty and GST. If a candle touches both stop and target, the stop counts first.

## Data limits

Yahoo keeps 1-minute candles for ~30 days, so a fresh start tests about 20 trading days.
Every run saves the days it downloads, so the period grows by a day each market day the
workflow runs. Free data can lag or have gaps; the previous close is the last 1-minute
close (the bot this skill comes from does the same).
