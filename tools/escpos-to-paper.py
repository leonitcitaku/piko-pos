#!/usr/bin/env python3
"""ESC/POS to paper bridge.

Sits OUTSIDE the POS and changes nothing in it. It pretends to be a thermal
printer on port 9100, understands the ESC/POS the POS sends, renders it as a
receipt shaped column of PostScript and hands that to an ordinary CUPS queue.
For seeing real tickets on real paper when there is no thermal printer.

    python3 escpos-to-paper.py
    PRINTER=Canon_G1411 PORT=9100 python3 escpos-to-paper.py
    DRY=1 python3 escpos-to-paper.py        write .ps files, print nothing

No dependencies beyond python3 and the lp command.
"""
import os, socket, socketserver, subprocess, tempfile, threading, time

PORT    = int(os.environ.get("PORT", "9100"))
PRINTER = os.environ.get("PRINTER", "")
DRY     = os.environ.get("DRY") == "1"
OUTDIR  = os.environ.get("OUTDIR", os.path.join(tempfile.gettempdir(), "escpos-tickets"))

ESC, GS = 0x1b, 0x1d
COLS    = 32            # the POS lays out for 32 characters of 58 mm paper
PT      = 10.0          # Courier 10pt is 6pt wide, so 32 chars = 192pt of column
CW      = PT * 0.6

_counter = 0
_lock = threading.Lock()


def parse(buf):
    """ESC/POS bytes -> [(text, align, big, bold)]"""
    lines, text = [], ""
    align, big, bold = 0, False, False
    i, n = 0, len(buf)
    while i < n:
        b = buf[i]
        nxt = buf[i + 1] if i + 1 < n else -1
        if b == ESC and nxt == 0x40:                       # init
            i += 2; continue
        if b == ESC and nxt == 0x61:                       # align
            align = buf[i + 2] if i + 2 < n else 0; i += 3; continue
        if b == ESC and nxt == 0x45:                       # bold
            bold = bool(buf[i + 2]) if i + 2 < n else False; i += 3; continue
        if b == ESC and nxt == 0x64:                       # feed n lines
            cnt = buf[i + 2] if i + 2 < n else 0
            lines.extend(("", align, big, bold) for _ in range(cnt)); i += 3; continue
        if b == GS and nxt == 0x21:                        # character size
            big = (buf[i + 2] if i + 2 < n else 0) != 0; i += 3; continue
        if b == GS and nxt == 0x56:                        # cut
            i += 4 if (i + 2 < n and buf[i + 2] in (0x41, 0x42)) else 3; continue
        if b == 0x0a:
            lines.append((text, align, big, bold)); text = ""; i += 1; continue
        if 0x20 <= b <= 0x7e:
            text += chr(b)
        i += 1
    if text:
        lines.append((text, align, big, bold))
    while lines and not lines[-1][0]:                      # drop the feed before the cut
        lines.pop()
    return lines


def ps_escape(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def to_postscript(lines):
    left, top = 70.0, 780.0
    col_w = COLS * CW
    out = ["%!PS-Adobe-3.0", "%%Pages: 1", "%%Page: 1 1",
           "/N  { /Courier findfont 10 scalefont setfont } def",
           "/NB { /Courier-Bold findfont 10 scalefont setfont } def",
           "/B  { /Courier-Bold findfont 20 scalefont setfont } def",
           "0 setgray"]
    y = top
    for text, align, big, bold in lines:
        size = 20.0 if big else 10.0
        lead = 24.0 if big else 13.0
        if y < 60:
            out.append("showpage"); y = top
        out.append("B" if big else ("NB" if bold else "N"))
        w = len(text) * size * 0.6
        x = left + (col_w - w) / 2 if align == 1 else (left + col_w - w if align == 2 else left)
        out.append("%.1f %.1f moveto (%s) show" % (x, y, ps_escape(text)))
        y -= lead
    # a dashed line where a thermal printer would cut the paper
    out.append("0.5 setlinewidth [4 3] 0 setdash 0.6 setgray")
    out.append("%.1f %.1f moveto %.1f %.1f lineto stroke" % (left, y - 10, left + col_w, y - 10))
    out += ["showpage", "%%EOF"]
    return ("\n".join(out) + "\n").encode("ascii", "replace")


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        global _counter
        with _lock:
            _counter += 1
            tid = _counter
        say = lambda m: print("[%s] ticket#%04d %s" % (time.strftime("%H:%M:%S"), tid, m), flush=True)
        sock = self.request
        sock.settimeout(20)
        buf = bytearray()
        try:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
                # Answer the paper sensor question the POS asks on connect. 0x12 means paper is fine.
                while len(buf) >= 3 and buf[0] == 0x10 and buf[1] == 0x04:
                    del buf[:3]
                    sock.sendall(bytes([0x12]))
                    say("status asked, answered paper fine")
        except (socket.timeout, OSError):
            pass

        if not buf:
            say("nothing sent"); return

        lines = parse(bytes(buf))
        os.makedirs(OUTDIR, exist_ok=True)
        path = os.path.join(OUTDIR, "ticket-%04d.ps" % tid)
        with open(path, "wb") as fh:
            fh.write(to_postscript(lines))
        say("%d bytes, %d lines -> %s" % (len(buf), len(lines), path))
        for text, _a, big, bold in lines:
            print(("  [big] " if big else (" [bold] " if bold else "        ")) + text, flush=True)

        if DRY:
            return
        cmd = ["lp"] + (["-d", PRINTER] if PRINTER else []) + [path]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            # Fail the connection so the POS keeps the ticket and retries, exactly as with a real printer.
            say("lp FAILED: " + (r.stderr or "").strip())
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
                sock.close()
            except OSError:
                pass
            return
        say("sent to the printer: " + (r.stdout or "").strip())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print("ESC/POS bridge on :%d -> %s" % (PORT, "DRY RUN, no printing" if DRY
          else "lp " + ("-d " + PRINTER if PRINTER else "(default queue)")), flush=True)
    print("PostScript kept in %s" % OUTDIR, flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
