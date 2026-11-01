"""Open Trade Lab on this PC:  python serve.py   then http://127.0.0.1:8100
Serves site/index.html and out/skills.json (made by: python skilltest.py out). Stdlib only."""
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {"/": ("site/index.html", "text/html; charset=utf-8"),
         "/index.html": ("site/index.html", "text/html; charset=utf-8"),
         "/skills.json": ("out/skills.json", "application/json")}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path, ctype = FILES.get(self.path.split("?")[0], (None, None))
        full = path and os.path.join(HERE, path)
        if not full or not os.path.exists(full):
            return self.send_error(404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8100"))
    print(f"Open http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
