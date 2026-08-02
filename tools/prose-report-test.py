#!/usr/bin/env python3
"""Check the prose-report patterns against lines they should and shouldn't flag.

The GOOD cases are real sentences from _posts/ that a pattern misfired on
during tuning. They are here so a future tightening of one pattern doesn't
quietly resurrect a false positive somewhere else.

    python3 tools/prose-report-test.py
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("prose_report", Path(__file__).parent / "prose-report.py")
assert spec and spec.loader
report = importlib.util.module_from_spec(spec)
# dataclass() resolves annotations through sys.modules, so register before exec.
sys.modules[spec.name] = report
spec.loader.exec_module(report)

# True means one sentence, so the splitter left the text alone.
SPLITS: list[tuple[str, bool]] = [
    ("Nothing warns you.", True),
    ("It kicks in at roughly 2 KB, not 8 KB, per e.g. the header.", True),
    # A trailing capital is only an initial with a space in front of it, so
    # neither of these periods belongs to an abbreviation.
    ("A scan can be doing random I/O. Fixing that means a rebuild.", False),
    ("The limit is 2 KB. Past it the column moves out of line.", False),
    ("Named for its author, Dr. Codd, and never revised since.", True),
    # A lowercase identifier can open a sentence, so this is two.
    ("XFS supports that. ext4 doesn't, so the call does a real copy.", False),
]

READING: list[tuple[str, bool]] = [
    ("Read on for the rest of the header.", True),
    ("It's worth going slowly here.", True),
    # `read on` as a noun, which is what the imperative anchor protects.
    ("It has nothing to say, so it can't serve a read on its own.", False),
    ("A spread read on four sockets stays put.", False),
]

ANNOUNCES: list[tuple[str, bool]] = [
    ("Not free, though.", True),
    ("Nothing warns you.", True),
    ("Here's the table.", True),
    ("Let's explore how updates work.", True),
    ("The answer is below.", True),
    # The guide's own GOOD example: names where rows live, so it carries the fact.
    ("The answer comes down to where each engine puts the row.", False),
    ("Neither engine wins both.", False),
    ("Now add the `email` index.", False),
    ("Now set `name = 'Smyth'` instead.", False),
    ("Splits cost more than space.", False),
    ("Postgres has nothing to undo.", False),
    ("Nothing in those eight transfers the image.", False),
]

SPEC_SHEET: list[tuple[str, bool]] = [
    ("The metadata is 64 bytes.", True),
    ("The build map has one 40-byte entry per range.", True),
    ("The header opens with 64 bytes of metadata and then repeats an entry per range.", False),
    ("That asymmetry is exactly what Part 1's overlay split was worth.", False),
    ("The expensive resource is shareable because the read side never diverges.", False),
]

COLON: list[tuple[str, bool]] = [
    ("Everything else is downstream of that: what it costs, what it holds, and which knob is right.", True),
    ("Three things go wrong at once: the page is full, the split is even, and it isn't cached.", True),
    ("No partial credit: either no index is touched or all of them are.", False),
    ("Both engines store data in fixed-size pages, 8 KB for Postgres and 16 KB for InnoDB.", False),
]

SEAM_OPENER: list[tuple[str, bool]] = [
    ("The disk is.", True),
    ("Which is the job the header does.", True),
    ("And that's the whole trick.", True),
    ("Postgres has nothing to undo.", False),
    ("Now add the `email` index.", False),
    ("Splits cost more than space.", False),
    # Leads into the block below it, so the paragraph break is the handoff.
    ("So the export runs on a timer instead:", False),
]

DIAGRAM = report.Fence(
    start=1,
    end=9,
    info="text",
    body=(
        "  postmaster                  mysqld",
        "  │ backend 1  alive     │    │ thread 1  same heap │",
        "  one client loses its        nothing isolated, so the",
        "  connection, server          corruption is everyone's",
    ),
)

ECHO: list[tuple[str, bool]] = [
    ("Postgres loses a connection where MySQL loses the server.", True),
    ("A crashed backend costs you one client, and the postmaster reinitialises shared memory.", False),
]


def main() -> int:
    failures: list[str] = []

    for text, expected in SPLITS:
        parts = report.sentences(text)
        if (len(parts) == 1) != expected:
            failures.append(f"sentences({text!r}) split into {len(parts)}, want one={expected}")

    for text, expected in READING:
        flagged = any(re.search(p, text.lower()) for p in report.READING_INSTRUCTIONS)
        if flagged != expected:
            failures.append(f"reading-instruction {text!r} is {flagged}, want {expected}")

    for text, expected in ANNOUNCES:
        if report.announces_only(text) != expected:
            failures.append(f"announces_only({text!r}) is {not expected}, want {expected}")

    for text, expected in SPEC_SHEET:
        if report.is_spec_sheet(text) != expected:
            failures.append(f"is_spec_sheet({text!r}) is {not expected}, want {expected}")

    for text, expected in COLON:
        if bool(report.COLON_LIST_RE.search(text)) != expected:
            failures.append(f"COLON_LIST_RE({text!r}) is {not expected}, want {expected}")

    for text, expected in SEAM_OPENER:
        if report.strands_the_opener(text) != expected:
            failures.append(f"strands_the_opener({text!r}) is {not expected}, want {expected}")

    for text, expected in ECHO:
        shared, share = report.diagram_echo(DIAGRAM, text)
        flagged = share >= 0.5 and len(shared) >= 3
        if flagged != expected:
            failures.append(f"diagram_echo({text!r}) share {share:.2f}, want flagged={expected}")

    posts = sorted(p for p in report.POSTS.glob("*.md") if p.name not in report.NOT_POSTS)
    slugs = {p.stem[11:] for p in posts}
    for path in posts:
        post = report.parse(path)
        report.check_mechanical(post, slugs)
        report.check_judgment(post)
        if post.unbalanced_fence is not None:
            failures.append(f"{path.name}: unbalanced fence at L{post.unbalanced_fence}")
        if not post.paragraphs:
            failures.append(f"{path.name}: parsed zero paragraphs")

    for failure in failures:
        print(f"FAIL  {failure}")
    checks = (
        len(SPLITS) + len(READING) + len(ANNOUNCES) + len(SPEC_SHEET) + len(COLON)
        + len(SEAM_OPENER) + len(ECHO) + len(posts)
    )
    print(f"\n{checks - len(failures)}/{checks} passed over {len(posts)} posts")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
