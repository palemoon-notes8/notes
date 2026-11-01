"""Run: python -m unittest discover tests"""
import gzip, json, os, random, sys, tempfile, unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine, market, skilltest
from skills import gap_reversal_3min as gap


def flat(price, n=engine.MINUTES):
    return [(price, price, price, price)] * n


def series(rows):
    return {"m": list(range(len(rows))), "o": [r[0] for r in rows], "h": [r[1] for r in rows],
            "l": [r[2] for r in rows], "c": [r[3] for r in rows], "v": [1000] * len(rows)}


def day(dt, syms, index):
    return {"date": dt, "symbols": {s: series(r) for s, r in syms.items()}, "index": series(index)}


D0, D1 = date(2026, 10, 1), date(2026, 10, 2)


class Charges(unittest.TestCase):
    def test_round_trip(self):
        # brokerage 20+20, STT 25.25, exchange 5.97, SEBI 0.20, stamp 3, GST 18% of 46.17
        self.assertAlmostEqual(engine.charges(100_000, 101_000), 82.73, places=1)


class GapReversal(unittest.TestCase):
    def setUp(self):
        self.prev = day(D0, {"A": flat(100), "B": flat(100), "C": flat(100), "D": flat(100)}, flat(25_000))

    def test_gap_up_short_hits_target(self):
        a = [(103, 103.5, 102.5, 103)] * 3                       # reference candle 09:15-09:18
        a += [(102.8, 102.9, 102.2, 102.3)] * 3                  # 09:18-09:21 closes below 102.5 -> SHORT
        a += [(102.3, 102.4, 102.0, 102.1)] * 10
        a += [(101.5, 101.6, 101.0, 101.1)]                      # reaches the 1% target
        a += flat(101.1, engine.MINUTES - len(a))
        b = [(102, 102.6, 101.8, 102.2)] * 3 + flat(102.3, engine.MINUTES - 3)   # never breaks its low
        today = day(D1, {"A": a, "B": b, "C": flat(100), "D": flat(99)}, flat(25_125))   # NIFTY +0.5%
        r = engine.run_skill(gap, [self.prev, today])
        notes = " ".join(r["days"][0]["notes"])
        self.assertIn("gap up", notes)
        self.assertIn("A SHORT", notes)
        self.assertIn("B SHORT", notes)
        [t] = r["days"][0]["trades"]
        self.assertEqual((t["sym"], t["side"], t["time"], t["why"]), ("A", "SHORT", "09:21", "target"))
        self.assertAlmostEqual(t["entry"], 102.3 * (1 - 2e-4), places=2)
        self.assertEqual(t["stop"], 103.5)
        self.assertAlmostEqual(t["target"], 102.3 * 0.99, places=2)
        self.assertEqual(t["qty"], int(1000 // (103.5 - t["entry"])))       # 1% of 1,00,000 at risk
        self.assertGreater(t["pnl"], 0)
        self.assertLess(t["pnl"], t["gross"])

    def test_gap_down_long_stopped_through_gap(self):
        d = [(97, 97.4, 96.8, 97)] * 3 + [(97.2, 97.6, 97.1, 97.5)] * 3   # LONG at 97.5, stop 96.8
        d += [(96.0, 96.1, 95.9, 96.0)]                                     # opens below the stop
        d += flat(96, engine.MINUTES - len(d))
        today = day(D1, {"A": flat(101), "B": flat(100), "C": flat(99), "D": d}, flat(24_875))
        r = engine.run_skill(gap, [self.prev, today])
        t = [x for x in r["days"][0]["trades"] if x["sym"] == "D"][0]
        self.assertEqual((t["side"], t["why"]), ("LONG", "stop"))
        self.assertAlmostEqual(t["exit"], 96.0 * (1 - 2e-4), places=2)   # filled at the open, not the stop
        self.assertLess(t["r"], -1)

    def test_square_off(self):
        a = [(103, 103.5, 102.5, 103)] * 3 + [(102.6, 102.7, 102.3, 102.4)] * 3
        a += flat(102.4, engine.MINUTES - len(a))
        today = day(D1, {"A": a, "B": flat(102), "C": flat(100), "D": flat(99)}, flat(25_125))
        [t] = engine.run_skill(gap, [self.prev, today])["days"][0]["trades"]
        self.assertEqual((t["why"], t["exit_time"]), ("square-off", "15:15"))

    def test_large_reference_candle_uses_percent_stop(self):
        a = [(103, 104.5, 102.5, 103)] * 3 + [(102.6, 102.7, 102.3, 102.4)] * 3   # range ~1.9%
        a += flat(102.4, engine.MINUTES - len(a))
        today = day(D1, {"A": a, "B": flat(102), "C": flat(100), "D": flat(99)}, flat(25_125))
        [t] = engine.run_skill(gap, [self.prev, today])["days"][0]["trades"]
        self.assertAlmostEqual(t["stop"], 102.4 * 1.01, places=2)


class NoLookahead(unittest.TestCase):
    def test_skill_only_sees_closed_candles(self):
        seen = []

        class Peek:
            SKILL = {"id": "peek", "timeframe": 5, "params": {}}

            class Skill:
                def __init__(self, p): pass
                def start_day(self, ctx): pass
                def on_bar(self, ctx):
                    seen.append((ctx.k, max(b["k"] for b in ctx.bars["A"]), ctx.end))
                    return []

        rows = [(100 + i, 100 + i, 100 + i, 100 + i) for i in range(engine.MINUTES)]
        engine.run_skill(Peek, [day(D0, {"A": flat(100)}, flat(1)), day(D1, {"A": rows}, flat(1))])
        self.assertEqual(len(seen), engine.MINUTES // 5)
        self.assertTrue(all(k == last for k, last, _ in seen))
        self.assertEqual(seen[0][2], "09:20")


class Pipeline(unittest.TestCase):
    def test_offline_run_writes_skills_json(self):
        rnd = random.Random(7)
        with tempfile.TemporaryDirectory() as out:
            os.makedirs(os.path.join(out, "bars"))
            px = {f"S{i}": 100.0 + i for i in range(50)}
            nifty, dt = 25_000.0, date(2026, 9, 1)
            for _ in range(15):
                dt += timedelta(days=1)
                syms, gapn = {}, rnd.uniform(-0.8, 0.8) / 100
                for s in px:
                    p = px[s] * (1 + gapn + rnd.gauss(0, 0.01))
                    rows = []
                    for _ in range(engine.MINUTES):
                        q = p * (1 + rnd.gauss(0, 0.0012))
                        rows.append((p, max(p, q) * 1.0005, min(p, q) * 0.9995, q))
                        p = q
                    syms[s], px[s] = series(rows), p
                nifty *= 1 + gapn
                with gzip.open(os.path.join(out, "bars", f"{dt}.json.gz"), "wt") as f:
                    json.dump({"date": dt.isoformat(), "index": series(flat(round(nifty, 2))), "symbols": syms}, f)
            skilltest.main(out, offline=True)
            with open(os.path.join(out, "skills.json")) as f:
                doc = json.load(f)
            self.assertEqual(doc["data"]["days"], 15)
            s = doc["skills"][0]
            self.assertEqual(s["meta"]["id"], "gap-reversal-3min")
            self.assertEqual(len(s["curve"]), 14)
            self.assertGreater(s["summary"]["trades"], 5)
            self.assertLessEqual(max(len(d["trades"]) for d in s["days"]), 2)
            self.assertEqual(s["curve"][-1]["equity"], round(engine.CAPITAL + sum(
                t["pnl"] for d in s["days"] for t in d["trades"])))


class Archive(unittest.TestCase):
    def test_pack_and_complete(self):
        p = market.pack({1: (1, 2, 0.5, 1.5, 10), 0: (1, 1, 1, 1, None)})
        self.assertEqual((p["m"], p["v"]), ([0, 1], [0, 10]))
        self.assertTrue(market.complete(date(2020, 1, 1)))


if __name__ == "__main__":
    unittest.main()


from skills import ohl_breakout as ohl, vwap_rsi as vr


class OHL(unittest.TestCase):
    def test_open_low_gap_up_breaks_15min_high(self):
        prev = day(D0, {"A": [(100, 101, 99, 100)] * engine.MINUTES, "B": flat(100)}, flat(25_000))
        a = [(101, 101.4, 101, 101.3)] + [(101.3, 101.5, 101.1, 101.4)] * 14     # open = low, gap +1%
        a += [(101.4, 101.9, 101.4, 101.8)]                                        # 09:30 closes above 101.5
        a += [(101.8, 101.9, 101.7, 101.8)] * 10 + [(102, 103.5, 102, 103.4)]      # target 101.8 + 2*0.8 = 103.4
        a += flat(103.4, engine.MINUTES - len(a))
        idx = [(25_000, 25_000, 25_000, 25_000)] + [(25_050,) * 4] * (engine.MINUTES - 1)   # NIFTY up
        r = engine.run_skill(ohl, [prev, day(D1, {"A": a, "B": flat(100)}, idx)])
        self.assertIn("A LONG", r["days"][0]["notes"][0])
        [t] = r["days"][0]["trades"]
        self.assertEqual((t["sym"], t["side"], t["time"], t["stop"], t["why"]), ("A", "LONG", "09:31", 101.0, "target"))


class VwapRsi(unittest.TestCase):
    def test_crossover_with_volume_then_vwap_exit(self):
        prev = day(D0, {"A": [(100, 103, 97, 101)] * engine.MINUTES, "B": flat(100)}, flat(25_000))
        rows = []
        for i in range(40):                                  # choppy drift down from 100.5 to ~99.6
            c = 100.5 - 0.0225 * i + (0.15 if i % 2 else -0.15)
            rows.append((c, c + 0.1, c - 0.1, c))
        p = rows[-1][3]
        rows.append((p, 100.3, p - .05, 100.25))             # close back above VWAP
        rows += [(100.25, 100.3, 99.5, 99.5)] + flat(99.5, engine.MINUTES - len(rows) - 1)
        a = series(rows)
        a["v"] = [1000] * 40 + [5000] + [1000] * (engine.MINUTES - 41)
        today = {"date": D1, "symbols": {"A": a, "B": series(flat(100))}, "index": series(flat(25_000))}
        r = engine.run_skill(vr, [prev, today])
        trades = r["days"][0]["trades"]
        self.assertEqual(len(trades), 1, r["days"][0]["notes"])
        self.assertEqual((trades[0]["side"], trades[0]["time"]), ("LONG", "09:56"))
        self.assertIn(trades[0]["why"], ("stop", "skill exit"))
