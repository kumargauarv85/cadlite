"""Regression tests for the advertised Python 3.6 compatibility."""
import os
import subprocess
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Python36CompatibilityTests(unittest.TestCase):
    def test_server_imports_without_threading_http_server(self):
        # Simulate Python 3.6, where http.server does not expose
        # ThreadingHTTPServer, while running the test on the current Python.
        script = """
import http.server
import socketserver
import sys

sys.path.insert(0, sys.argv[1])
if hasattr(http.server, "ThreadingHTTPServer"):
    del http.server.ThreadingHTTPServer

import cadlite

server = cadlite.ThreadingHTTPServer
assert issubclass(server, http.server.HTTPServer)
assert issubclass(server, socketserver.ThreadingMixIn)
assert server.daemon_threads is True
"""
        result = subprocess.run(
            [sys.executable, "-c", script, ROOT],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg="Compatibility import failed:\n{}{}".format(result.stdout, result.stderr),
        )


if __name__ == "__main__":
    unittest.main()
