#!/usr/bin/env python3
"""Small dependency-free production server for the PixelTrace static app."""

from __future__ import annotations

import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class PixelTraceHandler(SimpleHTTPRequestHandler):
    server_version = "PixelTrace/1.2"
    public_paths = {
        "/",
        "/index.html",
        "/styles.css",
        "/app.js",
        "/matcher-core.js",
        "/favicon.svg",
    }

    def __init__(self, *args: object, directory: str, **kwargs: object) -> None:
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - inherited HTTP API
        path = urlsplit(self.path).path
        if path == "/healthz":
            body = b"pixeltrace ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path not in self.public_paths:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - inherited HTTP API
        path = urlsplit(self.path).path
        if path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path not in self.public_paths:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self) -> None:
        path = urlsplit(self.path).path
        if path.endswith((".js", ".css", ".svg", ".png", ".webp", ".jpg", ".jpeg")):
            self.send_header("Cache-Control", "public, max-age=3600")
        elif path != "/healthz":
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def list_directory(self, path: str):  # type: ignore[no-untyped-def]
        self.send_error(404)
        return None


class PixelTraceServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve PixelTrace on a private loopback origin")
    parser.add_argument("--host", default=os.environ.get("PIXELTRACE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIXELTRACE_PORT", "18103")))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    if not (root / "index.html").is_file():
        raise SystemExit(f"index.html was not found in {root}")
    handler = lambda *handler_args, **handler_kwargs: PixelTraceHandler(  # noqa: E731
        *handler_args, directory=str(root), **handler_kwargs
    )
    with PixelTraceServer((args.host, args.port), handler) as server:
        print(f"PixelTrace serving {root} at http://{args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
