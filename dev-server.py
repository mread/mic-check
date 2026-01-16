#!/usr/bin/env python3
"""
Development server with aggressive cache-busting headers.

Use this instead of `python3 -m http.server` to avoid browser caching
issues during development.
"""

import http.server
import socketserver
import sys

PORT = 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler that prevents all caching."""

    def end_headers(self):
        # Aggressive no-cache headers
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    """TCPServer that allows immediate port reuse after shutdown."""
    allow_reuse_address = True


if __name__ == '__main__':
    try:
        with ReusableTCPServer(("", PORT), NoCacheHandler) as httpd:
            print(f"🎤 mic-check dev server at http://localhost:{PORT}")
            print("   Cache-busting enabled - browsers will always fetch fresh files")
            print("   Press Ctrl+C to stop")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n   Shutting down...")
    except OSError as e:
        if e.errno == 98:  # Address already in use
            print(f"❌ Port {PORT} is already in use.")
            print()
            print("   To see what's using it:")
            print(f"      fuser {PORT}/tcp")
            print()
            print("   To kill it:")
            print(f"      fuser -k {PORT}/tcp")
            sys.exit(1)
        else:
            raise
