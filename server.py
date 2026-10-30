"""Personal OrderBlock board for NSE F&O stocks.
Stdlib only. Run:  python server.py   then open http://127.0.0.1:8000
Data source: Dhan Data API if DHAN_CLIENT_ID + DHAN_TOKEN are set, otherwise free
Yahoo Finance charts (unofficial, no OI, may lag a few minutes). Optional HOST, PORT.
"""
import csv, json, os, threading, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote

IST = timezone(timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIP_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
SCRIP_FILE = os.path.join(HERE, "scrip_master.csv")
API = "https://api.dhan.co/v2/charts/intraday"
INTERVAL = "5"          # minutes per candle
CALL_GAP = 0.22         # Data API limit is 5 req/s
CYCLE_MARKET = 120      # seconds between full scans in market hours
CYCLE_OFF = 900         # outside market hours
TOP_N = 20

CLIENT_ID = os.environ.get("DHAN_CLIENT_ID", "").strip()
TOKEN = os.environ.get("DHAN_TOKEN", "").strip()
SOURCE = "dhan" if CLIENT_ID and TOKEN else "yahoo"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=5m&range=5d"

state = {"board": {"bull": [], "bear": [], "counts": {}, "updated": None,
                   "status": "starting", "errors": 0}, "candles": {}, "levels": {}}
lock = threading.Lock()


# ---------- instruments ----------
def load_futures():
    """Nearest-expiry NSE stock future for each underlying: {symbol: security_id}."""
    today = datetime.now(IST).date()
    fresh = os.path.exists(SCRIP_FILE) and \
        datetime.fromtimestamp(os.path.getmtime(SCRIP_FILE), IST).date() == today
    if not fresh:
        with urllib.request.urlopen(SCRIP_URL, timeout=60) as r, open(SCRIP_FILE, "wb") as f:
            while chunk := r.read(1 << 16):
                f.write(chunk)
    best = {}
    with open(SCRIP_FILE, newline="", encoding="utf-8", errors="replace") as f:
        rd = csv.DictReader(f)
        need = {"SEM_EXM_EXCH_ID", "SEM_INSTRUMENT_NAME", "SEM_SMST_SECURITY_ID",
                "SEM_TRADING_SYMBOL", "SEM_EXPIRY_DATE"}
        if not need.issubset(rd.fieldnames or []):
            raise RuntimeError(f"Scrip master columns changed: {rd.fieldnames}")
        for row in rd:
            if row["SEM_EXM_EXCH_ID"] != "NSE" or row["SEM_INSTRUMENT_NAME"].strip() != "FUTSTK":
                continue
            try:
                exp = datetime.strptime(row["SEM_EXPIRY_DATE"][:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            if exp < today:
                continue
            sym = row["SEM_TRADING_SYMBOL"].rsplit("-", 2)[0]   # "BAJAJ-AUTO-Nov2026-FUT"
            if sym not in best or exp < best[sym][0]:
                best[sym] = (exp, row["SEM_SMST_SECURITY_ID"].strip())
    if not best:
        raise RuntimeError("No FUTSTK contracts found in scrip master")
    return {s: v[1] for s, v in sorted(best.items())}


# ---------- data ----------
class TokenError(Exception):
    pass


def fetch(sec_id):
    now = datetime.now(IST)
    body = json.dumps({
        "securityId": sec_id, "exchangeSegment": "NSE_FNO", "instrument": "FUTSTK",
        "interval": INTERVAL, "oi": True,
        "fromDate": (now - timedelta(days=7)).strftime("%Y-%m-%d 09:15:00"),
        "toDate": now.strftime("%Y-%m-%d %H:%M:%S"),
    }).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "access-token": TOKEN, "client-id": CLIENT_ID})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise TokenError(f"HTTP {e.code}: token expired/invalid or Data API plan inactive")
            if e.code == 429 and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise
    n = len(d.get("close") or [])
    if n == 0:
        return None
    oi = d.get("open_interest") or [0] * n
    return {k: d[k] for k in ("open", "high", "low", "close", "volume", "timestamp")} | {"oi": oi}


def fetch_yahoo(sym):
    url = YAHOO.format(quote(sym + ".NS"))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    res = (d.get("chart") or {}).get("result")
    if not res or not res[0].get("timestamp"):
        return None
    q = res[0]["indicators"]["quote"][0]
    keep = [i for i, x in enumerate(q.get("close") or []) if x is not None and q["open"][i] is not None]
    out = {k: [q[k][i] for i in keep] for k in ("open", "high", "low", "close")}
    out["volume"] = [q["volume"][i] or 0 for i in keep]
    out["timestamp"] = [res[0]["timestamp"][i] for i in keep]
    out["oi"] = [0] * len(keep)                             # Yahoo has no OI
    return out


# ---------- analysis ----------
def day_of(ts):
    return datetime.fromtimestamp(ts, IST).date()


def atr(h, l, c, n=14):
    tr = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
                          for i in range(1, len(c))]
    tail = tr[-n:]
    return sum(tail) / len(tail)


def swings(h, l, start, k=2):
    hi, lo = [], []
    for i in range(max(start, k), len(h) - k):
        if h[i] == max(h[i - k:i + k + 1]):
            hi.append(h[i])
        if l[i] == min(l[i - k:i + k + 1]):
            lo.append(l[i])
    return hi, lo


def order_block(o, h, l, c, a, start, bullish):
    """Latest unmitigated OB: last opposite candle (within 5 bars) before a displacement
    candle whose body > 1.5*ATR. Mitigated if any later close goes through the zone."""
    for i in range(len(c) - 1, start, -1):
        body = c[i] - o[i]
        if (body if bullish else -body) <= 1.5 * a:
            continue
        for j in range(i - 1, max(i - 6, start - 1), -1):
            if (c[j] < o[j]) if bullish else (c[j] > o[j]):
                top, bot = h[j], l[j]
                later = c[j + 1:]
                broken = any(x < bot for x in later) if bullish else any(x > top for x in later)
                if not broken:
                    return {"top": top, "bot": bot}
                break
    return None


def analyse(sym, d):
    o, h, l, c, ts, oi = d["open"], d["high"], d["low"], d["close"], d["timestamp"], d["oi"]
    days = [day_of(t) for t in ts]
    sess = [i for i, x in enumerate(days) if x == days[-1]]
    s0 = sess[0]
    prev_days = sorted({x for x in days if x < days[-1]})
    prev = [i for i, x in enumerate(days) if prev_days and x == prev_days[-1]]
    prev_close = c[s0 - 1] if s0 > 0 else o[s0]
    ltp = c[-1]
    a = atr(h, l, c) or 1e-9

    path = abs(c[s0] - prev_close) + sum(abs(c[i] - c[i - 1]) for i in sess[1:])
    er = abs(ltp - prev_close) / path if path else 0.0      # 1 = clean trend, 0 = chop
    oi_prev = oi[s0 - 1] if s0 > 0 else 0
    oi_chg = (oi[-1] / oi_prev - 1) * 100 if oi_prev else 0.0
    oi_factor = 1 + max(-0.5, min(1.0, oi_chg / 10))        # OI build-up confirms the move
    score = 0.0 if er < 0.25 else (ltp - prev_close) / a * er * oi_factor
    bullish = score > 0

    start = prev[0] if prev else s0                         # look back over previous + current session
    sh, sl = swings(h, l, start)
    if prev:
        sh.append(max(h[i] for i in prev))                  # PDH
        sl.append(min(l[i] for i in prev))                  # PDL
    above = sorted({x for x in sh if x > ltp})
    below = sorted({x for x in sl if x < ltp}, reverse=True)
    lv = {"ob": order_block(o, h, l, c, a, start, bullish) if score else None,
          "res": above[0] if above else None, "sup": below[0] if below else None}
    pool = below if bullish else above                      # stops sit beyond the opposite swing
    lv["liq"] = pool[1] if len(pool) > 1 else None
    r2 = lambda x: round(x, 2) if x is not None else None
    lv = {"ob": lv["ob"] and {k: r2(v) for k, v in lv["ob"].items()},
          "res": r2(lv["res"]), "sup": r2(lv["sup"]), "liq": r2(lv["liq"])}

    row = {"sym": sym, "ltp": round(ltp, 2), "chg": round((ltp / prev_close - 1) * 100, 2),
           "score": round(score, 2), "er": round(er, 2), "oi_chg": round(oi_chg, 1)} | lv
    return row, start


def scan_loop(futs):
    while True:
        t0 = time.time()
        rows, candles, errors = [], {}, 0
        for sym, sid in futs.items():
            try:
                d = fetch(sid) if SOURCE == "dhan" else fetch_yahoo(sym)
                if d and len(d["close"]) > 20:
                    row, start = analyse(sym, d)
                    rows.append(row)
                    candles[sym] = {k: v[start:] for k, v in d.items()}
            except TokenError as e:
                with lock:
                    state["board"]["status"] = str(e)
                time.sleep(60)
                break
            except Exception as e:                         # one bad symbol must not stop the scan
                errors += 1
                print(f"{sym}: {e}")
            time.sleep(CALL_GAP if SOURCE == "dhan" else 0.35)
        if rows:
            bull = sorted([r for r in rows if r["score"] > 0], key=lambda r: -r["score"])
            bear = sorted([r for r in rows if r["score"] < 0], key=lambda r: r["score"])
            with lock:
                state["board"] = {
                    "bull": bull[:TOP_N], "bear": bear[:TOP_N], "errors": errors, "status": "ok",
                    "source": SOURCE,
                    "counts": {"bullish": len(bull), "bearish": len(bear),
                               "choppy": len(rows) - len(bull) - len(bear), "total": len(rows)},
                    "updated": datetime.now(IST).strftime("%H:%M:%S")}
                state["candles"] = candles
                state["levels"] = {r["sym"]: r for r in rows}
        now = datetime.now(IST)
        live = now.weekday() < 5 and (9, 15) <= (now.hour, now.minute) <= (15, 35)
        time.sleep(max(5, (CYCLE_MARKET if live else CYCLE_OFF) - (time.time() - t0)))


# ---------- web ----------
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if u.path == "/api/board":
            with lock:
                return self._send(200, state["board"])
        if u.path == "/api/chart":
            sym = (parse_qs(u.query).get("sym") or [""])[0]
            with lock:
                d, lv = state["candles"].get(sym), state["levels"].get(sym)
            if not d:
                return self._send(404, {"error": "unknown symbol"})
            return self._send(200, {"candles": d, "levels": lv})
        self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    futs = load_futures()
    print(f"Data source: {SOURCE}. {len(futs)} F&O stocks loaded. First scan takes ~1-2 minutes.")
    threading.Thread(target=scan_loop, args=(futs,), daemon=True).start()
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8000"))
    print(f"Open http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
