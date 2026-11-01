"""Time Machine (India): odds check for the board's top setups, adapted from the method of
github.com/Jakeschincariol/day-trader-skill (MIT). Not a prediction.

For each top bullish/bearish stock with an order block: entry = last price, stop = order-block edge,
target = 2R, flat at 15:15. The rest of today is replayed REPLAYS times; each 5-min bar is drawn from the
stock's own past full sessions at the same time of day (+/-2 bars) and scaled to the current price.
History: on each past session, the same entry time and the same stop/target distances, what happened.
Usage: python tm.py <outdir>   (reads board.json, writes timemachine.json; caches 60-day bars per day)
"""
import json, os, random, sys, time
from datetime import datetime
import server

IST = server.IST
REPLAYS, SEED, WINDOW, TOP = 2000, 19, 2, 5
FLAT = (15, 15)
SLOTS = [(9 + (15 + 5 * k) // 60, (15 + 5 * k) % 60) for k in range(75)]      # 9:15 .. 15:25


def sessions(sym, cache):
    """Full past sessions as {date: [75 bars of (o,h,l,c)]}, cached for the day."""
    if sym not in cache:
        url = server.YAHOO.replace("range=5d", "range=60d")
        saved, server.YAHOO = server.YAHOO, url
        try:
            d = server.fetch_yahoo(sym)
        finally:
            server.YAHOO = saved
        days = {}
        for t, o, h, l, c in zip(d["timestamp"], d["open"], d["high"], d["low"], d["close"]):
            dt = datetime.fromtimestamp(t, IST)
            days.setdefault(dt.date().isoformat(), {})[(dt.hour, dt.minute)] = (o, h, l, c)
        full = {}
        for day, bars in days.items():
            if sum(s in bars for s in SLOTS) < 70 or SLOTS[0] not in bars:
                continue                                 # half days / big gaps are left out
            seq, last = [], None
            for s in SLOTS:                              # a few missing bars: flat bar at the last close
                last = bars.get(s) or (last[3],) * 4
                seq.append(last)
            full[day] = seq
        cache[sym] = full
        print(sym, len(days), "days fetched,", len(full), "usable")
        time.sleep(0.35)
    return cache[sym]


def ratios(full):
    """Per slot: list of (o,h,l,c) / previous close, from all past full sessions."""
    pool = [[] for _ in SLOTS]
    for bars in full.values():
        for k in range(1, len(SLOTS)):
            pc = bars[k - 1][3]
            pool[k].append(tuple(x / pc for x in bars[k]))
    return pool


def walk(path_bars, entry, stop, target, bull):
    """-> ('target'|'stop'|'neither', last close)."""
    last = entry
    for o, h, l, c in path_bars:
        if (l <= stop) if bull else (h >= stop):
            return "stop", c
        if (h >= target) if bull else (l <= target):
            return "target", c
        last = c
    return "neither", last


def r_of(outcome, last, entry, risk, bull):
    return 2.0 if outcome == "target" else -1.0 if outcome == "stop" else ((last - entry) / risk) * (1 if bull else -1)


def check(full, entry, stop, k_now, bull):
    risk = abs(entry - stop)
    target = entry + 2 * risk if bull else entry - 2 * risk
    k_end = SLOTS.index(FLAT)
    if k_now + 1 > k_end or risk <= 0:
        return None
    pool = ratios(full)
    cands = {k: [x for j in range(max(1, k - WINDOW), min(len(SLOTS) - 1, k + WINDOW) + 1) for x in pool[j]]
             for k in range(k_now + 1, k_end + 1)}
    rng = random.Random(SEED)
    counts = {"target": 0, "stop": 0, "neither": 0}
    rsum = 0.0
    for _ in range(REPLAYS):
        price, bars = entry, []
        for k in range(k_now + 1, k_end + 1):
            o, h, l, c = rng.choice(cands[k])
            bars.append((price * o, price * h, price * l, price * c))
            price *= c
        out, last = walk(bars, entry, stop, target, bull)
        counts[out] += 1
        rsum += r_of(out, last, entry, risk, bull)
    # history: same time of day and same % distances on each past session
    hist = {"target": 0, "stop": 0, "neither": 0}
    hr = []
    for bars in full.values():
        e = bars[k_now][3]
        s = e * stop / entry
        tg = e * target / entry
        out, last = walk(bars[k_now + 1:k_end + 1], e, s, tg, bull)
        hist[out] += 1
        hr.append(r_of(out, last, e, abs(e - s), bull))
    hit = counts["target"] + counts["stop"]
    share = counts["target"] / hit * 100 if hit else 0
    need = 100 / 3                                  # a 2R target breaks even at 1 win in 3
    gap = share - need
    verdict = ("Close to break-even" if abs(gap) < 5 else
               ("Leans toward the target" if gap > 0 else "Leans toward the stop") if abs(gap) < 15 else
               ("Strongly toward the target" if gap > 0 else "Strongly toward the stop"))
    return {"replays": REPLAYS, "seed": SEED, "sessions": len(full),
            "target_pct": round(counts["target"] / REPLAYS * 100, 1),
            "stop_pct": round(counts["stop"] / REPLAYS * 100, 1),
            "neither_pct": round(counts["neither"] / REPLAYS * 100, 1),
            "avg_r": round(rsum / REPLAYS, 2), "history": hist,
            "history_avg_r": round(sum(hr) / len(hr), 2) if hr else None,
            "verdict": verdict, "target": round(target, 2), "stop": round(stop, 2), "entry": round(entry, 2)}


def main(outdir):
    now = datetime.now(IST)
    with open(os.path.join(outdir, "board.json")) as f:
        board = json.load(f)
    cache_path = os.path.join(outdir, "tm_cache.json")
    try:
        with open(cache_path) as f:
            c = json.load(f)
        cache = c["bars"] if c.get("date") == now.date().isoformat() else {}
        cache = {k: v for k, v in cache.items() if len(v) >= 20}  # retry symbols that came back short
    except (OSError, ValueError):
        cache = {}
    k_now = max((k for k, s in enumerate(SLOTS) if s <= (now.hour, now.minute)), default=0)
    if now.weekday() > 4 or not (9, 20) <= (now.hour, now.minute) <= (15, 10):
        k_now = SLOTS.index((10, 15))               # outside market hours: show odds as if entering at 10:15
    out = {"made": now.strftime("%d %b %H:%M"), "as_of_slot": "%02d:%02d" % SLOTS[k_now], "results": {}}
    for side, rows in (("bull", board.get("bull", [])), ("bear", board.get("bear", []))):
        for r in rows[:TOP]:
            ob = r.get("ob")
            if not ob:
                continue
            bull = side == "bull"
            stop = ob["bot"] if bull else ob["top"]
            if (r["ltp"] - stop) * (1 if bull else -1) <= 0:
                continue
            try:
                full = sessions(r["sym"], cache)
            except Exception as e:
                print(r["sym"], "data error:", e)
                continue
            if len(full) < 20:
                continue
            res = check(full, r["ltp"], stop, k_now, bull)
            if res:
                out["results"][r["sym"]] = res | {"side": side}
    with open(cache_path, "w") as f:
        json.dump({"date": now.date().isoformat(), "bars": {k: {d: v for d, v in s.items()} for k, s in cache.items()}}, f)
    with open(os.path.join(outdir, "timemachine.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(len(out["results"]), "setups checked")


if __name__ == "__main__":
    main(sys.argv[1])
