#!/usr/bin/env python3
"""check_sw.py - the offline store's list in sw.js matches the files that ship (Python 3.8+, standard library only).

    python3 tools/check_sw.py            # check the repository (exit 0 = matches, 1 = it does not, 2 = usage)
    python3 tools/check_sw.py some/dir   # check a copy of the site
    python3 tools/check_sw.py --write    # refill sw.js's BUILD and FILES lines (then commit sw.js)

sw.js keeps the app's own files on the phone so the app opens with no signal. Two lines in it say which:
  const FILES = [...]   every file git tracks, sorted, except sw.js itself, Markdown notes, and the files that are not part of
                        the site (.github/, tools/, docs/ (the README's screenshots), .gitignore, .nojekyll, .scan-secrets-allow,
                        .gitattributes);
  const BUILD = '...'   the first 12 hex digits of sha256 over each of those files in that order: its name, a zero byte, its bytes.
A new BUILD makes every phone fetch the new files; a FILES list that misses a file breaks the app offline, and one that names a file
that is not there makes the whole offline store fail to install. So the release stops when either line is out of date.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

NOT_SITE_DIRS = (".git/", ".github/", "tools/", "docs/")   # docs/: the README's screenshots (repository docs, not the site)
NOT_SITE_FILES = {"sw.js", ".gitignore", ".nojekyll", ".scan-secrets-allow", ".gitattributes"}
BUILD_RE = re.compile(r"^const BUILD = '([^']*)';.*$", re.M)
FILES_RE = re.compile(r"^const FILES = (\[.*?\]);.*$", re.M)


def tracked(root):
    """the files git tracks under root (or every file, when root is not a git checkout)"""
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True).stdout
        names = [n.decode("utf-8") for n in out.split(b"\0") if n]
        if names:
            return names
    except (OSError, subprocess.CalledProcessError):
        pass
    names = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for f in filenames:
            names.append((Path(dirpath) / f).relative_to(root).as_posix())
    return names


def site_files(root):
    return sorted(n for n in tracked(root)
                  if n not in NOT_SITE_FILES and not n.endswith(".md") and not n.startswith(NOT_SITE_DIRS))


def build_of(root, files):
    h = hashlib.sha256()
    for n in files:
        h.update(n.encode("utf-8") + b"\0" + (root / n).read_bytes())
    return h.hexdigest()[:12]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check (or refill) sw.js's BUILD and FILES against the files that ship.")
    ap.add_argument("root", nargs="?", type=Path, help="the site's folder (default: the repository root)")
    ap.add_argument("--write", action="store_true", help="refill the two lines instead of checking them")
    a = ap.parse_args(argv)
    root = (a.root or Path(__file__).resolve().parent.parent).resolve()
    sw = root / "sw.js"
    if not sw.is_file():
        print("no sw.js in %s" % root, file=sys.stderr)
        return 2
    files = site_files(root)
    missing_files = [n for n in files if not (root / n).is_file()]
    if missing_files:
        print("tracked but not on disk: %s" % ", ".join(missing_files[:10]))
        return 1
    build = build_of(root, files)
    src = sw.read_bytes().decode("utf-8")
    mb, mf = BUILD_RE.search(src), FILES_RE.search(src)
    if not mb or not mf:
        print("sw.js: the BUILD or FILES line is missing")
        return 1
    if a.write:
        src = BUILD_RE.sub(lambda m: m.group(0).replace("'%s'" % m.group(1), "'%s'" % build, 1), src, count=1)
        src = FILES_RE.sub(lambda m: m.group(0).replace(m.group(1), json.dumps(files, ensure_ascii=False), 1), src, count=1)
        sw.write_bytes(src.encode("utf-8"))
        print("sw.js refilled: BUILD %s, %d files" % (build, len(files)))
        return 0
    try:
        listed = json.loads(mf.group(1))
    except ValueError as e:
        print("sw.js: FILES is not a JSON list: %s" % e)
        return 1
    bad = False
    extra = [n for n in listed if n not in files]
    absent = [n for n in files if n not in listed]
    if extra:
        bad = True
        print("sw.js FILES names %d file(s) that do not ship: %s" % (len(extra), ", ".join(extra[:20])))
    if absent:
        bad = True
        print("sw.js FILES leaves out %d file(s) that ship: %s" % (len(absent), ", ".join(absent[:20])))
    if not extra and not absent and listed != files:
        bad = True
        print("sw.js FILES is not in sorted order")
    if mb.group(1) != build:
        bad = True
        print("sw.js BUILD is %s; the files that ship hash to %s" % (mb.group(1), build))
    if bad:
        print("NOT CURRENT: run  python3 tools/check_sw.py --write  and commit sw.js.")
        return 1
    print("sw.js is current: BUILD %s, %d files" % (build, len(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
