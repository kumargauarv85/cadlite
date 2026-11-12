#!/usr/bin/env python3
"""CADLite Viewer - DWG/DXF viewer for Linux.

Starts a private local service (127.0.0.1 only) that serves the viewer and runs
DWG conversions through ODA File Converter or LibreDWG, then opens the viewer
in an app window. Needs only the Python 3 standard library.
"""
import argparse
import glob
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler

try:
    from http.server import ThreadingHTTPServer
except ImportError:  # ThreadingHTTPServer was added in Python 3.7.
    from http.server import HTTPServer
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        # Match the standard-library implementation so worker threads do not
        # keep the process alive after the viewer server shuts down.
        daemon_threads = True

VERSION = "1.3.0"
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "cadlite")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
DATA_DIR = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "cadlite")
ENGINE_DIR = os.path.join(DATA_DIR, "engine")
ODA_SITE = os.environ.get("CADLITE_ODA_SITE") or "https://www.opendesign.com"
ODA_PAGES = ("/guestfiles/oda_file_converter", "/guestfiles/oda_file_converter.md")
ODA_FALLBACK = "/guestfiles/get?filename=ODAFileConverter_QT6_lnxX64_11dll.AppImage"
MAX_UPLOAD = 1024 * 1024 * 1024
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}
ODA_VERSIONS = ["ACAD9", "ACAD10", "ACAD12", "ACAD13", "ACAD14", "ACAD2000", "ACAD2004",
                "ACAD2007", "ACAD2010", "ACAD2013", "ACAD2018"]
LIBRE_VER = {"ACAD12": "r12", "ACAD14": "r14", "ACAD2000": "r2000", "ACAD2004": "r2004",
             "ACAD2007": "r2007", "ACAD2010": "r2010", "ACAD2013": "r2013"}


class ConvertError(Exception):
    pass


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)


def find_oda():
    """Locate the ODA File Converter executable (package install or AppImage)."""
    candidates = [os.environ.get("CADLITE_ODA"), load_config().get("oda_path")]
    candidates.append(os.path.join(ENGINE_DIR, "squashfs-root", "AppRun"))
    candidates.extend(sorted(glob.glob(os.path.join(ENGINE_DIR, "ODAFileConverter*.AppImage")), reverse=True))
    candidates.append(shutil.which("ODAFileConverter"))
    home = os.path.expanduser("~")
    for folder in (home, "Applications", "Apps", "apps", "AppImages", ".local/bin", "bin", "Downloads", "Desktop"):
        base = home if folder == home else os.path.join(home, folder)
        candidates.extend(sorted(glob.glob(os.path.join(base, "ODAFileConverter*.AppImage")), reverse=True))
    candidates.extend(sorted(glob.glob("/opt/ODAFileConverter*.AppImage") + glob.glob("/opt/*/ODAFileConverter*.AppImage"), reverse=True))
    candidates.extend(glob.glob("/usr/bin/ODAFileConverter*"))
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def find_tools():
    return {"oda": find_oda(), "dwg2dxf": shutil.which("dwg2dxf"), "dxf2dwg": shutil.which("dxf2dwg")}


class Engine:
    """One-time download of the ODA File Converter AppImage into CADLite's own folder."""
    lock = threading.Lock()
    status = {"state": "idle", "pct": 0, "msg": ""}

    @classmethod
    def start(cls):
        with cls.lock:
            if cls.status["state"] == "running":
                return
            cls.status = {"state": "running", "pct": 0, "msg": "Contacting opendesign.com"}
        threading.Thread(target=cls._work, daemon=True).start()

    @staticmethod
    def _open(url):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) CADLite/" + VERSION})
        return urllib.request.urlopen(req, timeout=60)

    @classmethod
    def _work(cls):
        try:
            if os.uname().machine not in ("x86_64", "amd64"):
                raise ConvertError("The converter engine is only published for 64-bit Intel/AMD PCs.")
            link = None
            for page in ODA_PAGES:
                try:
                    with cls._open(ODA_SITE + page) as r:
                        html = r.read(2000000).decode("utf-8", "replace")
                    m = re.search(r"/guestfiles/get\?filename=ODAFileConverter[A-Za-z0-9_.-]*?\.AppImage", html)
                    if m:
                        link = m.group(0)
                        break
                except OSError:
                    continue
            link = link or ODA_FALLBACK
            fname = re.sub(r"[^A-Za-z0-9_.-]", "_", link.split("filename=")[-1])
            os.makedirs(ENGINE_DIR, exist_ok=True)
            part = os.path.join(ENGINE_DIR, fname + ".part")
            cls.status.update(msg="Downloading converter engine")
            with cls._open(ODA_SITE + link) as r, open(part, "wb") as out:
                total = int(r.headers.get("Content-Length") or 0)
                head = r.read(4)
                if head != b"\x7fELF":
                    raise ConvertError("opendesign.com did not return the converter program. Download the AppImage "
                                       "by hand from opendesign.com/guestfiles/oda_file_converter and put it in " + ENGINE_DIR)
                out.write(head)
                done = 4
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        cls.status["pct"] = int(done * 100 / total)
                    cls.status["msg"] = "Downloading converter engine (%d MB)" % (done // 1048576)
            if total and done < total:
                raise ConvertError("The download was cut off. Check your connection and try again.")
            for old in glob.glob(os.path.join(ENGINE_DIR, "ODAFileConverter*.AppImage")):
                os.remove(old)
            final = os.path.join(ENGINE_DIR, fname)
            os.replace(part, final)
            os.chmod(final, 0o755)
            # Unpack once so it runs without FUSE (immutable distros such as Bazzite/Silverblue).
            cls.status.update(pct=100, msg="Unpacking")
            shutil.rmtree(os.path.join(ENGINE_DIR, "squashfs-root"), ignore_errors=True)
            try:
                subprocess.run([final, "--appimage-extract"], cwd=ENGINE_DIR, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=600)
            except (OSError, subprocess.TimeoutExpired):
                pass
            if os.access(os.path.join(ENGINE_DIR, "squashfs-root", "AppRun"), os.X_OK):
                os.remove(final)
            cls.status = {"state": "done", "pct": 100, "msg": "DWG support is ready"}
        except Exception as exc:
            msg = str(exc) if isinstance(exc, ConvertError) else "Download failed (%s). Check your internet connection." % exc
            cls.status = {"state": "error", "pct": 0, "msg": msg}
            for junk in glob.glob(os.path.join(ENGINE_DIR, "*.part")):
                try:
                    os.remove(junk)
                except OSError:
                    pass


def is_dwg(data):
    return len(data) > 6 and data[:2] == b"AC" and data[2:3] in (b"1", b"2") and data[3:4] in (b"0", b".")


def _run(cmd, timeout=600, env=None):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise ConvertError("The converter took too long and was stopped.")
    except OSError as exc:
        raise ConvertError("Could not start the converter: %s" % exc)


def convert(data, name, fmt, ver):
    """Convert DWG/DXF bytes to fmt ('DWG', 'DXF' or 'DXB') in version ver ('ACAD2018' ...)."""
    fmt = fmt.upper()
    if fmt not in ("DWG", "DXF", "DXB"):
        raise ConvertError("Unknown target format %r." % fmt)
    if ver not in ODA_VERSIONS:
        raise ConvertError("Unknown target version %r." % ver)
    src_dwg = is_dwg(data)
    tools = find_tools()
    with tempfile.TemporaryDirectory(prefix="cadlite-") as tmp:
        ind, outd = os.path.join(tmp, "in"), os.path.join(tmp, "out")
        os.mkdir(ind)
        os.mkdir(outd)
        src_name = "drawing.dwg" if src_dwg else "drawing.dxf"
        src = os.path.join(ind, src_name)
        with open(src, "wb") as fh:
            fh.write(data)
        out_ext = ".dwg" if fmt == "DWG" else ".dxf"
        out = os.path.join(outd, "drawing" + out_ext)
        log = b""
        if tools["oda"]:
            cmd = [tools["oda"], ind, outd, ver, fmt, "0", "1", src_name]
            xvfb = shutil.which("xvfb-run")
            has_display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
            # Try silently first (no window), then with the converter's own window.
            attempts = [([xvfb, "-a"] + cmd, None)] if xvfb else [(cmd, {"QT_QPA_PLATFORM": "offscreen"})]
            if has_display:
                attempts.append((cmd, None))
                attempts.append((cmd, {"APPIMAGE_EXTRACT_AND_RUN": "1"}))
            for acmd, extra in attempts:
                log = _run(acmd, env=dict(os.environ, **extra) if extra else None).stdout
                if any(f.lower().endswith(out_ext) and os.path.getsize(os.path.join(outd, f)) for f in os.listdir(outd)):
                    break
        elif src_dwg and fmt in ("DXF", "DXB") and tools["dwg2dxf"]:
            if ver not in LIBRE_VER:
                raise ConvertError("LibreDWG cannot write that DXF version. Install ODA File Converter for all versions.")
            cmd = [tools["dwg2dxf"], "-y", "--as", LIBRE_VER[ver]] + (["-b"] if fmt == "DXB" else []) + ["-o", out, src]
            log = _run(cmd).stdout
        elif not src_dwg and fmt == "DWG" and tools["dxf2dwg"]:
            if ver != "ACAD2000":
                raise ConvertError("LibreDWG can only write DWG in the AutoCAD 2000 version. "
                                   "Pick 'AutoCAD 2000' or install ODA File Converter.")
            log = _run([tools["dxf2dwg"], "-y", "--as", "r2000", "-o", out, src]).stdout
        elif tools["dwg2dxf"] or tools["dxf2dwg"]:
            raise ConvertError("LibreDWG cannot do this conversion (it handles DWG to DXF, and DXF to DWG 2000). "
                               "Install ODA File Converter for full support.")
        else:
            raise ConvertError("DWG support is not set up yet. In CADLite click Convert / Export, "
                               "then 'Set up DWG support' (one-time download).")
        if not os.path.isfile(out):
            found = [f for f in os.listdir(outd) if f.lower().endswith(out_ext)]
            if found:
                out = os.path.join(outd, found[0])
        if not os.path.isfile(out) or os.path.getsize(out) == 0:
            detail = ""
            for f in os.listdir(outd):
                if f.lower().endswith(".err"):
                    try:
                        with open(os.path.join(outd, f), "r", errors="replace") as fh:
                            detail = fh.read(600)
                    except OSError:
                        pass
            if not detail:
                detail = log.decode("utf-8", "replace")[-600:]
            raise ConvertError(("The converter could not process %s. " % name) + detail.strip())
        with open(out, "rb") as fh:
            return fh.read()


def dwg_to_dxf(data, name):
    tools = find_tools()
    if tools["oda"]:
        return convert(data, name, "DXF", "ACAD2018")
    return convert(data, name, "DXF", "ACAD2013")


class State:
    token = ""
    initial = None
    last_ping = 0.0
    ever_pinged = False
    started = 0.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CADLite/" + VERSION

    def log_message(self, fmt, *args):
        if os.environ.get("CADLITE_DEBUG"):
            sys.stderr.write("cadlite: " + (fmt % args) + "\n")

    def _send(self, code, body, ctype="application/octet-stream", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def _route(self):
        """Validate host + token; return (path_after_token, query) or None."""
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self._json({"error": "forbidden"}, 403)
            return None
        parsed = urllib.parse.urlsplit(self.path)
        parts = parsed.path.split("/", 2)
        if len(parts) < 3 or not secrets.compare_digest(parts[1], State.token):
            self._json({"error": "forbidden"}, 403)
            return None
        return parts[2], urllib.parse.parse_qs(parsed.query)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length < 0 or length > MAX_UPLOAD:
            raise ConvertError("File is too large.")
        return self.rfile.read(length)

    def do_GET(self):
        r = self._route()
        if r is None:
            return
        path, _query = r
        State.last_ping = time.time()
        if path == "api/engine":
            self._json(Engine.status)
            return
        if path == "api/info":
            self._json({"version": VERSION, "tools": find_tools(), "config": load_config(), "engine": Engine.status,
                        "initial": os.path.basename(State.initial) if State.initial else None})
            return
        if path == "api/initial":
            try:
                with open(State.initial, "rb") as fh:
                    self._send(200, fh.read())
            except (OSError, TypeError) as exc:
                self._json({"error": "Cannot read the file: %s" % exc}, 404)
            return
        if path == "":
            path = "index.html"
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", path) or path.startswith("."):
            self._json({"error": "not found"}, 404)
            return
        full = os.path.join(WEB, path)
        if not os.path.isfile(full):
            self._json({"error": "not found"}, 404)
            return
        with open(full, "rb") as fh:
            self._send(200, fh.read(), MIME.get(os.path.splitext(path)[1], "application/octet-stream"))

    do_HEAD = do_GET

    def do_POST(self):
        r = self._route()
        if r is None:
            return
        path, query = r
        State.last_ping = time.time()
        State.ever_pinged = True
        try:
            body = self._body()
            name = (query.get("name") or ["drawing"])[0]
            if path == "api/ping":
                self._json({"ok": True})
            elif path == "api/engine":
                Engine.start()
                self._json(Engine.status)
            elif path == "api/todxf":
                self._send(200, dwg_to_dxf(body, name))
            elif path == "api/convert":
                fmt = (query.get("fmt") or ["DXF"])[0]
                ver = (query.get("ver") or ["ACAD2018"])[0]
                self._send(200, convert(body, name, fmt, ver))
            elif path == "api/config":
                data = json.loads(body.decode("utf-8") or "{}")
                p = os.path.expanduser(str(data.get("oda_path") or "").strip())
                cfg = load_config()
                if not p:
                    cfg.pop("oda_path", None)
                elif not os.path.isfile(p):
                    raise ConvertError("There is no file at %s" % p)
                else:
                    if not os.access(p, os.X_OK):
                        try:
                            os.chmod(p, os.stat(p).st_mode | 0o111)
                        except OSError:
                            raise ConvertError("%s is not executable. Run: chmod +x '%s'" % (p, p))
                    cfg["oda_path"] = p
                save_config(cfg)
                self._json({"ok": True})
            else:
                self._json({"error": "not found"}, 404)
        except ConvertError as exc:
            self._json({"error": str(exc)}, 422)
        except Exception as exc:  # keep the service alive whatever a request does
            self._json({"error": "Unexpected error: %s" % exc}, 500)


def open_window(url, mode):
    """Open the viewer. Prefer a Chromium-family app window, then Firefox, then the default browser."""
    if mode == "none":
        return
    if mode != "browser":
        for exe in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser",
                    "microsoft-edge", "microsoft-edge-stable", "vivaldi", "vivaldi-stable"):
            path = shutil.which(exe)
            if path:
                try:
                    subprocess.Popen([path, "--app=" + url, "--new-window", "--class=cadlite", "--window-size=1440,900"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                    return
                except OSError:
                    pass
        flatpak = shutil.which("flatpak")
        if flatpak:
            roots = ("/var/lib/flatpak/app", os.path.expanduser("~/.local/share/flatpak/app"))
            for app in ("com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.Edge",
                        "com.vivaldi.Vivaldi", "io.github.ungoogled_software.ungoogled_chromium", "com.google.ChromeDev"):
                if any(os.path.isdir(os.path.join(r, app)) for r in roots):
                    try:
                        subprocess.Popen([flatpak, "run", app, "--app=" + url, "--new-window", "--window-size=1440,900"],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                        return
                    except OSError:
                        pass
        path = shutil.which("firefox")
        if path:
            try:
                subprocess.Popen([path, "--new-window", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
                return
            except OSError:
                pass
    if not webbrowser.open(url):
        print("Open this address in your browser:\n  " + url)


def watchdog(server, idle):
    """Stop the service once the viewer window has gone away."""
    while True:
        time.sleep(5)
        now = time.time()
        limit = idle if State.ever_pinged else max(idle, 600)
        if now - State.last_ping > limit:
            threading.Thread(target=server.shutdown, daemon=True).start()
            return


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cadlite", description="CADLite Viewer - view, measure and convert DWG/DXF drawings.")
    ap.add_argument("file", nargs="?", help="DWG or DXF file to open")
    ap.add_argument("--browser", action="store_true", help="open in the default browser instead of an app window")
    ap.add_argument("--no-window", action="store_true", help="only start the service and print its address")
    ap.add_argument("--port", type=int, default=0, help="port to listen on (default: a free one)")
    ap.add_argument("--convert", nargs=3, metavar=("OUT", "FORMAT", "VERSION"),
                    help="convert FILE without opening a window, e.g. --convert out.dwg DWG ACAD2013")
    ap.add_argument("--setup-dwg", action="store_true", help="download the DWG converter engine and exit")
    ap.add_argument("--version", action="version", version="CADLite Viewer " + VERSION)
    args = ap.parse_args(argv)

    if args.setup_dwg:
        Engine.start()
        while Engine.status["state"] == "running":
            print("\r%-60s" % ("%s %d%%" % (Engine.status["msg"], Engine.status["pct"])), end="", flush=True)
            time.sleep(0.5)
        print("\r%-60s" % Engine.status["msg"])
        return 0 if Engine.status["state"] == "done" else 1
    if args.file and not os.path.isfile(args.file):
        ap.error("no such file: %s" % args.file)
    if args.convert:
        if not args.file:
            ap.error("--convert needs an input file")
        out, fmt, ver = args.convert
        try:
            with open(args.file, "rb") as fh:
                result = convert(fh.read(), os.path.basename(args.file), fmt, ver.upper())
        except ConvertError as exc:
            sys.exit("cadlite: " + str(exc))
        with open(out, "wb") as fh:
            fh.write(result)
        print("Wrote " + out)
        return 0

    State.token = secrets.token_urlsafe(18)
    State.initial = os.path.abspath(args.file) if args.file else None
    State.started = State.last_ping = time.time()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = "http://127.0.0.1:%d/%s/" % (server.server_address[1], State.token)
    if args.no_window:
        print(url, flush=True)
    open_window(url, "none" if args.no_window else "browser" if args.browser else "app")
    threading.Thread(target=watchdog, args=(server, 150), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
