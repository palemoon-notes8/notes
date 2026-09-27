"""One gentle connection to KPPP for every collector, so KPPP never blocks us.

KPPP answers "503 service unavailable" when it gets too many requests too quickly, and then keeps
refusing for a while. Every collector uses make_session() from here, which:

- sends at most one request every KPPP_MIN_INTERVAL seconds (shared by all threads of the collector);
- when KPPP says it is busy (429/502/503/504) or does not answer, pauses *all* requests for 30 s,
  doubling up to 5 minutes while it keeps refusing, before trying the same request again;
- never fires quick automatic retries, which is what makes a short block turn into a long one;
- gives up for the rest of the run after KPPP_GIVE_UP busy answers in a row: every later request fails
  at once without contacting KPPP, and the next scheduled run tries again (a struggling KPPP is left alone).
"""

import os
import threading
import time

import requests
from requests.adapters import HTTPAdapter

MIN_INTERVAL = float(os.getenv("KPPP_MIN_INTERVAL", "1.5"))
ATTEMPTS = int(os.getenv("KPPP_ATTEMPTS", "6"))
BUSY = {429, 502, 503, 504}
GIVE_UP = int(os.getenv("KPPP_GIVE_UP", "3"))


class KpppUnavailable(requests.exceptions.ConnectionError):
    """KPPP kept refusing; this run stops asking."""


_lock = threading.Lock()
_next_at = 0.0       # earliest time the next request may go out
_paused_until = 0.0  # set when KPPP says it is busy
_pause = 0.0         # current pause length; doubles while KPPP keeps refusing
_busy_in_a_row = 0   # busy answers since the last good one
_gave_up = False     # set after GIVE_UP busy answers in a row


def _wait_turn():
    global _next_at
    while True:
        with _lock:
            now = time.monotonic()
            start = max(_next_at, _paused_until)
            if now >= start:
                _next_at = now + MIN_INTERVAL
                return
            delay = start - now
        time.sleep(min(delay, 5))


def _busy(reason):
    global _paused_until, _pause, _busy_in_a_row, _gave_up
    with _lock:
        _busy_in_a_row += 1
        if _busy_in_a_row >= GIVE_UP:
            if not _gave_up:
                print(f"KPPP refused {_busy_in_a_row} times in a row ({reason}); leaving it alone until the next run", flush=True)
            _gave_up = True
            return
        _pause = min(300.0, _pause * 2 if _pause else 30.0)
        until = time.monotonic() + _pause
        if until > _paused_until:
            _paused_until = until
            print(f"KPPP is busy ({reason}); pausing all requests for {int(_pause)}s", flush=True)


def _fine():
    global _pause, _busy_in_a_row
    with _lock:
        _busy_in_a_row = 0
        _pause = _pause / 2 if _pause > 30 else 0.0


class PoliteAdapter(HTTPAdapter):
    def send(self, request, **kwargs):
        for attempt in range(1, ATTEMPTS + 1):
            if _gave_up:
                raise KpppUnavailable("KPPP is not answering; not asking again in this run", request=request)
            _wait_turn()
            try:
                response = super().send(request, **kwargs)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
                _busy(exc.__class__.__name__)
                if attempt == ATTEMPTS:
                    raise
                continue
            if response.status_code in BUSY and attempt < ATTEMPTS:
                _busy(f"HTTP {response.status_code}")
                try:
                    response.close()
                except Exception:
                    pass
                continue
            if response.status_code not in BUSY:
                _fine()
            return response


def make_session(pool=10):
    session = requests.Session()
    adapter = PoliteAdapter(max_retries=0, pool_connections=pool, pool_maxsize=pool)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session
