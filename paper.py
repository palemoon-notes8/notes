"""Paper trading for OB Board: buys ATM stock options on the board's best setups.
No real orders. State is kept in trades.json next to board.json.

Option P&L is ESTIMATED from the stock move (ATM delta ~0.5) while the data source has
no option prices; time decay and spread are approximated by OPTION_COST_BPS.
If ANTHROPIC_API_KEY is set, Claude approves or rejects each candidate; the risk guard
below still applies to everything it approves.
"""
import json, os, re, urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

# ---- your rules ----
CAPITAL = 100_000           # starting paper capital (Rs)
RISK_PCT = 2.0              # max loss per trade, % of current equity
MAX_TRADES = 5              # new trades per day
DAY_STOP_PCT = 4.0          # stop trading for the day after this loss, % of capital
ENTRY_FROM, ENTRY_TO = (9, 30), (14, 30)
EXIT_AT = (15, 15)
MIN_SCORE = 3.0             # board strength needed to consider a stock
MAX_STOP_PCT = 2.0          # skip if the stop (beyond the order block) is wider than this % of price
TARGET_R = 2.0              # target = 2 x risk
DELTA = 0.5                 # ATM option moves ~half the stock
CHARGES = 60                # Rs per round trip (brokerage + taxes, rough)
OPTION_COST_BPS = 7         # time decay + bid-ask spread of stock options, as basis points of stock value traded
CANDIDATES = 5              # top N from each side of the board

AI_MODEL = "claude-haiku-5-5"


def cost(t):
    return CHARGES + OPTION_COST_BPS / 1e4 * t["entry"] * t["qty"]


def now_ist():
    return datetime.now(IST)


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"capital": CAPITAL, "open": [], "closed": [], "log": []}


def note(st, msg):
    st["log"] = (st["log"] + [f'{now_ist():%d %b %H:%M} {msg}'])[-60:]


def close_trade(st, t, price, why, ts):
    move = (price - t["entry"]) * (1 if t["side"] == "CALL" else -1)
    t.update(exit=round(price, 2), exit_time=datetime.fromtimestamp(ts, IST).strftime("%H:%M"),
             why=why, pnl=round(move * DELTA * t["qty"] - cost(t)))
    st["open"].remove(t)
    st["closed"].append(t)
    note(st, f'EXIT {t["sym"]} {t["side"]} {why} P&L {t["pnl"]}')


def manage_open(st, candles, now):
    """Exit on stop, target (checked candle by candle) or the 15:15 time exit."""
    for t in list(st["open"]):
        d = candles.get(t["sym"])
        if not d:
            continue
        bull = t["side"] == "CALL"
        for i, ts in enumerate(d["timestamp"]):
            if ts <= t["ts"]:
                continue
            hit_stop = d["low"][i] <= t["stop"] if bull else d["high"][i] >= t["stop"]
            hit_tgt = d["high"][i] >= t["target"] if bull else d["low"][i] <= t["target"]
            if hit_stop:                                   # both in one candle -> assume the stop (conservative)
                close_trade(st, t, t["stop"], "stop", ts)
                break
            if hit_tgt:
                close_trade(st, t, t["target"], "target", ts)
                break
            if datetime.fromtimestamp(ts, IST).date() > datetime.fromtimestamp(t["ts"], IST).date():
                close_trade(st, t, d["open"][i], "next-day open", ts)   # missed the time exit
                break
        else:
            if (now.hour, now.minute) >= EXIT_AT and t in st["open"]:
                close_trade(st, t, d["close"][-1], "time exit", d["timestamp"][-1])


def candidates(board, lots, equity):
    """Rule filter: strong score, an order block, a tight stop, and an affordable size."""
    out = []
    for side, rows in (("CALL", board["bull"]), ("PUT", board["bear"])):
        for r in rows[:CANDIDATES]:
            ob, ltp = r.get("ob"), r["ltp"]
            if not ob or abs(r["score"]) < MIN_SCORE:
                continue
            stop = ob["bot"] if side == "CALL" else ob["top"]
            risk_sh = (ltp - stop) if side == "CALL" else (stop - ltp)
            if risk_sh <= 0 or risk_sh / ltp * 100 > MAX_STOP_PCT:
                continue
            lot = lots.get(r["sym"], 0)
            if lot <= 0:
                continue
            lots_n = int(equity * RISK_PCT / 100 // (risk_sh * DELTA * lot))
            if lots_n < 1:
                continue
            tgt = ltp + TARGET_R * risk_sh if side == "CALL" else ltp - TARGET_R * risk_sh
            out.append({"sym": r["sym"], "side": side, "entry": ltp, "stop": stop, "target": round(tgt, 2),
                        "qty": lots_n * lot, "lots": lots_n, "score": r["score"], "chg": r["chg"],
                        "res": r.get("res"), "sup": r.get("sup"), "liq": r.get("liq")})
    return out


def ai_review(cands):
    """Ask Claude which candidates to take. Returns {sym: reason} of approved ones, or None if unavailable."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        return None
    prompt = (
        "You are a disciplined intraday trader. For each candidate below (buying an ATM stock option), "
        "decide take=true only if trend, order-block entry, nearby resistance/support and target room "
        "make it a high-quality setup; otherwise false. Be selective.\n"
        "Reply with ONLY a JSON array: [{\"sym\":..., \"take\":true|false, \"reason\":\"<15 words\"}]\n\n"
        + json.dumps([{k: c[k] for k in ("sym", "side", "entry", "stop", "target", "score", "chg", "res", "sup", "liq")}
                      for c in cands]))
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", method="POST",
        data=json.dumps({"model": AI_MODEL, "max_tokens": 800,
                         "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = "".join(b.get("text", "") for b in json.load(r).get("content", []))
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        raise ValueError("no JSON in AI reply")
    names = {c["sym"] for c in cands}
    return {d["sym"]: str(d.get("reason", ""))[:120] for d in json.loads(m.group(0))
            if isinstance(d, dict) and d.get("take") is True and d.get("sym") in names}


def step(state, lots, outdir):
    path = os.path.join(outdir, "trades.json")
    st = load(path)
    now = now_ist()
    today = now.strftime("%Y-%m-%d")
    manage_open(st, state["candles"], now)

    equity = st["capital"] + sum(t["pnl"] for t in st["closed"])
    day_closed = [t for t in st["closed"] if t["date"] == today]
    day_pnl = sum(t["pnl"] for t in day_closed)
    taken = len(day_closed) + sum(t["date"] == today for t in st["open"])

    can_enter = (now.weekday() < 5 and ENTRY_FROM <= (now.hour, now.minute) <= ENTRY_TO
                 and taken < MAX_TRADES and day_pnl > -st["capital"] * DAY_STOP_PCT / 100)
    if can_enter:
        held = {t["sym"] for t in st["open"]} | {t["sym"] for t in day_closed}
        cands = [c for c in candidates(state["board"], lots, equity) if c["sym"] not in held]
        if cands:
            try:
                approved = ai_review(cands)
            except Exception as e:                       # AI configured but failed -> take nothing (safe side)
                approved = {}
                note(st, f"AI unavailable, no new trades: {str(e)[:80]}")
            for c in cands:
                if taken >= MAX_TRADES:
                    break
                if approved is not None and c["sym"] not in approved:
                    continue
                c.update(date=today, time=now.strftime("%H:%M"), ts=state["candles"][c["sym"]]["timestamp"][-1],
                         by="AI" if approved is not None else "rules",
                         reason=(approved or {}).get(c["sym"], "rules matched"))
                st["open"].append(c)
                taken += 1
                note(st, f'ENTRY {c["sym"]} {c["side"]} x{c["lots"]} lot @ {c["entry"]} stop {c["stop"]} target {c["target"]} ({c["by"]})')

    closed = st["closed"]
    wins = [t for t in closed if t["pnl"] > 0]
    st["summary"] = {
        "equity": round(equity), "total_pnl": round(equity - st["capital"]), "day_pnl": round(day_pnl),
        "trades": len(closed), "win_rate": round(len(wins) / len(closed) * 100) if closed else None,
        "trades_today": taken, "updated": now.strftime("%d %b %H:%M"),
        "mode": "AI + rules" if os.environ.get("ANTHROPIC_API_KEY") else "rules only",
        "estimate": True}
    st["closed"] = closed[-300:]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, separators=(",", ":"))
    os.replace(tmp, path)
