#!/usr/bin/env python3
"""serve.py - a tiny static server for Wallowa Weather (Python 3.8+, standard library only).

Serves the app's files on this computer:

    python3 tools/serve.py                         # http://127.0.0.1:8080/ , the repository root, as GitHub Pages serves it
    python3 tools/serve.py --base /sub/path/         # http://127.0.0.1:8080/sub/path/ , to try it under a sub-path

Why a server at all: WebGPU, service workers and the browser's private file storage (OPFS) only work in a secure context,
i.e. https:// or http://127.0.0.1 / localhost. To try it on a phone, put an HTTPS front in front of this server (for example
a reverse proxy with a certificate for a name you own).

What it does:
- binds to 127.0.0.1 by default, so only this computer (and an HTTPS front on it) can reach it;
- sends the right types for the app's files (.js/.mjs, .wasm, .json, .webmanifest, .wgsl, model shards);
- `Cache-Control: no-cache` on index.html and every file without a content hash in its name (the browser re-checks
  them, so an update is never half old, half new); long-lived caching only for hashed files (name.0123abcd.js);
- supports byte ranges (the model downloads resume with them);
- --base serves the site under a sub-path, the way GitHub Pages serves a project site (anything outside it is a 404);
- never lists folders and never serves dotfiles (.git, .env, ...).
"""
import argparse
import datetime
import email.utils
import http.server
import ipaddress
import os
import posixpath
import re
import sys
import urllib.parse
from functools import partial
from pathlib import Path

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".wasm": "application/wasm",
    ".wgsl": "text/wgsl; charset=utf-8",
    ".md": "text/plain; charset=utf-8",      # plain text, so Safari shows the licence files instead of downloading them
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".gz": "application/gzip",               # never Content-Encoding: the app inflates .gz files itself
    ".pfw": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".safetensors": "application/octet-stream",
    ".onnx": "application/octet-stream",
    ".tflite": "application/octet-stream",
    ".task": "application/octet-stream",
}
HASHED = re.compile(r"[.-][0-9a-f]{8,}\.[A-Za-z0-9]+$")   # app.3f9c2a1b.js, shard-0a1b2c3d4e.pfw
RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "wallowa-serve"
    sys_version = ""
    protocol_version = "HTTP/1.1"             # keep-alive: the app is ~100 small ES modules
    quiet = False
    base = "/"                                # --base: the sub-path the site lives under

    # -- paths ---------------------------------------------------------------------------------------------------------
    def translate_path(self, path):
        if self.base != "/" and path.startswith(self.base):
            path = "/" + path[len(self.base):]
        return super().translate_path(path)

    def _outside_base(self):
        """None when the request is inside --base; else True after answering it (a 301 to the base, or a 404)"""
        if self.base == "/":
            return None
        p = urllib.parse.urlsplit(self.path).path
        if p == self.base.rstrip("/"):
            self.send_response(301)
            self.send_header("Location", self.base)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        if not p.startswith(self.base):
            self.send_error(404, "Not found (the site is under %s)" % self.base)
            return True
        return None

    def _blocked(self):
        """dotfiles / dot-folders anywhere in the path (.git, .env, .ssh ...) are never served"""
        parts = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)).split("/")
        return any(p.startswith(".") and p not in (".", "") for p in parts)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return TYPES.get(ext) or super().guess_type(path) or "application/octet-stream"

    def list_directory(self, path):          # no folder listings
        self.send_error(404, "Not found")
        return None

    # -- headers -------------------------------------------------------------------------------------------------------
    def _cache_control(self, fs_path):
        name = os.path.basename(fs_path)
        if name == "index.html" or not HASHED.search(name):
            return "no-cache"                 # revalidate every time (Last-Modified / If-Modified-Since)
        return "public, max-age=31536000, immutable"

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    # -- GET / HEAD with Cache-Control and single byte ranges -----------------------------------------------------------
    def send_head(self):
        if self._outside_base():
            return None
        if self._blocked():
            self.send_error(404, "Not found")
            return None
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            if not self.path.split("?", 1)[0].endswith("/"):
                return super().send_head()    # the standard 301 to the trailing-slash URL
            path = os.path.join(path, "index.html")
            if not os.path.isfile(path):
                self.send_error(404, "Not found")
                return None
        if not os.path.isfile(path):
            self.send_error(404, "Not found")
            return None
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "Not found")
            return None
        try:
            st = os.fstat(f.fileno())
            size, mtime = st.st_size, st.st_mtime
            ims = self.headers.get("If-Modified-Since")
            if ims and not self.headers.get("If-None-Match") and not self.headers.get("Range"):
                try:
                    when = email.utils.parsedate_to_datetime(ims)
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=datetime.timezone.utc)
                    if int(mtime) <= when.timestamp():
                        self.send_response(304)
                        self.send_header("Cache-Control", self._cache_control(path))
                        self.end_headers()
                        f.close()
                        return None
                except (TypeError, ValueError, IndexError, OverflowError):
                    pass
            start, end = 0, size - 1
            rng = self.headers.get("Range")
            m = RANGE.match(rng.strip()) if rng else None
            if rng and m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                else:                                   # bytes=-N: the last N bytes
                    start = max(0, size - int(m.group(2)))
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    f.close()
                    return None
                self.send_response(206)
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            else:
                self.send_response(200)
            length = end - start + 1
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(int(mtime)))
            self.send_header("Cache-Control", self._cache_control(path))
            self.end_headers()
            f.seek(start)
            self._remaining = length
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        left = getattr(self, "_remaining", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(1 << 20, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def default_root():
    here = Path(__file__).resolve().parent
    for cand in (here, here.parent, Path.cwd()):
        if (cand / "index.html").is_file():
            return cand
    return Path.cwd()


def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description="Serve Wallowa Weather on this computer (put an HTTPS front in front for a phone).")
    ap.add_argument("--root", type=Path, default=None, help="folder that holds index.html (default: the repository root)")
    ap.add_argument("--host", default="127.0.0.1", help="address to bind (default 127.0.0.1; anything else shows a warning)")
    ap.add_argument("--port", type=int, default=8080, help="port (default 8080)")
    ap.add_argument("--base", default="/", help="serve the site under this sub-path, e.g. /wallowa-weather/ (default /)")
    ap.add_argument("--quiet", action="store_true", help="do not log each request")
    a = ap.parse_args(argv)

    root = (a.root or default_root()).resolve()
    if not root.is_dir():
        ap.error("--root %s is not a folder" % root)
    if not (root / "index.html").is_file():
        print("warning: %s has no index.html" % root, file=sys.stderr)
    base = "/" + a.base.strip("/") + "/" if a.base.strip("/") else "/"
    if not is_loopback(a.host):
        print("\nWARNING: binding to %s lets OTHER devices on this network reach this server.\n"
              "  Phones need HTTPS anyway: keep the default (127.0.0.1) and put an HTTPS front in front of it.\n" % a.host,
              file=sys.stderr)

    Handler.quiet = a.quiet
    Handler.base = base
    srv = http.server.ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=str(root)))
    srv.daemon_threads = True
    shown = "[%s]" % a.host if ":" in a.host else a.host
    print("Wallowa Weather: serving %s at http://%s:%d%s  (Ctrl+C to stop)" % (root, shown, a.port, base))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
