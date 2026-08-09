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

SIGNPOST: list[tuple[str, bool]] = [
    ("Let's explore how updates work.", True),
    ("Let's take a look at how the mapping works.", True),
    ("In this section we cover the header.", True),
    # A `let's` naming the actual work tells the reader what happens next.
    ("So let's take a look at what happens after one snapshot instead.", False),
    ("So let's walk both engines through the table below.", False),
    ("So let's run that image through a build and then a snapshot.", False),
]

# True means the question is filler under a heading rather than a real hook.
HEADING_Q: list[tuple[str, bool]] = [
    ("How does the header work?", True),
    ("So what is a build map?", True),
    ("Why does any of this matter?", True),
    # A question naming a specific case the section goes on to trace.
    ("What happens when you create a new build off another diff instead of the base?", False),
    ("What happens if the sandbox dies before writeback runs?", False),
    ("How many round trips does a `git status` cost?", False),
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

PINNED: list[tuple[str, bool]] = [
    ("https://github.com/e2b-dev/infra/blob/main/packages/shared/x.go", True),
    ("https://github.com/container-storage-interface/spec/blob/master/spec.md", True),
    ("https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/x.go", False),
    # A release tag doesn't move once upstream cuts it, so it reads the same
    # next year as a SHA does.
    ("https://github.com/kubernetes/kubernetes/blob/v1.33.10/pkg/volume/csi/csi_plugin.go#L706", False),
    ("https://github.com/postgres/postgres/blob/REL_17_2/src/include/access/htup.h", True),
]

# Two boxes stacked over a third, which is the shape that made a column
# histogram over the whole fence flag correct diagrams: the write-cache walls
# sit at 12 and the read-cache wall below them at 19, two columns apart.
STACKED = report.Fence(
    start=1,
    end=9,
    info="text",
    body=(
        "    ▼       │        ▼       │",
        "┌───────┐   │    ┌───────┐   │",
        "│ write │   │    │ write │   │",
        "│cache A│   │    │cache B│   │",
        "└───────┘   │    └───────┘   │",
        "            │                │",
        "            └────────────────┘",
        "                     ▼",
        "           ┌──────────────────┐",
        "           │ read cache       │",
        "           └──────────────────┘",
    ),
)

# The third line is indented one column past the wall it belongs to, which is
# the typo the check exists for.
MISALIGNED = report.Fence(
    start=1,
    end=7,
    info="text",
    body=(
        "  ┌───────┐",
        "  │ write │",
        "   │cache│ ",
        "  │  bit  │",
        "  └───────┘",
    ),
)

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

PIVOT: list[tuple[str, str, bool]] = [
    ("The VM isn't what anyone waits on.", "The disk is.", True),
    ("Kubelet doesn't offer the choice here.", "The spec does.", True),
    # The fragment carries a fact of its own, so it isn't just a pointer back.
    ("The VM isn't what anyone waits on.", "The disk it boots from is where the time goes.", False),
    # No denial in front of it, so the second sentence isn't filling a blank.
    ("Every sandbox gets its own kernel.", "The isolation is.", False),
    # Real sentences from _posts/ that the surrounding shape resembles.
    ("XFS supports that.", "ext4 doesn't, so the same call does a real copy.", False),
    ("Nothing on that path is synchronous with the write.", "Tear down early and writeback hits a closed socket.", False),
    ("A checkpoint and a teardown both want the overlay.", "An unmount that waits can block for an interval.", False),
]

# The expected contraction, or None when the long form should survive.
CONTRACT: list[tuple[str, str | None]] = [
    ("The first two are free, because they are the table.", "they're"),
    ("One `UpdateItem` is not one index write.", "isn't"),
    ("It is the prefix that names the build.", "It's"),
    ("There is no caller to find.", "there's"),
    # `it is` and `that is` mid-sentence are a preposition's object closing a
    # phrase, so contracting them puts `it's` where no verb belongs.
    ("What you get for it is the prefix.", None),
    ("Each one only makes sense once the one before it is in place.", None),
    ("What Postgres buys with that is knowing how index entries died.", None),
    # `there` as an adverb, not the existential that introduces a noun.
    ("The only reason it feels less urgent there is that the wall is further out.", None),
    # The long form is the emphasis, which the italics mark, so leave it.
    ("What the batch size does *not* control is the S3 request count.", None),
    # Quoting the spec, and its wording isn't ours to contract.
    ("The spec says the plugin \"is not required to implement\" the call.", None),
    # A SQL keyword reads as caps, so it never wants an apostrophe.
    ("Rows where `table_name IS NOT NULL` are the cached ones.", None),
]

# The count of joints, where 0 means the sentence reads fine as it stands.
PILEUP: list[tuple[str, int]] = [
    ("Part 3 built the node-shared read cache and argued for why it's safe, but what it actually buys is a number, and getting that number meant running the same thing twice.", 2),
    ('Both of those hazards turn on a chunk being "cached," and that word has been doing a lot of unexamined work, so it\'s worth asking where a cached chunk actually sits.', 2),
    # `A, B, and C` is a series, so the closing `and` isn't a third statement.
    ("Firecracker sees an ordinary block device, the guest kernel does ordinary block I/O, and every miss becomes a 4 MiB range GET.", 0),
    ("That's the magic `SBRCST01`, then the cache key, the image size, and a boot ID.", 0),
    # Two joints but short clauses, so there's nothing to bank between them.
    ("Sharing only fixes the second Pod, though, and the first one still pays in full.", 0),
    ("It returns where block 5 would be inserted, which is index 4, so the owner is the entry before it.", 0),
    # The guide's own GOOD example for splitting a long sentence, which trips
    # this check because chaining causally and chaining loosely look identical
    # without a parser. Keep it here so a tightening can't quietly reflag it.
    ("The tuple body is gone and its bytes are reclaimed, but the slot number stays reserved, so an index entry still pointing there lands on something well-defined instead of a stranger's row.", 2),
]

# The matched text, or None when the comma is doing a job a full stop wouldn't.
SPLICE: list[tuple[str, str | None]] = [
    ("Break it and nothing throws, reads just start returning other people's data.", ", reads just start"),
    ("The refcount hits zero, it gets dropped on the next sweep.", ", it gets"),
    # A denial answered by the same subject, which is a contrast the comma fits.
    ("A GSI doesn't give you a cheap scan, it gives you a different key to be precise with.", None),
    ("Those goroutines aren't serving the block device, they *are* the block device.", None),
    # The comma closes a leading subordinate clause, so it's the one grammar asks for.
    ("When the last interested transaction finishes, nothing about the tuple changes.", None),
    ("Knowing that, it can convert the head into a redirect without consulting an index.", None),
    ("To read a specific block, you have to find which entry it lives inside.", None),
    # A series, where every comma is punctuating a list item.
    ("Five entries, both offsets spelled out, and no gaps between them.", None),
]

# The wh-word both sentences reach for, or None when they aren't a matched pair.
DEFINITION: list[tuple[str, str, str | None]] = [
    ("Offset is where the guest thinks the bytes are.", "BuildStorageOffset is where they actually are.", "where"),
    ("The header is what the reader parses first.", "The data file is what it seeks into.", "what"),
    # Different wh-words, so the pair doesn't read as one template filled twice.
    ("Offset is where the guest thinks the bytes are.", "BuildId is what names the data file.", None),
    # Only one of them is a definition, so the second is a consequence.
    ("Offset is where the guest thinks the bytes are.", "Dividing through by the block size loses nothing.", None),
]

SELF_REF: list[tuple[str, bool]] = [
    ("That's the whole vocabulary for the rest of the post.", True),
    ("Everything below is addressed relative to a build.", True),
    ("The rest of this section is about what that costs.", True),
    # A pointer at another post or a named part is a real cross-reference.
    ("Part 3 covers the node-shared read cache and why it's safe.", False),
    ("Everything below `overlay` is Part 1 unchanged.", False),
    ("The block below the header is where the data lives.", False),
    # A diagram or table is an artifact on the page, not the post's furniture.
    ("The diagram below shows the four cases of how they might overlap.", False),
    ("The table above spells both offsets out.", False),
]

STATED: list[tuple[str, bool]] = [
    ("Real images have too many digits to follow, so shrink one down to eight blocks.", True),
    ("The mapping is hard to read cold, and picture it as a sorted array instead.", True),
    # A consequence rather than a fix the reader is told to apply.
    ("A real image has far too many digits to follow by hand, so let's shrink one down.", False),
    ("Reads cluster, so the next request is probably inside the chunk you paid for.", False),
    ("The scan takes minutes, so writes keep arriving behind it.", False),
]

CONDITIONAL: list[tuple[str, bool]] = [
    ("Break it and nothing throws, so reads start returning other people's data.", True),
    ("Allow writes during the scan and rows get inserted behind it, so the index is missing rows.", True),
    # Say `if` and the sentence stops sounding like a lab procedure.
    ("If it breaks, reads silently start returning other people's data without raising any errors.", False),
    # Two beats and a stop, which is the shape that reads naturally.
    ("Ask it for one block and it fetches exactly one block.", False),
    ("Read an entry and you're standing in two address spaces, which is why mixing the offsets corrupts an image.", False),
    # The `and` sits inside a noun phrase, so there's only one consequence.
    ("Read that as a page and a slot on that page, and the slot is a real thing.", False),
]

# The number of bullets whose lead-in already names the count.
COUNTED: list[tuple[str, int, bool]] = [
    ("Hand that UUID to S3 and you get back five objects under it:", 5, True),
    ("Three rules cover the retry case in practice:", 3, True),
    # The number is a measurement, not an item count.
    ("The chunker works in 4 MiB units, and each one covers this much:", 4, False),
    ("Two things go wrong, and the second is worse:", 3, False),
    ("The header records what the data file can't:", 4, False),
]


def main() -> int:
    failures: list[str] = []

    for text, expected in SPLITS:
        parts = report.sentences(text)
        if (len(parts) == 1) != expected:
            failures.append(f"sentences({text!r}) split into {len(parts)}, want one={expected}")

    for text, expected in SIGNPOST:
        flagged = any(re.search(p, text.lower()) for p in report.SIGNPOSTS)
        if flagged != expected:
            failures.append(f"signpost {text!r} is {flagged}, want {expected}")

    for text, expected in HEADING_Q:
        flagged = report.TRACEABLE_QUESTION.search(text) is None
        if flagged != expected:
            failures.append(f"rhetorical-heading {text!r} is {flagged}, want {expected}")

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

    for first, second, expected in PIVOT:
        if report.negation_pivot(first, second) != expected:
            failures.append(f"negation_pivot({first!r}, {second!r}) is {not expected}, want {expected}")

    for text, expected in CONTRACT:
        hits = [contracted for _, contracted in report.contraction_hits(text)]
        if hits != ([expected] if expected else []):
            failures.append(f"contraction_hits({text!r}) is {hits}, want {expected}")

    for text, expected in PILEUP:
        joints = report.clause_pileup(report.normalize(text))
        if joints != expected:
            failures.append(f"clause_pileup({text!r}) is {joints}, want {expected}")

    for text, expected in SPLICE:
        hit = report.comma_splice(report.normalize(text))
        if hit != expected:
            failures.append(f"comma_splice({text!r}) is {hit!r}, want {expected!r}")

    for first, second, expected in DEFINITION:
        frame = report.parallel_definition(report.normalize(first), report.normalize(second))
        if (frame[0] if frame else None) != expected:
            failures.append(f"parallel_definition({first!r}, {second!r}) is {frame!r}, want {expected!r}")

    for text, expected in SELF_REF:
        flagged = report.SELF_REFERENCE.search(report.normalize(text)) is not None
        if flagged != expected:
            failures.append(f"self-reference {text!r} is {flagged}, want {expected}")

    for text, expected in STATED:
        flagged = report.STATED_THEN_SOLVED.search(report.normalize(text)) is not None
        if flagged != expected:
            failures.append(f"stated-then-solved {text!r} is {flagged}, want {expected}")

    for text, expected in CONDITIONAL:
        flagged = report.IMPERATIVE_CONDITIONAL.match(report.normalize(text)) is not None
        if flagged != expected:
            failures.append(f"imperative-conditional {text!r} is {flagged}, want {expected}")

    for lead, items, expected in COUNTED:
        counts = {report.NUMBER_WORDS.get(m.group(1).lower(), 0) for m in report.LEAD_COUNT.finditer(report.normalize(lead))}
        flagged = items in counts
        if flagged != expected:
            failures.append(f"counted-bullets {lead!r} over {items} bullets is {flagged}, want {expected}")

    for url, expected in PINNED:
        ref = url.split("/blob/")[1].split("/")[0]
        flagged = report.PINNED_REF.fullmatch(ref) is None
        if flagged != expected:
            failures.append(f"unpinned-link /blob/{ref}/ is {flagged}, want {expected}")

    if report.check_diagram(STACKED):
        failures.append(f"box-column flagged a stacked diagram: {report.check_diagram(STACKED)}")
    if not report.check_diagram(MISALIGNED):
        failures.append("box-column missed a bar indented one column off its wall")

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
        len(SPLITS) + len(SIGNPOST) + len(HEADING_Q) + len(READING) + len(ANNOUNCES) + len(SPEC_SHEET) + len(COLON)
        + len(SEAM_OPENER) + len(ECHO) + len(PIVOT) + len(CONTRACT) + len(PINNED)
        + len(PILEUP) + len(SPLICE) + len(DEFINITION) + len(SELF_REF) + len(STATED)
        + len(CONDITIONAL) + len(COUNTED) + 2 + len(posts)
    )
    print(f"\n{checks - len(failures)}/{checks} passed over {len(posts)} posts")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
