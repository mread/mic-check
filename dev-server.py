#!/usr/bin/env python3
"""
Development server with aggressive cache-busting.

Use this instead of `python3 -m http.server` to avoid browser caching
issues during development.

Cache-busting strategy:
1. No-cache HTTP headers on all responses
2. Dynamic timestamp injection into ES module imports in index.html
   This ensures browsers treat modules as new URLs on every page load.
"""

import argparse
import http.server
import os
import re
import socketserver
import sys
import time

DEFAULT_PORT = 8765


class CacheBustingHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with aggressive cache-busting."""

    def end_headers(self):
        # No-cache headers for all responses
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        # For index.html (or /), inject cache-busting into script tags
        if self.path in ('/', '/index.html'):
            self.serve_cache_busted_html()
        else:
            super().do_GET()

    def serve_cache_busted_html(self):
        """Serve index.html with cache-busting timestamps on module imports."""
        try:
            # Read the original file
            html_path = os.path.join(os.getcwd(), 'index.html')
            with open(html_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Inject cache-busting timestamp into the main module script
            # Matches: src="js/app.js" or src="js/app.js?..."
            # Becomes: src="js/app.js?v=TIMESTAMP"
            timestamp = int(time.time())
            
            # Pattern: src="js/app.js" possibly with existing query string
            content = re.sub(
                r'(<script\s+type="module"\s+src="js/app\.js)(\?[^"]*)?(")',
                rf'\1?v={timestamp}\3',
                content
            )

            # Send response
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', len(content.encode('utf-8')))
            self.end_headers()
            self.wfile.write(content.encode('utf-8'))

        except FileNotFoundError:
            self.send_error(404, 'index.html not found')
        except Exception as e:
            self.send_error(500, str(e))


class ReusableTCPServer(socketserver.TCPServer):
    """TCPServer that allows immediate port reuse after shutdown."""
    allow_reuse_address = True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='mic-check development server')
    parser.add_argument('--port', '-p', type=int, default=DEFAULT_PORT,
                        help=f'Port to serve on (default: {DEFAULT_PORT})')
    args = parser.parse_args()

    port = args.port

    try:
        with ReusableTCPServer(("", port), CacheBustingHandler) as httpd:
            print(f"🎤 mic-check dev server at http://localhost:{port}")
            print("   Cache-busting enabled:")
            print("   • No-cache headers on all responses")
            print("   • Dynamic timestamps on ES module imports")
            print("   Press Ctrl+C to stop")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n   Shutting down...")
    except OSError as e:
        if e.errno == 98:  # Address already in use
            print(f"❌ Port {port} is already in use.")
            print()
            print("   To see what's using it:")
            print(f"      fuser {port}/tcp")
            print()
            print("   To kill it:")
            print(f"      fuser -k {port}/tcp")
            sys.exit(1)
        else:
            raise
