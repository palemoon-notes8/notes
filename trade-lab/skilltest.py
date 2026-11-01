"""Paper-trade every skill on past data and write skills.json for the website.

  python skilltest.py out            download recent data into out/bars, then test
  python skilltest.py out --offline  test only on data already in out/bars
"""
import json, os, sys, time
from datetime import datetime
import engine, market, skills


def main(out, offline=False):
    os.makedirs(out, exist_ok=True)
    bars = os.path.join(out, "bars")
    universe, where, saved, fails = [], "archive only", 0, []
    if not offline:
        universe, where = market.nifty50()
        saved, fails = market.update_archive(bars, universe)
        print(f"Saved {saved} days; {len(fails)} symbols failed: {' '.join(fails)}")
    days = market.load_archive(bars)
    if len(days) < 2:
        raise SystemExit("Need at least 2 days of data")
    results = []
    for mod in skills.load_all():
        t0 = time.time()
        r = engine.run_skill(mod, days)
        results.append(r)
        print(f"{mod.SKILL['id']}: {json.dumps(r['summary'])} ({time.time() - t0:.1f}s)")
    lab = {"capital": engine.CAPITAL, "risk_pct": engine.RISK_PCT, "leverage": engine.LEVERAGE,
           "day_stop_pct": engine.DAY_STOP_PCT, "slippage_bps": engine.SLIPPAGE_BPS}
    doc = {"made": datetime.now(engine.IST).strftime("%d %b %Y %H:%M"), "lab": lab,
           "data": {"first": days[0]["date"].isoformat(), "last": days[-1]["date"].isoformat(),
                    "days": len(days), "stocks": len(days[-1]["symbols"]), "list": where,
                    "saved_now": saved, "failed": fails},
           "skills": results}
    tmp = os.path.join(out, "skills.json.tmp")
    with open(tmp, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(out, "skills.json"))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], "--offline" in sys.argv)
