#!/usr/bin/env python3
"""The one-loader guard `scripts/install.sh` asks before it copies anything.

A settings entry installs pi-cache when it is a git pin for this package,
this checkout under any directory name (a worktree or a renamed clone), or
another copy of the package directory. The manual installer refuses outright
when such an entry exists: a second copy of the extension beside the pinned
package aborts every new pi session with tool-conflict errors.

The decision is stated once, here, and the shell installer runs this file,
so a test asks the same code the installer asks. The canonical comparison
takes its resolver as an argument: a case can name two spellings of one
checkout, or one spelling of two checkouts, without creating an alias on
the host - a link fixture is not needed to prove what the rule means.

    python3 scripts/install_guard.py <settings.json> <repo root>
"""

import json
import os
import re
import sys

PACKAGE_NAME = "pi-cache"
# A Git-for-Windows path (`/c/Users/...`) names the same file as its
# `C:/Users/...` spelling, and the shell computes one while a settings file
# may hold either; both sides are compared in the drive spelling.
MSYS = re.compile(r"^/([A-Za-z])($|/.*)")


def normalized(entry):
    """One entry's path in drive form, without a trailing separator."""
    path = entry.replace("\\", "/")
    match = MSYS.match(path)
    if match:
        path = f"{match.group(1).upper()}:{match.group(2) or '/'}"
    return path.rstrip("/") or path


class InstallGuard:
    """Whether a settings entry would install this package again."""

    def __init__(self, settings_path, repo_root, realpath=os.path.realpath,
                 package_name=PACKAGE_NAME):
        self.settings_path = settings_path
        self.package_name = package_name
        self.realpath = realpath
        self.repo_root = self.canonical(repo_root)

    def canonical(self, path):
        """The resolved form of a path, or its given form when unresolvable."""
        given = normalized(path)
        try:
            return os.path.normcase(self.realpath(given))
        except OSError:
            return os.path.normcase(given)

    def packages(self):
        """The settings' package entries, or none when the file is unreadable."""
        try:
            with open(self.settings_path, "r", encoding="utf-8") as handle:
                settings = json.load(handle)
        except (OSError, ValueError):
            return []
        entries = settings.get("packages", []) if isinstance(settings, dict) else []
        return entries if isinstance(entries, list) else []

    def installs(self, entry):
        """Whether this one entry installs the package."""
        if not isinstance(entry, str):
            return False
        path = normalized(entry)
        if path.startswith("git:"):
            return self.package_name in path
        last = path.rsplit("/", 1)[-1]
        if last == self.package_name:
            return True
        return self.repo_root != "" and self.canonical(entry) == self.repo_root

    def installing_entry(self):
        """The first entry that installs the package, or an empty string."""
        for entry in self.packages():
            if self.installs(entry):
                return entry if isinstance(entry, str) else ""
        return ""


def main(argv):
    if len(argv) != 3:
        print("usage: install_guard.py <settings.json> <repo root>",
              file=sys.stderr)
        return 2
    entry = InstallGuard(argv[1], argv[2]).installing_entry()
    if entry:
        print(entry)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
