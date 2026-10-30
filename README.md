# OB Board

Personal board of NSE F&O stocks: strongest bullish and bearish setups ranked live, each with its order block, support, resistance and liquidity levels.

Analysis tool only, not investment advice.

## Run

Needs Python 3.9+. No packages to install.

```
python server.py
```

Open http://127.0.0.1:8000. The first scan takes 1–2 minutes.

## Data source

| Mode | When | Notes |
|---|---|---|
| Yahoo (free) | Default | Unofficial, no OI, may lag a few minutes |
| Dhan | `DHAN_CLIENT_ID` and `DHAN_TOKEN` set | Needs an active Dhan Data API plan; token lasts 24 h (web.dhan.co → My Profile → Access DhanHQ APIs) |

Windows:
```
set DHAN_CLIENT_ID=your_client_id
set DHAN_TOKEN=your_token
python server.py
```

## Phone

- Same Wi-Fi: `set HOST=0.0.0.0`, then open `http://<PC-IP>:8000` on the phone.
- Anywhere: install Tailscale on PC and phone, then open `http://<pc-name>:8000`.

The page has no login, so never expose it directly to the internet.

## Logic

| Item | Rule |
|---|---|
| Score | Move from previous close ÷ ATR(14, 5-min) × trend cleanliness × OI build-up factor |
| Choppy | Trend cleanliness (net move ÷ path length) below 0.25 scores 0 |
| Order block | Last opposite candle within 5 bars before a candle with body > 1.5×ATR; dropped once price closes through it |
| Support / resistance | Nearest swing low / high (2-bar fractal) or previous day low / high |
| Liquidity | Next swing level beyond support (bullish) or resistance (bearish) |

Tune `INTERVAL`, `CYCLE_MARKET` and `TOP_N` at the top of `server.py`.
