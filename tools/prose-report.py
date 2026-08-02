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
CODE_SPAN_RE = re.compile(r"`[^`]+`")
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
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
        if tail and not re.match(r"[\"')\]]*\s+[A-Z\"'(\u201c]", tail):
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
    r"let's (explore|examine|take a look|dive)", r"now let's turn",
    r"consider a scenario", r"in this section", r"we'll (look at|explore|cover)",
    r"as (we|you) (can see|mentioned earlier)", r"first, let's",
]

READING_INSTRUCTIONS = [
    r"worth going slowly", r"bear with me", r"stay with me",
    r"it's worth noting", r"as we'll see", r"\bread on\b",
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
                if not re.fullmatch(r"[0-9a-f]{40}", ref):
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
    if not fence.is_diagram:
        return []
    found: list[Finding] = []
    columns: dict[int, int] = {}
    per_line: list[tuple[int, list[int]]] = []
    for offset, text in enumerate(fence.body):
        positions = [i for i, ch in enumerate(text) if ch == "│"]
        if positions:
            per_line.append((fence.start + 1 + offset, positions))
            for position in positions:
                columns[position] = columns.get(position, 0) + 1

    popular = {c for c, n in columns.items() if n >= 3}
    for number, positions in per_line:
        for position in positions:
            if position in popular:
                continue
            near = [c for c in popular if 0 < abs(c - position) <= 2]
            if near:
                found.append(
                    Finding(number, "mechanical", "box-column",
                            f"bar at col {position}, {near[0]} elsewhere in the diagram")
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
            if len(b.split()) <= 3 and re.match(r"^(Not|Just|Zero|None|Never)\b", b) and len(a.split()) > 4:
                found.append(Finding(para.start, "judgment", "escalating-fragment", f"{short(a, 50)} / {b}"))

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
