"""Live paper test #1: Thursday reversal on index options (found by research.py).
Rule: on Thursday, if yesterday's India VIX close is above THRESHOLD, at 10:15 buy the ATM option
opposite to the first-hour (9:15-10:15) move; stop = beyond the first-hour extreme; exit at 15:15.
P&L per 1 lot is estimated: lot x (0.5 x index move - decay/spread) - charges.
State lives in thursday.json; run every few minutes: python thursday.py <outdir>
"""
import json, os, sys
from datetime import datetime
import research

IST = research.IST
TRAIN_UNTIL = "2026-03-11"          # VIX threshold = median VIX before this date (as in the research)
INDICES = research.INDICES
LOTS = research.DEFAULT_LOTS | {"NIFTY": 65, "BANKNIFTY": 30, "SENSEX": 20, "FINNIFTY": 60, "MIDCPNIFTY": 120}
DELTA, BPS, CHARGES = research.DELTA, research.BPS, research.CHARGES


def bars_today(sym, today):
    out = []
    for t, o, h, l, c in research.yahoo(sym, "5m", "5d"):
        dt = datetime.fromtimestamp(t, IST)
        if dt.date() == today:
            out.append(((dt.hour, dt.minute), o, h, l, c))
    return sorted(out)


def vix_info(today):
    rows = [(datetime.fromtimestamp(t, IST).date(), c) for t, o, h, l, c in research.yahoo("^INDIAVIX", "1d", "2y")]
    train = sorted(c for d, c in rows if d.isoformat() < TRAIN_UNTIL)
    thr = train[len(train) // 2]
    prev = [c for d, c in rows if d < today]
    return thr, (prev[-1] if prev else None)


def pnl(t, px):
    move = (px - t["entry"]) * (1 if t["side"] == "CALL" else -1)
    rupees = t["lot"] * (DELTA * move - BPS / 1e4 * t["entry"]) - CHARGES
    r = (DELTA * move - BPS / 1e4 * t["entry"]) / (DELTA * t["risk"])
    return round(rupees), round(r, 2)


def step(outdir):
    path = os.path.join(outdir, "thursday.json")
    try:
        with open(path) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {"trades": [], "days": []}
    now = datetime.now(IST)
    today = now.date()
    hm = (now.hour, now.minute)
    thr, vix_prev = vix_info(today)
    st["vix_threshold"], st["vix_prev"] = round(thr, 2), vix_prev and round(vix_prev, 2)
    is_thu = today.weekday() == 3
    active = is_thu and vix_prev is not None and vix_prev > thr
    st["status"] = ("Thursday — condition met (VIX high): trading" if active else
                    "Thursday — VIX not high: no trades today" if is_thu else
                    f"Waiting for Thursday. Yesterday's VIX {st['vix_prev']} vs threshold {st['vix_threshold']}")
    if is_thu and today.isoformat() not in [d["date"] for d in st["days"]] and hm >= (10, 15):
        st["days"].append({"date": today.isoformat(), "vix_prev": st["vix_prev"], "traded": active})

    if active and hm >= (10, 15):
        for name, sym in INDICES.items():
            try:
                bars = bars_today(sym, today)
            except Exception as e:
                print(name, "data error:", e)
                continue
            fh = [b for b in bars if b[0] < (10, 15)]
            if len(fh) < 10:
                continue
            o0, h0, l0, c0 = fh[0][1], max(b[2] for b in fh), min(b[3] for b in fh), fh[-1][4]
            t = next((x for x in st["trades"] if x["date"] == today.isoformat() and x["index"] == name), None)
            if t is None and c0 != o0:
                side = "PUT" if c0 > o0 else "CALL"           # reversal: against the first hour
                stop = h0 if side == "PUT" else l0
                risk = abs(stop - c0)
                if risk >= 0.002 * c0:
                    t = {"date": today.isoformat(), "index": name, "side": side, "entry": round(c0, 2),
                         "stop": round(stop, 2), "risk": round(risk, 2), "lot": LOTS[name], "status": "open"}
                    st["trades"].append(t)
                else:
                    st["trades"].append({"date": today.isoformat(), "index": name, "status": "skipped",
                                         "why": "first-hour range too small"})
                    continue
            if not t or t["status"] != "open":
                continue
            for b_hm, o, h, l, c in bars:
                if b_hm < (10, 15):
                    continue
                hit = (h >= t["stop"]) if t["side"] == "PUT" else (l <= t["stop"])
                if hit:
                    t.update(status="stop", exit=t["stop"], exit_time=f"{b_hm[0]:02d}:{b_hm[1]:02d}")
                    break
                if b_hm >= (15, 15):
                    t.update(status="time exit", exit=round(o, 2), exit_time="15:15")
                    break
            last = bars[-1][4]
            t["last"] = round(last, 2)
            t["pnl_rs"], t["pnl_r"] = pnl(t, t.get("exit", last))

    done = [t for t in st["trades"] if t["status"] in ("stop", "time exit")]
    st["summary"] = {"trades": len(done), "wins": sum(t["pnl_rs"] > 0 for t in done),
                     "total_rs": sum(t["pnl_rs"] for t in done), "total_r": round(sum(t["pnl_r"] for t in done), 2),
                     "updated": now.strftime("%d %b %H:%M")}
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, separators=(",", ":"))
    os.replace(tmp, path)
    print(st["status"], st["summary"])


if __name__ == "__main__":
    os.makedirs(sys.argv[1], exist_ok=True)
    step(sys.argv[1])
