#!/usr/bin/env python3
"""The one-loader guard's decisions, asked with an injected resolver.

The installer refuses when a settings entry would load pi-cache a second
time. What "the same checkout" means is a canonical question, and these
cases answer it without creating a link on the host: the resolver is the
seam, so two spellings of one checkout and one spelling of two checkouts
are written down as answers instead of staged on disk.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from install_guard import InstallGuard, normalized  # noqa: E402

ROOT = "C:/checkouts/pi-cache"


class Settings:
    """A settings file in this case's scratch directory."""

    def __init__(self, packages):
        handle, self.path = tempfile.mkstemp(suffix="-settings.json")
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump({"packages": packages}, stream)
        self.packages = packages

    def close(self):
        os.unlink(self.path)


def guard_with(packages, answers=None, root=ROOT):
    """A guard over `packages`, with the resolver's answers for paths."""
    answers = dict(answers or {})
    answers.setdefault(root, root)

    def realpath(value):
        if value in answers:
            return answers[value]
        raise OSError(f"ENOENT: {value}")

    settings = Settings(packages)
    guard = InstallGuard(settings.path, root, realpath=realpath)
    return guard, settings


class InstallGuardTests(unittest.TestCase):
    def test_a_git_pin_for_this_package_installs_it(self) -> None:
        guard, settings = guard_with(["git:github.com/ederevx/pi-cache@v0.19.3"])
        try:
            self.assertEqual(guard.installing_entry(),
                             "git:github.com/ederevx/pi-cache@v0.19.3")
        finally:
            settings.close()

    def test_another_package_does_not_install_it(self) -> None:
        guard, settings = guard_with(["git:github.com/ederevx/pi-consult@v0.26.7"])
        try:
            self.assertEqual(guard.installing_entry(), "")
        finally:
            settings.close()

    def test_a_second_spelling_of_this_checkout_installs_it(self) -> None:
        """The regression: a worktree or renamed clone is the same checkout."""
        guard, settings = guard_with(
            ["C:/checkouts/link-name"],
            {"C:/checkouts/link-name": ROOT})
        try:
            self.assertEqual(guard.installing_entry(), "C:/checkouts/link-name")
        finally:
            settings.close()

    def test_an_alias_in_git_for_windows_spelling_installs_it(self) -> None:
        guard, settings = guard_with(["/c/checkouts/pi-cache"])
        try:
            self.assertEqual(guard.installing_entry(), "/c/checkouts/pi-cache",
                             "the same path in either spelling is one checkout")
        finally:
            settings.close()

    def test_a_different_checkout_does_not_install_it(self) -> None:
        guard, settings = guard_with(
            ["C:/checkouts/other"],
            {"C:/checkouts/other": "C:/checkouts/other"})
        try:
            self.assertEqual(guard.installing_entry(), "")
        finally:
            settings.close()

    def test_the_package_directory_name_installs_it_wherever_it_is(self) -> None:
        guard, settings = guard_with(["D:/elsewhere/pi-cache"])
        try:
            self.assertEqual(guard.installing_entry(), "D:/elsewhere/pi-cache")
        finally:
            settings.close()

    def test_a_trailing_separator_and_backslashes_do_not_matter(self) -> None:
        guard, settings = guard_with(["C:\\checkouts\\other\\"],
                                     {"C:/checkouts/other": ROOT})
        try:
            self.assertEqual(guard.installing_entry(), "C:\\checkouts\\other\\")
        finally:
            settings.close()

    def test_a_non_string_entry_installs_nothing(self) -> None:
        guard, settings = guard_with([7, None, {"path": "pi-cache"}])
        try:
            self.assertEqual(guard.installing_entry(), "")
        finally:
            settings.close()

    def test_no_entries_installs_nothing(self) -> None:
        guard, settings = guard_with([])
        try:
            self.assertEqual(guard.installing_entry(), "")
        finally:
            settings.close()

    def test_an_unreadable_settings_file_is_no_entry(self) -> None:
        guard = InstallGuard("C:/no/such/settings.json", ROOT)
        self.assertEqual(guard.installing_entry(), "")

    def test_an_unparsable_settings_file_is_no_entry(self) -> None:
        handle, path = tempfile.mkstemp(suffix="-settings.json")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write("{\"packages\": [")
            self.assertEqual(InstallGuard(path, ROOT).installing_entry(), "")
        finally:
            os.unlink(path)

    def test_a_resolver_failure_leaves_the_path_as_given(self) -> None:
        guard, settings = guard_with(["C:/checkouts/variant"], root=ROOT)
        try:
            self.assertEqual(guard.canonical("C:/checkouts/variant"),
                             os.path.normcase("C:/checkouts/variant"))
        finally:
            settings.close()

    def test_an_empty_root_compares_by_name_only(self) -> None:
        guard, settings = guard_with(["C:/checkouts/pi-cache"], root="")
        try:
            self.assertEqual(guard.installing_entry(), "C:/checkouts/pi-cache")
        finally:
            settings.close()

    def test_the_first_installing_entry_is_reported(self) -> None:
        guard, settings = guard_with([
            "git:github.com/ederevx/pi-consult@v1",
            "git:github.com/ederevx/pi-cache@v1",
            "C:/checkouts/pi-cache",
        ])
        try:
            self.assertEqual(guard.installing_entry(),
                             "git:github.com/ederevx/pi-cache@v1")
        finally:
            settings.close()


class NormalizedTests(unittest.TestCase):
    def test_a_git_for_windows_path_becomes_a_drive_path(self) -> None:
        self.assertEqual(normalized("/c/Users/me/pi-cache"), "C:/Users/me/pi-cache")

    def test_a_drive_path_is_unchanged(self) -> None:
        self.assertEqual(normalized("C:/Users/me/pi-cache"), "C:/Users/me/pi-cache")

    def test_backslashes_and_trailing_separators_are_removed(self) -> None:
        self.assertEqual(normalized("C:\\Users\\me\\pi-cache\\"),
                         "C:/Users/me/pi-cache")

    def test_a_git_entry_is_not_a_path(self) -> None:
        self.assertEqual(normalized("git:github.com/ederevx/pi-cache@v1"),
                         "git:github.com/ederevx/pi-cache@v1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
