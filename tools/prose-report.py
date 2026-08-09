#!/usr/bin/env python3
"""Print prose statistics and flag anomalies in _posts/ markdown.

Advisory. A clean run is not evidence the writing is good, and a flagged
line is often correct in context. Read _posts/AGENTS.md and judge each
finding on its own.

    python3 tools/prose-report.py                  # every post
    python3 tools/prose-report.py _posts/foo.md    # named posts
    python3 tools/prose-report.py --quiet          # findings only
    python3 tools/prose-report.py --show           # with the source line
    python3 tools/prose-report.py --labels         # what each label means
"""

from __future__ import annotations

import argparse
import re
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

REPO = Path(__file__).resolve().parent.parent
POSTS = REPO / "_posts"
NOT_POSTS = {"AGENTS.md", "CLAUDE.md", "README.md"}

Kind = Literal["mechanical", "judgment"]


@dataclass(frozen=True, slots=True)
class Finding:
    line: int
    kind: Kind
    label: str
    detail: str


@dataclass(frozen=True, slots=True)
class Paragraph:
    start: int
    end: int
    raw: str
    text: str

    @property
    def where(self) -> str:
        return f"L{self.start}" if self.start == self.end else f"L{self.start}-{self.end}"


# Anything that can sit directly above or below a `│` and still be the same
# wall, so a corner and a tee count and an arrowhead terminating the line does
# too.
BOX_CHARS = "│┌┐└┘├┤┬┴┼▼▲╪╫"


@dataclass(frozen=True, slots=True)
class Fence:
    start: int
    end: int
    info: str
    body: tuple[str, ...]

    @property
    def is_diagram(self) -> bool:
        return any(ch in "".join(self.body) for ch in "┌└│─►▼")


@dataclass(frozen=True, slots=True)
class Section:
    line: int
    level: int
    title: str
    words: int
    opener: str


@dataclass(frozen=True, slots=True)
class ListRun:
    start: int
    numbered: bool
    items: int


# ---------------------------------------------------------------- parsing

FENCE_RE = re.compile(r"^(\s*)(`{3,})\s*(\S*)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)")
LIST_RE = re.compile(r"^\s*(\d+\.|[-*+])\s+")
NUMBERED_RE = re.compile(r"^\s*\d+\.\s+")
ATTR_RE = re.compile(r"^\s*\{:")
# The bare `[A-Z]` branch is a middle initial, so it wants a space in front of
# it. Without one it swallows the period ending `random I/O.` or `4 KB.`
ABBREV_RE = re.compile(
    r"(?:\b(?:e\.g|i\.e|vs|etc|approx|Dr|Mr|Ms|Mrs|Pt|Fig|No|Inc|Ltd|Jr|Sr|St)|(?:^|\s)[A-Z])\.$"
)
# A capital normally marks the next sentence, so a lowercase identifier that
# starts one has to be listed: `XFS supports that. ext4 doesn't` is two.
LOWER_START = r"(?:ext[234]|nbd|mysqld|postgres|kubelet|systemd|iostat|fsync)\b"
CODE_SPAN_RE = re.compile(r"`[^`]+`")
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
# What a permalink can point at and still show the same bytes next year. A full
# SHA, or a release tag, which upstream projects don't move once it's cut.
PINNED_REF = re.compile(r"[0-9a-f]{40}|v?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?")
CONTRACTION_RE = re.compile(r"\b\w+['\u2019](?:s|t|re|ve|ll|d|m)\b", re.I)


@dataclass(frozen=True, slots=True)
class Post:
    path: Path
    frontmatter: dict[str, str]
    paragraphs: tuple[Paragraph, ...]
    fences: tuple[Fence, ...]
    sections: tuple[Section, ...]
    lists: tuple[ListRun, ...]
    tables: int
    quote_lines: tuple[tuple[int, str], ...]
    raw_lines: tuple[str, ...]
    unbalanced_fence: int | None

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def prose(self) -> str:
        return " ".join(p.text for p in self.paragraphs)


def normalize(raw: str) -> str:
    """Strip markdown that isn't prose the reader parses as words."""
    text = LINK_RE.sub(lambda m: m.group(1) or m.group(2), raw)
    text = CODE_SPAN_RE.sub(lambda m: "Code" + m.group(0)[1:-1].replace(" ", ""), text)
    text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)
    return text


def parse(path: Path) -> Post:
    lines = path.read_text().split("\n")
    frontmatter: dict[str, str] = {}
    paragraphs: list[Paragraph] = []
    fences: list[Fence] = []
    headings: list[tuple[int, int, str]] = []
    lists: list[ListRun] = []
    quotes: list[tuple[int, str]] = []
    tables = 0

    in_fm = False
    fence_marker: str | None = None
    fence_start = 0
    fence_info = ""
    fence_body: list[str] = []
    unbalanced: int | None = None
    para: list[tuple[int, str]] = []
    run: list[tuple[int, str]] | None = None

    def flush_para() -> None:
        nonlocal para
        if para:
            raw = " ".join(t.strip() for _, t in para)
            paragraphs.append(Paragraph(para[0][0], para[-1][0], raw, normalize(raw)))
            para = []

    def flush_run() -> None:
        nonlocal run
        if run:
            lists.append(ListRun(run[0][0], NUMBERED_RE.match(run[0][1]) is not None, len(run)))
            run = None

    for number, text in enumerate(lines, start=1):
        stripped = text.strip()

        if number == 1 and stripped == "---":
            in_fm = True
            continue
        if in_fm:
            if stripped == "---":
                in_fm = False
            elif ":" in stripped:
                key, _, value = stripped.partition(":")
                frontmatter[key.strip()] = value.strip()
            continue

        fence = FENCE_RE.match(text)
        if fence_marker is None and fence:
            flush_para()
            flush_run()
            fence_marker = fence.group(2)
            fence_start = number
            fence_info = fence.group(3)
            fence_body = []
            continue
        if fence_marker is not None:
            if fence and fence.group(2).startswith(fence_marker) and not fence.group(3):
                fences.append(Fence(fence_start, number, fence_info, tuple(fence_body)))
                fence_marker = None
            else:
                fence_body.append(text)
            continue

        if not stripped:
            flush_para()
            flush_run()
            continue

        heading = HEADING_RE.match(text)
        if heading:
            flush_para()
            flush_run()
            headings.append((number, len(heading.group(1)), heading.group(2).strip()))
            continue

        if stripped.startswith(">"):
            flush_para()
            flush_run()
            quotes.append((number, stripped.lstrip("> ").rstrip()))
            continue

        if ATTR_RE.match(text):
            continue

        if stripped.startswith("|"):
            flush_para()
            flush_run()
            if not lines[number - 2].strip().startswith("|"):
                tables += 1
            continue

        if LIST_RE.match(text):
            flush_para()
            if run is None:
                run = []
            run.append((number, text))
            continue

        flush_run()
        para.append((number, text))

    flush_para()
    flush_run()
    if fence_marker is not None:
        unbalanced = fence_start

    return Post(
        path=path,
        frontmatter=frontmatter,
        paragraphs=tuple(paragraphs),
        fences=tuple(fences),
        sections=tuple(build_sections(headings, paragraphs, lists)),
        lists=tuple(lists),
        tables=tables,
        quote_lines=tuple(quotes),
        raw_lines=tuple(lines),
        unbalanced_fence=unbalanced,
    )


def build_sections(
    headings: list[tuple[int, int, str]],
    paragraphs: list[Paragraph],
    lists: list[ListRun],
) -> list[Section]:
    sections: list[Section] = []
    for index, (line, level, title) in enumerate(headings):
        stop = headings[index + 1][0] if index + 1 < len(headings) else 10**9
        inside = [p for p in paragraphs if line < p.start < stop]
        words = sum(len(p.text.split()) for p in inside)
        words += sum(run.items * 8 for run in lists if line < run.start < stop)
        opener = sentences(inside[0].text)[0] if inside and sentences(inside[0].text) else ""
        sections.append(Section(line, level, title, words, opener))
    return sections


def sentences(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?](?=[\"')\]]*(\s|$))", text):
        head = text[start : match.end()]
        if ABBREV_RE.search(head.rstrip()):
            continue
        tail = text[match.end() :]
        if tail and not re.match(r"[\"')\]]*\s+(?:[A-Z\"'(\u201c]|" + LOWER_START + ")", tail):
            continue
        if head.strip():
            out.append(head.strip())
        start = match.end()
    if text[start:].strip():
        out.append(text[start:].strip())
    return out


# ---------------------------------------------------------------- vocabulary

BANNED_WORDS = [
    "delve", "dive into", "bolster", "foster", "harness", "shed light on",
    "pave the way", "pivotal", "groundbreaking", "cutting-edge",
    "transformative", "game-changing", "innovative", "robust",
    "comprehensive", "seamless", "intricate", "vibrant", "multifaceted",
    "holistic", "testament",
]

FIGURATIVE_WORDS = ["navigate", "underscore", "leverage", "unpack", "nuanced", "landscape", "realm"]

BANNED_PHRASES = [
    r"in today's [\w-]+ world", r"it's (important|worth noting) that",
    r"one of the most (important|significant|crucial)", r"when it comes to",
    r"at its core", r"at the end of the day", r"this is where \w+ comes in",
    r"let's break it down", r"plays a crucial role", r"cannot be overstated",
    r"underscoring the importance", r"highlighting the need for",
    r"reflecting a broader trend", r"marking a significant shift",
]

BANNED_STRUCTURES = [
    (r"it's not just .{1,40}(it's|but)", "it's not just X, it's Y"),
    (r"\bnot only\b.{1,60}\bbut\b", "not only X, but Y"),
    (r"this isn't about .{1,40}\.\s+it's about", "this isn't about X. It's about Y"),
]

SIGNPOSTS = [
    r"let's (explore|dive)", r"now let's turn",
    # `let's take a look at what happens after one snapshot` names the work, so
    # only the topic-shaped object is a signpost: `at how the mapping works`.
    r"let's (take a look at|examine|look at) (how|the way)\b[^.]{0,48}\bworks?\b",
    r"consider a scenario", r"in this section", r"we'll (look at|explore|cover)",
    r"as (we|you) (can see|mentioned earlier)", r"first, let's",
]

READING_INSTRUCTIONS = [
    r"worth going slowly", r"bear with me", r"stay with me",
    r"it's worth noting", r"as we'll see",
    # The imperative only, since `serve a read on its own` is a noun.
    r"(?:^|[.!?]\s+)read on\b",
    r"more on (this|that) (later|below)", r"we'll come back to",
]

FILLER_OPENERS = {"simple.", "surprisingly.", "interestingly.", "obviously.", "naturally.", "unsurprisingly."}

SUBORDINATORS = re.compile(r"\b(since|because|which|while|although|so that|whereas|unless)\b", re.I)
STRUCTURE_VERBS = re.compile(r"^\W*\S+(\s+\S+){0,3}\s+(is|has|holds|stores|contains|carries|keeps)\s", re.I)


def is_spec_sheet(sentence: str) -> bool:
    """A short `X contains Y` statement with a measurement and no consequence.

    The guide's target is a run of these side by side, which reads like a spec
    sheet. A subordinate clause means the sentence is doing something with the
    fact rather than just listing it.
    """
    if len(sentence.split()) > 16 or not STRUCTURE_VERBS.match(sentence):
        return False
    if SUBORDINATORS.search(sentence) or "," in sentence:
        return False
    # A measurement is the tell. Without one the sentence is making a claim,
    # not reciting a field, so `is exactly what Part 1 was worth` stays.
    return re.search(r"\b\d+([.,]\d+)?\s*(?:[KMGT]i?B|bytes?|bits?|entries|entry|%|\w+-byte)", sentence) is not None

# A short opener earns its place by carrying a fact. These carry none: they
# say a fact is coming, or grade the one above without adding to it.
ANNOUNCING_OPENER = re.compile(
    r"^(?:"
    r"(?:it|that|this|there)'?s?\s+(?:not|no|worth|where|when|how|why|the\s+\w+\s+part)"
    r"|(?:so|but|and|then)?\s*here'?s\b"
    r"|(?:the\s+)?(?:answer|reason|question|point|catch|problem|trick|rest|bill|cost)"
    r"\s+(?:is|comes|arrives|lands|matters)\b"
    r"|\w+\s+(?:comes?|goes?)\s+first\b"
    r"|(?:let'?s|consider)\b"
    r")",
    re.I,
)

# "Nothing warns you." and "Not free, though." carry no fact, but
# "Nothing in those eight transfers the image." does, so the bare negation
# only counts when there's almost nothing else in the sentence.
BARE_NEGATION = re.compile(r"^(?:not|nothing|nobody|none|never)\b", re.I)

# Promises a complication without naming it: "Which raises its own problem."
VAGUE_NOUN = re.compile(
    r"\b(?:problem|problems|issue|issues|question|questions|catch|wrinkle|twist|"
    r"complication|subtlety|thing|things|story|shape)\b\.?$",
    re.I,
)


def announces_only(sentence: str) -> bool:
    words = len(sentence.split())
    if words >= 9:
        return False
    stripped = sentence.rstrip(":")
    if BARE_NEGATION.match(stripped) and words <= 4:
        return True
    if VAGUE_NOUN.search(stripped) and not re.search(r"\d|`", stripped):
        return True
    return ANNOUNCING_OPENER.match(stripped) is not None


# `X isn't what anyone waits on. The disk is.` The denial sets up a blank and
# the fragment fills it, which is the escalating-fragment habit wearing a
# copula instead of a repeated number.
DENIAL = re.compile(r"\b(?:isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|won'?t|never)\b", re.I)
DANGLING_COPULA = re.compile(r"^(?:the|a|an|its|his|her|their|our|this|that)\b[^.!?]*\b(?:is|are|was|were|does|do|did|will)\.$", re.I)


def negation_pivot(first: str, second: str) -> bool:
    """Flag a denial answered by a fragment that ends on a bare verb.

    The second sentence has to stop at the verb, so `The disk is.` counts and
    `The disk is where the time goes.` doesn't. Ending there means the whole
    sentence is a pointer back at the one before it, carrying no fact of its
    own, which is what makes it the same move as `Not fewer. Zero.`
    """
    if len(second.split()) > 5 or not DENIAL.search(first):
        return False
    return DANGLING_COPULA.match(second.strip()) is not None


# A quotation from the docs isn't ours to reword, and `does *not* control` is
# leaning on the long form deliberately, so both spans come out before matching.
EXEMPT_SPAN = re.compile(r"\"[^\"]*\"|“[^”]*”|\*[^*]+\*")


# The guide asks for contractions, and a negation is where an uncontracted
# form is most audible. `it is` and `that is` are sentence-initial only,
# because mid-sentence they're a preposition's object closing a phrase, as in
# `what you get for it is the prefix`, where nothing wants contracting.
CONTRACTIONS = [
    (r"\bis not\b", "isn't"), (r"\bare not\b", "aren't"),
    (r"\bwas not\b", "wasn't"), (r"\bwere not\b", "weren't"),
    (r"\bdoes not\b", "doesn't"), (r"\bdo not\b", "don't"),
    (r"\bdid not\b", "didn't"), (r"\bcan ?not\b", "can't"),
    (r"\bwill not\b", "won't"), (r"\bwould not\b", "wouldn't"),
    (r"\bshould not\b", "shouldn't"), (r"\bcould not\b", "couldn't"),
    (r"\bhas not\b", "hasn't"), (r"\bhave not\b", "haven't"),
    (r"\bhad not\b", "hadn't"),
    (r"\bthey are\b", "they're"), (r"\byou are\b", "you're"),
    (r"\bwe are\b", "we're"), (r"\byou will\b", "you'll"),
    (r"\bwe will\b", "we'll"), (r"\bit will\b", "it'll"),
    (r"\blet us\b", "let's"),
    # `there` is also an adverb, as in `less urgent there is that the wall is
    # further out`, so this wants the noun phrase an existential introduces.
    (r"\bthere is(?= (?:a|an|no|one|only|nothing|some|another|little|more|less)\b)", "there's"),
    # Sentence-initial only, so a trailing `where it is` stays put.
    (r"^It is\b", "It's"), (r"^That is\b", "That's"), (r"^What is\b", "What's"),
]


def contraction_hits(raw: str) -> list[tuple[str, str]]:
    """Find long forms that read stiffer than the contraction, per sentence.

    Matching runs on the raw paragraph so the emphasis and quotation spans are
    still marked up. The sentence-initial patterns need the split to know where
    a sentence starts, which is why this doesn't just scan the paragraph.
    """
    out: list[tuple[str, str]] = []
    for sentence in sentences(normalize(EXEMPT_SPAN.sub(" ", raw))):
        for pattern, contracted in CONTRACTIONS:
            match = re.search(pattern, sentence, re.I)
            # An all-caps match is a SQL or spec keyword, as in `MUST NOT`.
            if match and not match.group(0).isupper():
                out.append((f"{match.group(0)}  {short(sentence, 58)}", contracted))
    return out


# `Offset is where the guest thinks the bytes are. BuildStorageOffset is where
# they actually are.` Two definitions poured into the same mould, which spends
# two stiff sentences on a contrast one sentence can carry.
DEFINITION_FRAME = re.compile(r"^\W*\S+(?:\s+\S+){0,2}?\s+(?:is|are|was|were)\s+(where|what|how|why|when|the one)\b", re.I)


def parallel_definition(first: str, second: str) -> tuple[str, str] | None:
    """Flag back-to-back definitions built on the same `X is where ...` frame.

    Both sentences have to reach for the same wh-word, since that repetition is
    what makes the pair read as a template being filled in twice rather than as
    a thought and its consequence.
    """
    a, b = DEFINITION_FRAME.match(first), DEFINITION_FRAME.match(second)
    if a is None or b is None or a.group(1).lower() != b.group(1).lower():
        return None
    return a.group(1).lower(), b.group(1).lower()


# Prose about the post's own layout rather than about the subject: `for the rest
# of the post`, `everything below`. A pointer at another part is a real
# cross-reference, so `Part 3 covers` and `the section below` part ways here.
SELF_REFERENCE = re.compile(
    r"\b(?:for|in|through(?:out)?)\s+the\s+rest\s+of\s+(?:this|the)\s+(?:post|section|series)\b"
    r"|\bthe\s+(?:rest|remainder)\s+of\s+(?:this|the)\s+(?:post|section)\b"
    # A bare `below` points at the page. `below the header` points at a thing.
    r"|\beverything\s+(?:below|above)\s+(?:is|was|here|else)\b"
    r"|\beverything\s+that\s+follows\b"
    # A section or paragraph is the post's own furniture. A diagram or table is
    # a thing on the page, so pointing at one is ordinary deixis.
    r"|\bthe\s+(?:section|paragraph)\s+(?:below|above)\b"
    r"|\bthis\s+(?:post|section)\s+(?:is\s+about|covers|walks|explains)\b"
    r"|\b(?:earlier|later)\s+in\s+(?:this|the)\s+post\b",
    re.I,
)

# `Real images have too many digits, so shrink one down to eight blocks.` The
# problem and its fix arrive in one clause each, with nobody in the sentence.
BARE_IMPERATIVE = (
    r"take|shrink|start|picture|imagine|say|call|note|consider|use|watch|read|count"
    r"|think|drop|pick|ask|run|write|open|walk|follow|trace|swap|treat|skip|assume"
)
STATED_THEN_SOLVED = re.compile(rf",\s+(?:so|and)\s+(?:{BARE_IMPERATIVE})\b", re.I)

# Any imperative that can open a hypothetical, which is a wider set than the ones
# that show up as a stated-and-solved fix.
HYPOTHETICAL_VERB = (
    rf"{BARE_IMPERATIVE}|break|tear|allow|copy|boot|hit|miss|lose|delete|mount|set"
    r"|add|give|forget|leave|point|move|make|get|put|push|widen|reuse"
)

# `Break it and nothing throws, so reads start returning other people's data.`
# An imperative standing in for `if`, its result, then a second result hung off
# the first. Two beats reads fine, and the third turns it into a lab report. Only
# a `, so` tail counts, since `, which` and `, and` land on a noun as often as on
# a clause: `Read that as a page and a slot, and the slot is a real thing.`
IMPERATIVE_CONDITIONAL = re.compile(
    rf"^(?:so\s+|then\s+|now\s+)?(?:{HYPOTHETICAL_VERB})\b[^.]*?\s+and\s+[^.]*?,\s+so\b",
    re.I,
)

# There's no reliable `verbless` check to write here. Telling a finite verb from
# a plural noun needs a parser, since `pairs` and `covers` inflect identically,
# so `Four socket pairs per device, wired up over netlink` and `It wants a device
# in /dev, with a major number` can't be separated by spelling. The rule lives in
# the guide under Voice and tone instead.

# `A, but B, and C.` Two joints, so the reader banks three statements before
# finding out which one the sentence was about. The last one is often a clause
# that only grades the one before it, which cuts clean. The optional quote
# catches a joint after dialogue, where the comma sits inside the quotation.
JOINT = re.compile(r",[\"']?\s+(but|and|or|so|which|since|because|though|while|then)\b", re.I)

# `A, B, and C`, where the closing `and` is punctuating a series rather than
# restarting the sentence: `Firecracker sees a device, the kernel does block
# I/O, and every miss becomes a GET`. Wants a bare comma before the last joint,
# since that first item is what makes the three parallel instead of chained.
BARE_COMMA = re.compile(r",\s+(?!but|and|or|so|which|since|because|though|while|then\b)\w+", re.I)


def is_series(sentence: str) -> bool:
    """Tell `A, B, and C` from a sentence that restarts on `and`.

    The tell is a bare comma earlier in the sentence, before the `and` joint.
    Without one there are only two items, so the `and` is joining clauses
    rather than closing a list.
    """
    last = None
    for match in JOINT.finditer(sentence):
        last = match
    if last is None or last.group(1).lower() not in {"and", "or"}:
        return False
    return bool(BARE_COMMA.search(sentence[: last.start() + 1]))


def clause_pileup(sentence: str) -> int:
    """Count the places a sentence restarts on a new independent clause.

    Length is the other half of the signal, since `A, and B, so C` reads fine
    while the clauses are short. The shape only goes wrong once the reader is
    banking a dozen-odd words per joint before finding out which one mattered.
    """
    joints = len(JOINT.findall(sentence)) - (1 if is_series(sentence) else 0)
    if joints < 2 or len(sentence.split()) < 8 * joints + 12:
        return 0
    return joints


# `nothing throws, reads just start returning other people's data`. Two finished
# statements with a comma between them, which reads as one sentence trying to
# hold both. Only pronouns and a couple of nouns that can't be anything but a
# subject, because `, the cache key` opens a list item just as often as a clause,
# and `both offsets` is a determiner before it's ever a pronoun.
SPLICE = re.compile(
    r",\s+(?:it|they|we|you|reads?|writes?|nothing|everything)\s+"
    r"(?:just|only|never|always|still|quietly|then|already)?\s*\w+\b",
    re.I,
)

# A leading subordinate or participial clause, where the comma closing it is the
# one the grammar asks for: `When the transaction finishes, nothing changes.`
LEADING_CLAUSE = re.compile(
    r"^(?:so\s+)?(?:when|if|once|after|before|while|until|unless|since|because|as|although"
    r"|though|given|assuming|whenever|now\s+that|even\s+(?:if|though)|\w+ing"
    # `To read a block, you have to find its entry.` A purpose clause, where the
    # comma closing it is the one the grammar asks for.
    r"|to\s+\w+)\b",
    re.I,
)


# `A GSI doesn't give you a cheap scan, it gives you a different key.` A denial
# answered by a pronoun picking the same subject back up, which is a contrast
# the comma is right for. Swapping in a fresh subject is what makes it sprawl.
CONTRAST = re.compile(
    r"(?:n['’]t\b|\b(?:not|never|no)\b)[^,]*,\s+(?:it|they|we|you)\b",
    re.I,
)


def comma_splice(sentence: str) -> str | None:
    """Flag a comma standing in for a full stop between two finished statements.

    A series is punctuated the same way, so `A, B, and C` is exempt, and so are
    a leading subordinate clause and a denial answered by the same subject.
    What's left is a new subject arriving with no conjunction to hang it off.
    """
    if is_series(sentence) or LEADING_CLAUSE.match(sentence) or CONTRAST.search(sentence):
        return None
    match = SPLICE.search(sentence)
    return match.group(0) if match else None


# ---------------------------------------------------------------- checks

def check_mechanical(post: Post, slugs: set[str]) -> list[Finding]:
    found: list[Finding] = []

    for key in ("title", "date", "categories", "tags"):
        if key not in post.frontmatter:
            found.append(Finding(1, "mechanical", "frontmatter", f"missing {key}"))

    if post.unbalanced_fence is not None:
        found.append(Finding(post.unbalanced_fence, "mechanical", "unbalanced-fence", "never closed"))

    for fence in post.fences:
        if not fence.info:
            found.append(Finding(fence.start, "mechanical", "fence-language", "no language id"))
        found.extend(check_diagram(fence))

    for number, text in enumerate(post.raw_lines, start=1):
        if text != text.rstrip():
            found.append(Finding(number, "mechanical", "trailing-space", repr(text[-12:])))

    for para in post.paragraphs:
        low = para.text.lower()
        for word in BANNED_WORDS:
            if re.search(rf"\b{re.escape(word)}\b", low):
                found.append(Finding(para.start, "mechanical", "banned-word", word))
        for pattern in BANNED_PHRASES:
            if re.search(pattern, low):
                found.append(Finding(para.start, "mechanical", "banned-phrase", pattern))
        for pattern, name in BANNED_STRUCTURES:
            if re.search(pattern, low):
                found.append(Finding(para.start, "mechanical", "banned-structure", name))
        if "\u2014" in para.raw:
            found.append(Finding(para.start, "mechanical", "em-dash", excerpt(para.raw, "\u2014")))
        if ";" in para.text:
            found.append(Finding(para.start, "mechanical", "semicolon", excerpt(para.raw, ";")))
        for match in re.finditer(r"`[^`]+`s\b", para.raw):
            found.append(Finding(para.start, "mechanical", "identifier-plural", match.group(0)))

    for run in post.lists:
        first = post.raw_lines[run.start - 1]
        if re.match(r"^\s*(?:\d+\.|[-*+])\s+\*\*[^*]+\*\*[:.]?\s", first):
            found.append(Finding(run.start, "mechanical", "bold-term-list", first.strip()[:60]))

    found.extend(check_links(post, slugs))
    found.extend(check_nav(post))
    return found


def check_links(post: Post, slugs: set[str]) -> list[Finding]:
    found: list[Finding] = []
    for number, text in enumerate(post.raw_lines, start=1):
        for match in LINK_RE.finditer(text):
            url = match.group(2)
            if url.startswith("/posts/"):
                if url.strip("/").split("/")[-1] not in slugs:
                    found.append(Finding(number, "mechanical", "dead-internal-link", url))
            elif "github.com" in url and "/blob/" in url:
                ref = url.split("/blob/")[1].split("/")[0]
                if not PINNED_REF.fullmatch(ref):
                    found.append(Finding(number, "mechanical", "unpinned-link", f"/blob/{ref}/"))
    return found


def check_nav(post: Post) -> list[Finding]:
    nav = [(n, t) for n, t in post.quote_lines if re.match(r"^\d+\.", t)]
    if not nav:
        return []
    self_marked = [t for _, t in nav if "(this post)" in t]
    if len(self_marked) != 1:
        return [Finding(nav[0][0], "mechanical", "nav-block", f"{len(self_marked)} entries marked (this post)")]
    found = []
    for number, text in nav:
        linked = LINK_RE.search(text) is not None
        if "(this post)" in text and linked:
            found.append(Finding(number, "mechanical", "nav-block", "this post links to itself"))
        if "(this post)" not in text and not linked:
            found.append(Finding(number, "mechanical", "nav-block", f"no link: {text[:40]}"))
    return found


def check_diagram(fence: Fence) -> list[Finding]:
    """Flag a vertical bar that misses what's drawn directly above and below it.

    A diagram is checked line by line rather than as one column histogram,
    because a stacked figure indents its lower boxes differently on purpose.
    Pooling every bar in the fence compares a write-cache wall at column 17
    against a read-cache wall at 19 two levels down and calls it a typo.

    A wall that really is off by a column has neither neighbour meeting it and
    has one of them a column or two to the side.
    """
    if not fence.is_diagram:
        return []
    occupied = [{i for i, ch in enumerate(text) if ch in BOX_CHARS} for text in fence.body]

    found: list[Finding] = []
    for offset, text in enumerate(fence.body):
        above = occupied[offset - 1] if offset else set()
        below = occupied[offset + 1] if offset + 1 < len(occupied) else set()
        for column, char in enumerate(text):
            if char != "│" or column in above or column in below:
                continue
            near = sorted(
                c for c in above | below if 0 < abs(c - column) <= 2
            )
            if near:
                found.append(
                    Finding(fence.start + 1 + offset, "mechanical", "box-column",
                            f"bar at col {column}, the line above or below draws at {near[0]}")
                )
    return found


def check_judgment(post: Post) -> list[Finding]:
    found: list[Finding] = []
    para_words: list[int] = []

    for para in post.paragraphs:
        parts = sentences(para.text)
        para_words.append(len(para.text.split()))
        low = para.text.lower()

        for pattern in SIGNPOSTS:
            if re.search(pattern, low):
                found.append(Finding(para.start, "judgment", "signpost", excerpt_re(para.text, pattern)))
        for pattern in READING_INSTRUCTIONS:
            if re.search(pattern, low):
                found.append(Finding(para.start, "judgment", "reading-instruction", excerpt_re(para.text, pattern)))

        for sentence in parts:
            words = len(sentence.split())
            if words > 35:
                over = "past 45" if words > 45 else "past 35"
                found.append(Finding(para.start, "judgment", "long-sentence", f"{words}w {over}  {short(sentence)}"))
            clauses = len(SUBORDINATORS.findall(sentence))
            if clauses >= 3:
                found.append(Finding(para.start, "judgment", "clause-chain", f"{clauses} clauses  {short(sentence)}"))
            commas = sentence.count(",")
            tail = sentence.rsplit(",", 1)[-1] if commas else ""
            if commas >= 3 and re.match(r"\s+(which|since|because|so)\b", tail):
                found.append(Finding(para.start, "judgment", "comma-pileup", f"{commas} commas  {short(sentence)}"))
            joints = clause_pileup(sentence)
            if joints >= 2:
                found.append(Finding(para.start, "judgment", "clause-pileup", f"{joints} joints  {short(sentence)}"))
            if splice := comma_splice(sentence):
                found.append(Finding(para.start, "judgment", "comma-splice", f"{splice.strip()}  {short(sentence)}"))
            if IMPERATIVE_CONDITIONAL.match(sentence):
                found.append(Finding(para.start, "judgment", "imperative-conditional", short(sentence, 76)))

        for pattern, contracted in contraction_hits(para.raw):
            found.append(Finding(para.start, "judgment", "uncontracted", f"{pattern} -> {contracted}"))

        if match := SELF_REFERENCE.search(para.text):
            found.append(Finding(para.start, "judgment", "self-reference", f"{match.group(0)}  {short(para.text, 58)}"))

        if parts and STATED_THEN_SOLVED.search(parts[0]):
            found.append(Finding(para.start, "judgment", "stated-then-solved", short(parts[0], 76)))

        if parts and len(parts) > 1 and announces_only(parts[0]):
            found.append(Finding(para.start, "judgment", "short-opener", f"{len(parts[0].split())}w  {parts[0]}"))
        if parts and parts[0].lower() in FILLER_OPENERS:
            found.append(Finding(para.start, "judgment", "filler-opener", parts[0]))

        run = 0
        for sentence in parts:
            run = run + 1 if len(sentence.split()) <= 12 else 0
            if run == 3:
                found.append(Finding(para.start, "judgment", "choppy-run", short(" ".join(parts))))

        for a, b in zip(parts, parts[1:]):
            if frame := parallel_definition(a, b):
                found.append(
                    Finding(para.start, "judgment", "parallel-definition",
                            f"both `X is {frame[0]}`  {short(a, 34)} / {short(b, 34)}")
                )
            if len(a.split()) <= 4:
                continue
            if len(b.split()) <= 3 and re.match(r"^(Not|Just|Zero|None|Never)\b", b):
                found.append(Finding(para.start, "judgment", "escalating-fragment", f"{short(a, 50)} / {b}"))
            elif negation_pivot(a, b):
                found.append(Finding(para.start, "judgment", "negation-pivot", f"{short(a, 50)} / {b}"))
            # A long sentence answered by a near-empty one, where the tail is
            # too short to have earned the full stop in front of it.
            elif len(parts) == 2 and len(a.split()) >= 14 and len(b.split()) <= 6:
                found.append(Finding(para.start, "judgment", "stub-tail", f"{len(b.split())}w tail  {short(a, 40)} / {b}"))

        flat = [s for s in parts if is_spec_sheet(s)]
        if len(flat) >= 3 and len(flat) >= len(parts) - 1:
            found.append(
                Finding(para.start, "judgment", "flat-structure",
                        f"{len(flat)} of {len(parts)} sentences  {short(flat[0], 60)}")
            )

        above = preceding_fence(post, para)
        if above is not None and parts:
            shared, share = diagram_echo(above, parts[0])
            if share >= 0.5 and len(shared) >= 3:
                found.append(
                    Finding(para.start, "judgment", "diagram-echo",
                            f"{share:.0%} of the sentence is diagram vocabulary: {', '.join(sorted(shared))}")
                )

    for section in post.sections:
        if section.words > 400:
            found.append(Finding(section.line, "judgment", "long-section", f"{section.words}w  {section.title}"))
        if section.opener.endswith("?"):
            found.append(Finding(section.line, "judgment", "rhetorical-heading", short(section.opener)))

    for fence in post.fences:
        para = following_paragraph(post, fence)
        if para is None:
            continue
        opening = para.text.lower()[:90]
        announces = re.search(r"\bhere'?s\s+(is\s+)?(the|what|an?|how)\b|\bwhat follows is\b", opening)
        if announces and not re.search(r"\bhere'?s\s+\w+ing\b", opening):
            found.append(Finding(para.start, "judgment", "announce-example", short(para.text, 70)))

    found.extend(check_colons(post))
    found.extend(check_paragraph_seams(post))
    found.extend(check_counted_lists(post))

    if len(para_words) >= 8:
        spread = statistics.pstdev(para_words) / statistics.fmean(para_words)
        if spread < 0.35:
            found.append(
                Finding(post.paragraphs[0].start, "judgment", "uniform-paragraphs",
                        f"spread {spread:.2f} across {len(para_words)} paragraphs")
            )
    return found


# `Statement: X, Y, and Z`. Three or more items, since the guide keeps the
# two-item colon and the single restatement that lands harder attached.
COLON_LIST_RE = re.compile(r"[^.:!?]{12,}:\s+[^.:!?]*,[^.:!?]*,[^.:!?]*[.!?]?$")

# A paragraph opening this way is finishing the previous paragraph's sentence
# rather than starting its own: "The VM isn't what anyone waits on." / "The disk is."
COMPLETION_OPENER = re.compile(
    r"^(?:"
    r"(?:the|this|that|these|those|it|they|there)\s+\w+\s+(?:is|are|was|were|does|do|did|isn'?t|doesn'?t)\.?$"
    r"|(?:which|and|but|so|then|except|unless|because|since)\b"
    r"|\w+\s+(?:is|are|was|were|does|do|did)\.$"
    r")",
    re.I,
)


def is_caption(para: Paragraph) -> bool:
    """A bare source link under a code block, not prose."""
    return LINK_RE.fullmatch(para.raw.strip()) is not None


def strands_the_opener(head: str) -> bool:
    """Whether this first sentence needs the paragraph above it to make sense."""
    if len(head.split()) > 8:
        return False
    # A colon makes the line a lead-in to the block below it, which is the
    # handoff the guide asks for rather than a fragment left stranded.
    if head.rstrip().endswith(":"):
        return False
    return COMPLETION_OPENER.match(head) is not None or announces_only(head)


def check_paragraph_seams(post: Post) -> list[Finding]:
    """Flag a paragraph break that lands mid-thought.

    The guide keeps a short punchy line at the end of a paragraph and rejects
    it at the start, so the seam worth reading twice is a long closing sentence
    followed by a fragment that only makes sense attached to it.
    """
    found: list[Finding] = []
    for previous, para in zip(post.paragraphs, post.paragraphs[1:]):
        if para.start - previous.end > 2:
            continue
        if is_caption(previous):
            continue
        closing = sentences(previous.text)
        opening = sentences(para.text)
        if not closing or not opening:
            continue
        head = opening[0]
        if not strands_the_opener(head):
            continue
        found.append(
            Finding(para.start, "judgment", "paragraph-seam",
                    f"{len(head.split())}w opener after {len(closing[-1].split())}w close: "
                    f"...{short(closing[-1], 44)} // {head}")
        )
    return found


def check_colons(post: Post) -> list[Finding]:
    """Flag `statement: X, Y, and Z` only once the post is over the guide's budget.

    Three or fewer is the shape working as intended, so the finding is the
    excess and the count that makes it excess.
    """
    hits = [
        (para.start, sentence)
        for para in post.paragraphs
        for sentence in sentences(para.text)
        if COLON_LIST_RE.search(sentence)
    ]
    if len(hits) <= 3:
        return []
    return [
        Finding(line, "judgment", "colon-statement", f"{len(hits)} in this post  {short(sentence)}")
        for line, sentence in hits
    ]


def preceding_fence(post: Post, para: Paragraph) -> Fence | None:
    for fence in post.fences:
        if fence.is_diagram and fence.end == para.start - 2:
            return fence
    return None


def following_paragraph(post: Post, fence: Fence) -> Paragraph | None:
    for para in post.paragraphs:
        if para.end == fence.start - 2:
            return para
    return None


NUMBER_WORDS = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}

# A count in the lead-in, ignoring the ones that are measurements rather than
# item counts, so `4 MiB chunks` above a four-item list doesn't match.
LEAD_COUNT = re.compile(
    r"\b(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b"
    r"(?!\s*(?:[KMGT]i?B|bytes?|bits?|blocks?|ms|s\b|%|-byte))",
    re.I,
)


def check_counted_lists(post: Post) -> list[Finding]:
    """Flag a bulleted list whose lead-in already told the reader how many.

    Naming the count is a promise the reader will be tracking against, and
    dashes make them do that counting themselves. It also means the items are
    an inventory rather than unordered peers, which is what numbers are for.
    """
    found: list[Finding] = []
    for run in post.lists:
        if run.numbered or run.items < 2:
            continue
        lead = next((p for p in post.paragraphs if p.end == run.start - 2), None)
        if lead is None:
            continue
        counts = set()
        for match in LEAD_COUNT.finditer(lead.text):
            token = match.group(1).lower()
            counts.add(NUMBER_WORDS.get(token) or (int(token) if token.isdigit() else 0))
        if run.items in counts:
            found.append(
                Finding(run.start, "judgment", "counted-bullets",
                        f"{run.items} bullets, lead names it  {short(lead.text, 52)}")
            )
    return found


STOPWORDS = set(
    "the a an and or of to in on at is are was were be been for it its this that with "
    "from by as but so then than them they their there here what when where which who "
    "whom whose while into onto over under each every both all any some none not no "
    "just only also same other another more most less least first second third next "
    "last one two three four page pages row rows new old post part parts index indexes "
    "thing things does done doing get gets got have has had can could will would "
    "you your we our".split()
)


def content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z_]{4,}", text.lower()) if w not in STOPWORDS}


def diagram_echo(fence: Fence, sentence: str) -> tuple[set[str], float]:
    """Shared vocabulary, and what share of the sentence the diagram already said.

    A sentence naming one term from the diagram above it is doing normal work.
    The guide's target is the sentence that walks the picture again, so the
    signal is overlap dominating the sentence, not overlap existing.
    """
    in_prose = content_words(sentence)
    if len(in_prose) < 4:
        return set(), 0.0
    shared = content_words(" ".join(fence.body)) & in_prose
    return shared, len(shared) / len(in_prose)


# ---------------------------------------------------------------- reporting

def excerpt(text: str, needle: str, width: int = 56) -> str:
    at = text.find(needle)
    start = max(0, at - width // 2)
    return ("..." if start else "") + text[start : start + width].strip() + "..."


def excerpt_re(text: str, pattern: str) -> str:
    match = re.search(pattern, text, re.I)
    return excerpt(text, match.group(0)) if match else short(text)


def short(text: str, width: int = 88) -> str:
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 3] + "..."


def display(path: Path) -> str:
    resolved = path.resolve()
    return str(resolved.relative_to(REPO)) if resolved.is_relative_to(REPO) else str(path)


def stats(post: Post) -> list[str]:
    parts = [s for p in post.paragraphs for s in sentences(p.text)]
    lengths = [len(s.split()) for s in parts] or [0]
    words = sum(len(p.text.split()) for p in post.paragraphs)
    numbered = [r for r in post.lists if r.numbered]
    bullets = [r for r in post.lists if not r.numbered]
    diagrams = [f for f in post.fences if f.is_diagram]
    first_heading = post.sections[0].line if post.sections else 10**9
    opening = [p for p in post.paragraphs if p.start < first_heading]
    opening_code = [f for f in post.fences if f.start < first_heading]
    prose = post.prose
    first_person = len(re.findall(r"\b(we|we'?re|we'?ve|our|ours|us|I|I'?m|I'?ve|my)\b", prose))
    second_person = len(re.findall(r"\b(you|you'?re|you'?ve|your)\b", prose))
    longest = max(post.sections, key=lambda s: s.words) if post.sections else None
    para_words = [len(p.text.split()) for p in post.paragraphs] or [0]
    openers = [sentences(p.text)[0] for p in post.paragraphs if sentences(p.text)]
    short_openers = sum(1 for s in openers if len(s.split()) < 9)
    colon_lists = sum(1 for p in post.paragraphs for s in sentences(p.text) if COLON_LIST_RE.search(s))

    out = [
        f"words {words}   sentences {len(parts)}   paragraphs {len(post.paragraphs)}"
        f"   sections {len(post.sections)}",
        f"sentence words   mean {statistics.fmean(lengths):.1f}   median {statistics.median(lengths):.0f}"
        f"   max {max(lengths)}   >35w {sum(1 for n in lengths if n > 35)}"
        f"   >45w {sum(1 for n in lengths if n > 45)}",
        f"paragraph words  mean {statistics.fmean(para_words):.1f}"
        f"   spread {statistics.pstdev(para_words) / max(statistics.fmean(para_words), 1):.2f}"
        f"   max {max(para_words)}",
        f"opening {len(opening)} paragraphs, {len(opening_code)} code blocks before the first heading",
        f"lists {len(numbered)} numbered / {len(bullets)} bullet   tables {post.tables}"
        f"   diagrams {len(diagrams)}   code blocks {len(post.fences) - len(diagrams)}",
        f"voice {first_person} first person / {second_person} second person"
        f"   contractions {len(CONTRACTION_RE.findall(prose))}",
        f"short openers {short_openers} of {len(openers)} paragraphs"
        f"   colon lists {colon_lists}   sections over 400w"
        f" {sum(1 for s in post.sections if s.words > 400)}",
    ]
    if longest:
        out.append(f"longest section {longest.words}w  {longest.title}")
    return out


GUIDE = {
    "frontmatter": "title, date, categories, tags (Formatting)",
    "unbalanced-fence": "opened and never closed",
    "fence-language": "use a language id (Formatting)",
    "trailing-space": "whitespace at end of line",
    "banned-word": "banned outright (Banned words)",
    "banned-phrase": "banned outright (Banned words)",
    "banned-structure": "mimics insight without providing any (Banned words)",
    "em-dash": "max one per response, commas or parens instead (Style)",
    "semicolon": "none in prose (Style)",
    "identifier-plural": "put the s outside the backticks (Style)",
    "dead-internal-link": "no post with that slug",
    "unpinned-link": "a branch ref moves, pin the SHA (Linking to source)",
    "nav-block": "series nav is inconsistent",
    "box-column": "space-align every column including the bars (ASCII diagrams)",
    "long-sentence": "past 35 words needs a reason (Sentence length)",
    "clause-chain": "three subordinate clauses is the ceiling (Sentence length)",
    "comma-pileup": "a comma you don't pause at (Commas)",
    "choppy-run": "three short sentences in a row (Voice and tone)",
    "short-opener": "keep it only if it carries a fact (Voice and tone)",
    "paragraph-seam": "a short line lands at the end of a paragraph, not the start (Voice and tone)",
    "colon-statement": "more than two or three per post wants a list (The colon habit)",
    "signpost": "don't announce that a section started (Structure)",
    "reading-instruction": "asks for patience instead of earning it (Handing off to an example)",
    "announce-example": "name the walkthrough, not the artifact (Handing off to an example)",
    "rhetorical-heading": "reads as filler under a heading (The colon habit)",
    "escalating-fragment": "state the number once (The colon habit)",
    "negation-pivot": "a denial answered by a bare-verb fragment (The colon habit)",
    "uncontracted": "contract it unless the long form is the emphasis (Style)",
    "clause-pileup": "the sentence restarts twice, so it's a list of statements (Sentence length)",
    "comma-splice": "a comma standing in for a full stop (Commas)",
    "parallel-definition": "one sentence carries the contrast (Commas)",
    "self-reference": "write about the subject, not about the post (Walking versus stating)",
    "stated-then-solved": "walk the reader through it, don't state and fix (Narrative flow)",
    "imperative-conditional": "say `if` and stop at one consequence (Voice and tone)",
    "stub-tail": "a tail too short to have earned the stop in front of it (Voice and tone)",
    "counted-bullets": "prose names the count, so number them (The colon habit)",
    "filler-opener": "banned opener (The colon habit)",
    "flat-structure": "rewrite around what a reader does with it (Commas)",
    "diagram-echo": "don't describe the diagram again (ASCII diagrams)",
    "long-section": "past 400 words is usually two sections (Section length)",
    "uniform-paragraphs": "uniform blocks are the strongest machine tell (Voice and tone)",
    "bold-term-list": "the most recognisable AI pattern (Structure)",
}


def wrap(text: str, width: int, indent: str) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        if current and len(current) + 1 + len(word) > width:
            lines.append(indent + current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(indent + current)
    return lines


def report(post: Post, findings: list[Finding], quiet: bool, show: bool) -> None:
    print(f"\n{display(post.path)}")
    if not quiet:
        for line in stats(post):
            print(f"    {line}")
    for kind in ("mechanical", "judgment"):
        group = [f for f in findings if f.kind == kind]
        if not group:
            continue
        print(f"\n    {kind}")
        for finding in sorted(group, key=lambda f: (f.label, f.line)):
            print(f"      L{finding.line:<5} {finding.label:<20} {finding.detail}")
            if not show:
                continue
            # The whole source line, wrapped, so the flag can be judged in
            # context instead of from the truncated detail above it.
            raw = post.raw_lines[finding.line - 1] if finding.line <= len(post.raw_lines) else ""
            for line in wrap(raw, 80, " " * 14):
                print(line)
            print()
    if not findings:
        print("\n    nothing flagged")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--quiet", action="store_true", help="findings only, no statistics")
    parser.add_argument("--show", action="store_true", help="print the source line under each finding")
    parser.add_argument("--labels", action="store_true", help="list every label with its guide section")
    args = parser.parse_args()

    if args.labels:
        for label, note in sorted(GUIDE.items()):
            print(f"{label:<22} {note}")
        return 0

    paths = args.paths or sorted(p for p in POSTS.glob("*.md") if p.name not in NOT_POSTS)
    missing = [p for p in paths if not p.is_file()]
    if missing:
        print(f"no such file: {', '.join(str(p) for p in missing)}", file=sys.stderr)
        return 2

    slugs = {p.stem[11:] for p in POSTS.glob("*.md") if p.name not in NOT_POSTS}
    posts = [parse(p) for p in paths]
    total: list[Finding] = []
    for post in posts:
        findings = check_mechanical(post, slugs) + check_judgment(post)
        total += findings
        report(post, findings, args.quiet, args.show)

    counts: dict[str, int] = {}
    for finding in total:
        counts[finding.label] = counts.get(finding.label, 0) + 1
    print(f"\n{len(posts)} posts, {len(total)} flagged lines")
    for label, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"    {count:<4} {label:<22} {GUIDE.get(label, '')}")
    print(
        "\nAdvisory. Every line above is a candidate, not a verdict, and a clean\n"
        "run says nothing about whether the writing is any good. Judge each one\n"
        "against _posts/AGENTS.md and keep the ones that read better as they are."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
