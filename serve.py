"""Static dev server for Image Tracer.

Same as `python3 -m http.server`, but sends `Cache-Control: no-cache` so the browser
always revalidates scripts and styles; edits show up on a normal reload.

Usage: python3 serve.py [port]   (default 8000, bound to 127.0.0.1)
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler) as httpd:
        print(f"Image Tracer: http://localhost:{port}")
        httpd.serve_forever()
