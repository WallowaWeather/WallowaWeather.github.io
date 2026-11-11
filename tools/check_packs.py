#!/usr/bin/env python3
"""check_packs.py - every model pack in config.js downloads from a pinned Hugging Face revision (Python 3.8+, standard library only).

    python3 tools/check_packs.py              # check the repository's config.js (exit 0 = all pinned, 1 = not, 2 = usage)
    python3 tools/check_packs.py path/config.js

Each entry of config.js's PACKS table is [address, manifest sha256, (optional) { sub-pack: sha256 }]. The address must be exactly
https://huggingface.co/<owner>/<repo>/resolve/<40-hex commit>/ (a commit, never a branch such as main: a branch can change under the
phones), and the manifest pin must be 64 hex digits (engine/core/pin.js checks every manifest against it). An entry the check cannot
read is a failure too.
"""
import re
import sys
from pathlib import Path

PIN_URL = re.compile(r"^https://huggingface\.co/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/resolve/[0-9a-f]{40}/$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def packs(text):
    """config.js -> [(name, address or None, pin or None, raw entry)]"""
    m = re.search(r"var PACKS = \{(.*?)\n\s*\};", text, re.S)
    if not m:
        return None
    consts = dict(re.findall(r"\bvar (\w+) = '([^']*)';", text))
    body, out = m.group(1), []
    starts = [x for x in re.finditer(r"'([\w./-]+)'\s*:\s*\[", body)]
    for i, s in enumerate(starts):
        raw = body[s.end(): starts[i + 1].start() if i + 1 < len(starts) else len(body)]
        e = re.match(r"\s*(?:(\w+)\s*\+\s*)?'([^']*)'\s*,\s*'([^']*)'", raw)
        if not e:
            out.append((s.group(1), None, None, raw.strip()[:100]))
            continue
        head = e.group(1)
        if head and head not in consts:
            out.append((s.group(1), None, None, raw.strip()[:100]))
            continue
        out.append((s.group(1), (consts[head] if head else "") + e.group(2), e.group(3), raw.strip()[:100]))
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cfg = Path(argv[0]) if argv else Path(__file__).resolve().parent.parent / "config.js"
    if not cfg.is_file():
        print("no such file: %s" % cfg, file=sys.stderr)
        return 2
    found = packs(cfg.read_text(encoding="utf-8"))
    if not found:
        print("%s: the PACKS table was not found (or is empty)" % cfg)
        return 1
    bad = 0
    for name, url, pin, raw in found:
        if url is None:
            print("NOT READ  %s: %s" % (name, raw))
            bad += 1
        elif not PIN_URL.match(url):
            print("NOT PINNED  %s: %s  (want https://huggingface.co/<owner>/<repo>/resolve/<40-hex commit>/)" % (name, url))
            bad += 1
        elif not SHA256.match(pin or ""):
            print("NO PIN  %s: the manifest sha256 is %r" % (name, pin))
            bad += 1
        else:
            print("ok  %s: %s" % (name, url))
    if bad:
        print("%d pack(s) not on a pinned Hugging Face revision: the release stops." % bad)
        return 1
    print("every pack (%d) is on a pinned Hugging Face revision" % len(found))
    return 0


if __name__ == "__main__":
    sys.exit(main())
