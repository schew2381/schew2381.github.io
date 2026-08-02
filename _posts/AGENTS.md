# Blog Post Style Guide

## Read these first

Before writing or editing any post, read these end to end. Not a summary
of them. The actual posts.

1. [Sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion)
2. [The Great Re-shard](https://www.notion.com/blog/the-great-re-shard)
3. [How Figma's databases team lived to tell the scale](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/)
4. [Why Uber switched from Postgres to MySQL](https://www.uber.com/us/en/blog/postgres-to-mysql-migration)
5. [Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket)
6. [From Monolith to Lakebase to LTAP](https://www.databricks.com/blog/lakebase-ltap-rethinking-database-storage)
7. [Why we built our background agent](https://builders.ramp.com/post/why-we-built-our-background-agent)
8. [How we made Ramp Sheets self-maintaining](https://ramplabs.substack.com/p/self-maintaining)

Read them for specific things, not as general inspiration. Every item
below is a decision you have to make in your own draft, so read to find
out how they made it.

For a post about internals, 5 and 6 are the closest match in genre. Magic
Pocket walks a storage system from requirements down to protocols, and
the Lakebase post argues one design against another, which is the shape
of anything comparing two engines.

**How the opening earns the reader's attention.** Count the beats before
their first heading. Every one of them lands between three and five, and
none of those beats is a definition. Notion opens on a five-minute
maintenance window that a user tweeted about. Uber opens on the
architecture they moved off and why. Lakebase opens on a PhD advisor
telling the author that databases were fragile and hard to scale. Watch
how little mechanism they explain up there, and how willing they are to
gesture at it in half a sentence and move on.

**How much they defer.** Figma's opening mentions vertical partitioning
and caching in one breath and doesn't explain either until roughly 40%
into the post. Magic Pocket names erasure coding, volumes, cells, and
OSDs in its setup and doesn't draw the architecture until past halfway.
Lakebase names SafeKeeper and PageServer in a roadmap sentence and gets
to them 1,500 words later. The opening's job is to make the reader want
the mechanism, not to deliver it.

**How intuition gets built.** Uber walks through updating one row's
birth year, in full, before ever saying "write amplification". Lakebase
describes appending a description of a change to a sequential log before
calling it a write-ahead log. Magic Pocket explains what an OSD does
before the acronym means anything. The concrete case comes first and the
name for it comes after, so the reader meets the term already knowing
what it refers to. When they do name something first, a problem
statement comes before it.

**How a new section opens.** Read the first sentence under each heading.
The distribution is problems, callbacks, bare facts, and the occasional
definition when the section exists to define one thing. Not one
rhetorical question across all eight posts. Figma's sections open by
shifting off what the previous one established, and Lakebase's callbacks
go further back than the section immediately above.

**How they use "we".** Notion and Figma both run past 30 instances,
Magic Pocket lands near 40, and both Ramp posts sit in the twenties. It's
doing work every time: a decision got made, an option got rejected, a
thing broke on somebody. The Notion line about how clicking the RDS
resize button forever isn't a strategy tells you vertical scaling was
considered and dropped, and it sounds like a person said it.

**How willing they are to say what they think.** Lakebase calls one
paper its favorite and warns you another is punishing to read. Ramp
admits teams hate owning observability, themselves included. An opinion
with a person behind it is the thing a generated draft never has, and
it costs one clause.

**How they break up prose.** Count their lists. Notion, Figma, and Uber
run two to six numbered lists and eight to twelve bullet lists. The
other four barely number anything and run two to seven bullet lists,
with Magic Pocket almost pure prose. What holds across all of them is
what goes in a list: parallel items, meaning steps in a sequence,
constraints, options rejected, failure modes, capability inventories.
Explanations stay in prose. Don't manufacture lists to hit a count,
and don't cram parallel items into a sentence with a colon because the
draft has no lists yet.

**Where numbers live.** In sentences, not only in tables. "600
connections to each shard" reads better inside the sentence explaining
where the number came from. Ramp gets a whole post's thesis out of one
monitor per 75 lines of code, and Magic Pocket paces its scale story
from petabytes up to exabytes rather than opening on the big number.

**How sections hand off.** They end on a consequence, a decision, or a
question the next section answers, not on a restatement of what the
section just said. Ramp Sheets is the cleanest version: each section's
weakness is the next section's premise, so the post reads as one attempt
after another rather than a tour of finished parts.

**How a comparison gets structured.** Lakebase is the one to copy for
anything weighing two designs. It doesn't alternate pros and cons. The
old design's problems come first, then what the new one does about them,
then what that unlocks, so the reader is always being handed the next
consequence instead of scoring a tie. When it does critique a rival
approach, it names three specific deficiencies rather than calling the
approach worse.

## Narrative flow (the thing most drafts get wrong)

A post is a walk through a problem, not a reference page. The test:
read any two consecutive paragraphs and ask why the second one follows
the first. If the only answer is "it's the next fact," the draft is a
list wearing prose.

Fixes that work:

- Ask the reader's next question, then answer it. After explaining that
  a header maps virtual offsets to builds, the reader wonders what
  happens at a boundary. Answer that next, not something unrelated.

- Carry a consequence forward. End on what the mechanism costs or
  enables, and open the next section on the thing that cost forces.

- Name the problem before the machinery. "One HTTP round trip per 4 KiB
  block is unusable, so the chunker works in 4 MiB units" beats
  "the chunker works in 4 MiB units."

Signs a section reads like a fact dump:

- Consecutive paragraphs that each introduce an unrelated struct or flag.
- Prose immediately after a diagram that describes the diagram again.
- Sentences that could be reordered without the reader noticing.

## Voice and tone

Conversational, like explaining something to a sharp friend, without
getting too casual. Dry humor over exclamation marks. Honest about
limitations, because nothing is actually perfect and pretending
otherwise reads as marketing.

First person is fine and usually better. "We hardcoded streaming and
deleted the flag" tells the reader a person made a choice. "The
streaming chunker is the only chunker" tells them a fact fell out of
the sky.

Be direct and have opinions. State the point first, then support it.
Use specific examples and names instead of vague claims, and trust the
reader to recognise what matters without labelling it "significant" or
"important."

Vary the rhythm deliberately. Uniform paragraphs of uniform length are
the strongest tell that a machine wrote something.

A short punchy line lands mid-paragraph or at the end, where it closes
something off. It often fails at the *start* of a paragraph, where it
reads as throat-clearing before the real sentence arrives:

```
BAD:  The bill arrives on the second call. Every read has to check the
      bitmap first, which the fast path skips entirely.

GOOD: The bill arrives on the second call, where every read has to
      check the bitmap first, which the fast path skips entirely.
```

Before keeping a short opener, check that it carries a fact the
paragraph needs instead of announcing that a fact is coming. A short
line that states the paragraph's whole claim stays. "Not free, though."
and "Nothing warns you." only announce, so they fold into the sentence
after them.

## Sentence length

Folding a throat-clearing opener into the next sentence fixes that one
sentence. It isn't a license to keep going. The failure on the other
side is a sentence that swallows the whole paragraph:

```
BAD:  `LP_DEAD` is the tombstone that makes it workable, since the
      tuple body is gone and its bytes reclaimed while the slot number
      stays reserved, so an index entry still pointing there lands on
      something well-defined instead of a stranger's row, which buys
      vacuum time to go clean the indexes across three phases.

GOOD: `LP_DEAD` is the tombstone that makes it workable. The tuple body
      is gone and its bytes are reclaimed, but the slot number stays
      reserved, so an index entry still pointing there lands on
      something well-defined instead of a stranger's row. That's what
      buys vacuum time to clean the indexes.
```

Both carry the same facts. The first makes the reader hold all of them
at once to find out which one the sentence was about, and the second
lets them bank each one and move on.

Rough ceilings, not laws:

- Past 35 words a sentence needs a reason to be that long, and past 45
  there usually isn't one.
- Two subordinate clauses reads fine. Three is the ceiling, and a chain
  of "since ... so ... which ..." has already gone past it.
- One consequence per sentence. When a "so" or a "which" introduces
  something the reader has to reason about rather than just absorb,
  that's the next sentence.

Split at the joint carrying the most weight and keep every fact.
Deleting words isn't the fix, because the problem is that the reader
has nowhere to breathe rather than that they've been told too much.

## Commas

Every comma is a small stop, so a sentence carrying several of them
reads choppy even at the right length. The usual culprit is a comma in
front of a trailing clause that just finishes the thought:

```
BAD:  When an update qualifies, Postgres writes the new version and
      touches no indexes at all, which is the mechanism called a
      Heap-Only Tuple.

GOOD: When an update qualifies, Postgres writes the new version and
      touches no indexes at all which is the mechanism called a
      Heap-Only Tuple.
```

Read the line out loud. If you don't pause where the comma is, drop it.

Describing a structure is where prose goes stiff, because a run of flat
subject-verb-object statements about what a thing contains reads like a
spec sheet even when every fact in it is right:

```
BAD:  The header stores a metadata block and a build map. The metadata
      is 64 bytes. The build map has one 40-byte entry per range.

GOOD: The header opens with 64 bytes of metadata and then just repeats
      a 40-byte entry per range, so reading it is a matter of skipping
      the first block and treating the rest as an array.
```

What made the first one stiff was the flat "X contains Y" framing, not
the sentence count. Write the structure through what somebody using it
does with it, and the facts stop needing to be stacked side by side.

End sections with a practical takeaway when there is one. Don't
manufacture one when there isn't.

## The colon habit

`Statement: X, Y, and Z` is a good sentence shape. It stops being one
around the third time a reader meets it, and a draft that leans on it
reads like every idea arrives in the same package.

Count them before shipping. More than two or three per post and the
extras want to be real lists:

```
BAD:  Everything else in this post is downstream of that one sentence:
      what a connection costs to open, how much memory it holds while
      doing nothing, what happens to the others when one crashes, and
      which knob is the right one when you hit the wall.

GOOD: Everything else in this post is downstream of that one sentence.

      - What a connection costs to open.
      - How much memory it holds while doing nothing.
      - What happens to the others when one crashes.
      - Which knob is the right one when you hit the wall.
```

Four parallel items is a list. The colon version makes the reader hold
all four in one sentence to find out there was no fifth.

Numbered when the items carry an order (steps, a preference ranking, a
try-this-then-that). Dashes when they're unordered peers.

Reach for a list more often than feels necessary. Every example post runs
at least two bullet lists and most run more, so a draft with two lists
across five posts is hiding all that structure inside sentences.

Keep the colon for the cases where it's doing something a list can't:
two items rather than three, or a single restatement that lands harder
attached (`No partial credit: either no index is touched or all of them
are`).

Things to avoid, on top of the banned lists below:

- Rhetorical questions as section openers ("How does X work?"). A
  question in the post's opening hook is fine and often better than an
  assertion. Under a heading, it reads as filler.
- Tutorial voice ("Let's explore...", "Consider a scenario where..."). A
  "let's" naming the actual work is fine, because "let's follow one
  update through both engines" tells the reader what happens next. "Let's
  explore how updates work" only tells them a section started.
- Filler openers ("Simple.", "Surprisingly.", "Interestingly.").
- Overly formal or corporate register.
- Generic advice with no specific, actionable example attached.
- Excessive enthusiasm. Nothing is amazing or incredible.
- Bullet points for explanations. Bullets are for genuinely parallel
  items (flags, files, error codes, steps, failure modes), and there are
  usually more of those in a draft than the draft noticed.
- Closing with a call to action or a wrap-up.
- Escalating fragments for emphasis. `Not fewer. Zero.` and its family
  (`Not slower. Broken.`) are the loudest AI tell in the guide. The
  fragments add no fact, they just repeat the previous sentence at
  higher volume. State the number once and let it sit:

```
BAD:  Heap-Only Tuples: when an update qualifies, Postgres writes the
      new version and touches zero indexes. Not fewer. Zero.

GOOD: When an update qualifies, Postgres writes the new version and
      touches no indexes at all, which is the mechanism called a
      Heap-Only Tuple.
```

## Linking to source

Link to open-source code only. For E2B, that means
[e2b-dev/infra](https://github.com/e2b-dev/infra) and nothing else.

Never link to a private or internal repository. Describe the mechanism
and quote the code inline instead, with no permalink and no repo name in
the URL. A reader who can't open the link gains nothing from seeing it.

## Openings

The opening's only job is to make the reader want the mechanism. It is
not the place to deliver it.

Three beats, four at the outside:

1. The hook. A question worth asking, a symptom, an error message, a
   number, or something that broke on somebody.
2. Why it happens, at altitude. One or two sentences that gesture at
   the cause without teaching it.
3. What the post walks through, said plainly. If there's an example
   table or a command the rest of the post uses, show it here.

Beat 2 is where drafts fail, because explaining the mechanism properly
feels like being helpful. It isn't, if a later section is already going
to do it. Name the thing, say roughly what it means, and get out:

```
BAD:  InnoDB keeps the table inside the primary key index, an
      arrangement called a clustered index, so the index and the table
      are the same B+Tree with the rows sitting in its bottom level.
      Postgres keeps rows in a heap, an unordered pile of pages, and
      every index is a separate structure pointing back into that pile,
      primary key included. That one split decides how fast each kind
      of read is, what an update costs, and how both engines age over
      months in production.

GOOD: The answer comes down to where each engine physically puts the
      row. MySQL stores it inside the primary key index, and Postgres
      stores it in an unordered pile with the indexes pointing at it
      from outside.
```

The BAD version teaches B+Tree leaf layout, defines two terms, and
lists three consequences before the reader has any reason to care. The
GOOD version says where rows live in two clauses and gets to the
example. The section below it is going to draw the B+Tree anyway.

A question as the hook works well and reads more naturally than an
assertion the reader has no reason to trust yet. "What happens if you
run these two queries against both engines?" invites them in. "Whoever
told you one of these is faster benchmarked one of these two queries"
tells them they've been lied to by somebody, which is a strange way to
start.

### Handing off to an example

Beat 3 is a handoff, and the way to blow it is to announce the artifact
instead of the work. "Here's the table for the rest of the post" and
"Here's what that costs each of them" point at the thing on screen and
stop there, which leaves the reader to guess what they're supposed to
do with it.

Say what the post does with the example instead, in one sentence, using
the verbs the post is actually about:

```
BAD:  Everything below follows from that, and it's worth going slowly.

      Here's the table for the rest of the post:

GOOD: So let's walk both engines through the table below, storing these
      two rows and then answering those two queries against them.
```

The GOOD version names the walkthrough (store, then query), so the
reader arrives at the schema already knowing what's about to happen to
it. It also drops "it's worth going slowly", which is a promise about
the post rather than a fact in it.

Two related lines to cut on sight:

- Stage directions. "Here's an example small enough to trace by hand"
  and "Two mechanisms have to come first" describe the post's layout.
- Reading instructions. "It's worth going slowly" and "bear with me"
  ask for patience instead of earning it.

### Openings in a series

Every post after the first opens by building on the last one. The shape
that works, and the shape Notion and Figma both use:

> In [Part N](link) we covered X. Now what happens when Y?

The callback is one sentence and it points at a specific thing the
previous post established, not at the previous post in general. Then
the question, which is the actual hook. Then the walkthrough.

Lakebase runs the same move between sections rather than between posts,
and it's worth stealing at either scale: acknowledge what the previous
piece settled, then pivot on the thing it didn't. "Everything so far has
been about one database" is a callback and a scope change in one clause.

Don't re-explain the previous post. A reader who skipped it can follow a
one-sentence reminder, and a reader who didn't will resent the recap.

Don't open a sequel on a bare assertion or a fresh unrelated symptom.
The reader arrived from the last post, so use that.

## Structure

An overview with a visual summary comes after the opening if the process
has many steps, then the detailed walkthrough, and the post ends on
trade-offs or practical implications rather than a "conclusion."

- Vary paragraph and sentence length. Don't write uniform blocks.
- Never use the "Bold term: explanation sentence" list format. It's the
  single most recognisable AI pattern.
- Don't signpost ("Let's explore," "Now let's turn to"). Just make your point.
- Don't close with a summary or inspirational wrap-up. End on substance.
- Don't restate the question back before answering it.

## Formatting

Frontmatter:

```yaml
---
title: "Title Here"
date: YYYY-MM-DD HH:MM:SS -0800
categories: [category1, category2]
tags: [tag1, tag2, tag3]
---
```

- Use code blocks with the correct language identifier (`sql`, `c`, `python`).
- Use tables for comparisons.
- Keep each section focused on one concept.
- Section names should be short and descriptive, not clever.

## ASCII diagrams

Default to more of them than feels necessary. A reader gets the shape of
a system from a diagram in one glance and from a paragraph in thirty
seconds, so any paragraph describing a layout, a path through
components, or a before-and-after should probably have one beside it.

Space-align every column, including the `|` characters.

The rule most drafts break: **one diagram per step, not one per
section.** When a section walks through a sequence, every step that
changes the state gets its own picture. A single diagram of the final
state makes the reader infer the intermediate ones, which is the work
the diagram was supposed to do for them.

```text
BAD, one diagram for a three-step process:

  final state, after all three steps
  ┌──────────────────────────┐
  │ slot 1: free             │
  └──────────────────────────┘

GOOD, the state after each step:

  step 1: mark              step 2: unlink           step 3: release
  ┌────────────────┐        drop every pointer       ┌────────────────┐
  │ slot 1: dead   │        aimed at slot 1          │ slot 1: free   │
  └────────────────┘        ──> nothing references   └────────────────┘
                                it anymore
```

Pick whatever shape carries the idea with the least ceremony. Shapes
that tend to work:

- Before and after, side by side, when something mutates in place.
- A numbered trace of one request, one line per hop.
- Two labelled columns comparing the same operation across two systems.
- A pointer or box-and-arrow diagram when the point is what references
  what.
- A layered stack with horizontal rules for a boundary that matters
  (process, kernel, network), so crossing it is visible.
- An indented tree for a directory, a key layout, or a config
  hierarchy.
- A byte or block layout when offsets and sizes are the content.

Uppercase headers inside a diagram are fine for labelling regions
(`PER POD, private`), and so are trailing right-margin annotations that
say what a row costs or where it lives. Both beat a paragraph
underneath explaining the same thing.

Don't describe the diagram again in the prose below it. Say what it
costs or what it implies, and move on.

## Banned words

Never use these, they are the most flagged AI-writing markers:

delve, dive into, navigate (figurative), underscore, bolster, foster, harness, leverage, unpack, shed light on, pave the way, pivotal, groundbreaking, cutting-edge, transformative, game-changing, innovative, robust, comprehensive, seamless, intricate, nuanced (as empty praise), vibrant, multifaceted, holistic, testament, landscape (figurative), realm

Never use these phrases:

- "In today's [fast-paced/rapidly evolving/digital] world..."
- "It's important/worth noting that..."
- "One of the most [important/significant/crucial]..."
- "When it comes to..." / "At its core..." / "At the end of the day..."
- "This is where X comes in" / "Let's break it down"
- "Plays a crucial role in..." / "It cannot be overstated..."
- "...underscoring the importance of..." / "...highlighting the need for..."
- "...reflecting a broader trend toward..." / "...marking a significant shift in..."

Never use these structures:

- "It's not just X — it's Y"
- "Not only X, but Y"
- "This isn't about X. It's about Y."
- "No X. No Y. Just Z."

These mimic insight without providing any.

## Style

- Use contractions. "It's," "don't," "won't."
- Maximum one em dash per response. Use commas or parentheses instead.
- No semicolons in prose.
- Pluralize a backticked identifier with an apostrophe outside the
  backticks: `UPDATE`'s, `SELECT`'s, `Overlay`'s. A bare trailing `s`
  reads as part of the identifier.
- Don't over-format. Explanations belong in prose, and parallel items
  belong in lists, so a draft can be wrong in either direction.
- Drop preamble ("Great question!"), performative enthusiasm ("exciting,"
  "incredible," "powerful"), and unsolicited caveats.
- Match tone to context. Casual question, casual answer.

## Process

- Work section by section. Don't generate a full draft in one pass.
- Ask clarifying questions when the topic or scope is unclear.
- Flag anything that reads as generic so it can be fixed rather than shipped.

## Section length

A section that runs past roughly 400 words is usually two sections or
one section with a paragraph of setup it doesn't need. Split it or cut
it, and prefer cutting.

Detail is not the thing to cut. The cuts that don't cost anything:

- A sentence that restates the diagram above it.
- A transition explaining what the section is about to do.
- The second example, when the first one already landed.
- A caveat nobody asked for.

Trim the connective tissue and keep every fact. If the word count won't
come down without losing a mechanism, the section wanted splitting.

## Before finishing, check:

1. Read it out loud. Does any sentence sound like a press release? Rewrite it.
2. Are you repeating the same point in different words? Say it once.
3. Count the beats before the first heading. More than four, or any beat
   that teaches a mechanism a later section covers, and the opening is
   doing the post's job for it.
4. Does the line above an example say what the post does with it, or just
   that it's there? "Here's the table" and "here's what it costs" are
   both the second thing. Name the walkthrough instead.
5. In a series, does the opening name a specific thing the previous post
   established and then ask what's next? If it opens on a bare assertion
   instead, rewrite it as a callback plus a question.
6. Count the `statement: X, Y, and Z` sentences. More than two or three
   and the extras want to be numbered or bulleted lists.
7. Count the lists. Fewer than two or three per post means parallel items
   are hiding inside sentences.
8. Does any paragraph open on a sentence under nine words that only
   announces what's coming? Fold it into the sentence after it.
9. Does any sentence run past 35 words or chain three subordinate
   clauses? Split it at the joint carrying the most weight.
10. Read for commas you don't pause at, especially before a trailing
    `, which`. Drop them.
11. Any escalating fragments for emphasis (`Not fewer. Zero.`)? Delete
    them and state the fact once.
12. Does any step-by-step explanation have one diagram where it should
    have one per step?
13. Read every paragraph that describes a structure. If it's a run of
    flat "X contains Y" statements, rewrite it around what a reader does
    with the structure.
