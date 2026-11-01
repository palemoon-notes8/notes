"""Indicators shared by skills (files starting with "_" are not skills)."""


def vwap(bars):
    pv = vv = 0.0
    for b in bars:
        tp = (b["h"] + b["l"] + b["c"]) / 3
        pv += tp * b["v"]
        vv += b["v"]
    return pv / vv if vv else sum((b["h"] + b["l"] + b["c"]) / 3 for b in bars) / len(bars)


def vwap_series(bars):
    out, pv, vv = [], 0.0, 0.0
    for b in bars:
        tp = (b["h"] + b["l"] + b["c"]) / 3
        pv += tp * (b["v"] or 0)
        vv += b["v"] or 0
        out.append(pv / vv if vv else tp)
    return out


def rsi(closes, n=14):
    """Wilder RSI of the last close, or None if too few closes."""
    if len(closes) <= n:
        return None
    gain = loss = 0.0
    for a, b in zip(closes[:n], closes[1:n + 1]):
        gain += max(b - a, 0); loss += max(a - b, 0)
    gain, loss = gain / n, loss / n
    for a, b in zip(closes[n:], closes[n + 1:]):
        gain = (gain * (n - 1) + max(b - a, 0)) / n
        loss = (loss * (n - 1) + max(a - b, 0)) / n
    return 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)


def atr(bars, n=14):
    """Wilder ATR of the last bar, or None if too few bars."""
    if len(bars) <= n:
        return None
    tr = [bars[0]["h"] - bars[0]["l"]] + [max(b["h"] - b["l"], abs(b["h"] - p["c"]), abs(b["l"] - p["c"]))
                                          for p, b in zip(bars, bars[1:])]
    a = sum(tr[:n]) / n
    for x in tr[n:]:
        a = (a * (n - 1) + x) / n
    return a
