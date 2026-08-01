# Blog Post Style Guide

## Read these first

Before writing or editing any post, read all four of these end to end.
Not a summary of them. The actual posts, for the narrative flow.

1. [Sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion)
2. [The Great Re-shard](https://www.notion.com/blog/the-great-re-shard)
3. [How Figma's databases team lived to tell the scale](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/)
4. [Why Uber switched from Postgres to MySQL](https://www.uber.com/us/en/blog/postgres-to-mysql-migration)

What to copy from them:

- They open on a concrete moment, not a definition. A specific date, a
  specific incident, a specific number. The reader knows within one
  sentence that something actually happened to someone.

- They motivate before they explain. The reader learns why a mechanism
  has to exist before learning what it is. Uber walks through Postgres's
  on-disk row layout only after establishing that write amplification hurt
  them, so the reader arrives at the mechanism already wanting it.

- They use "we" and they have a stake in the outcome. The Notion post
  jokes that clicking the RDS resize button forever isn't a strategy.
  That line does real work: it tells you vertical scaling was considered
  and rejected, and it sounds like a person.

- Every section hands off to the next. Sections end on a consequence, a
  decision, or a question the next section answers. They don't end by
  restating what the section just said.

- Numbers live in sentences, not just tables. "600 connections to each
  shard" reads better inside the sentence explaining where it came from.

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
something off. It usually fails at the *start* of a paragraph, where it
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

The fix isn't shorter sentences. Write the structure through what
happens to somebody using it, and let each sentence earn the next one
with a "so" or a "which" instead of stacking facts side by side.

End sections with a practical takeaway when there is one. Don't
manufacture one when there isn't.

Things to avoid, on top of the banned lists below:

- Rhetorical questions as section openers ("How does X work?").
- Tutorial voice ("Let's explore...", "Consider a scenario where...").
- Filler openers ("Simple.", "Surprisingly.", "Interestingly.").
- Overly formal or corporate register.
- Generic advice with no specific, actionable example attached.
- Excessive enthusiasm. Nothing is amazing or incredible.
- Bullet points in narrative sections. Bullets are for genuinely
  parallel items (flags, files, error codes), not for explanations.
- Closing with a call to action or a wrap-up.

## Linking to source

Link to open-source code only. For E2B, that means
[e2b-dev/infra](https://github.com/e2b-dev/infra) and nothing else.

Never link to a private or internal repository. Describe the mechanism
and quote the code inline instead, with no permalink and no repo name in
the URL. A reader who can't open the link gains nothing from seeing it.

## Structure

Open with a short statement of what the post covers and why it matters,
then an overview with a visual summary if the process has many steps.
The detailed walkthrough follows the overview, and the post ends on
trade-offs or practical implications rather than a "conclusion."

Keep the opening to three beats at most before the first heading: the
concrete moment, why it happens, and the setup the reader needs to
follow along. Openings go awkward by stacking beats instead of adding
them up. A draft that shows a symptom, names the cause, defines every
component, states the stakes, and then announces that an example is
coming has spent five beats saying "here is a post about X."

Cut the announcement lines first. "Here's an example small enough to
trace by hand" and "Two mechanisms have to come first" are stage
directions, not content. Just show the example.

- Vary paragraph and sentence length. Don't write uniform blocks.
- Never use the "Bold term: explanation sentence" list format. It's the
  single most recognisable AI pattern.
- Don't signpost ("Let's explore," "Now let's turn to"). Just make your point.
- Don't open with a sweeping contextual statement, and don't close with a
  summary or inspirational wrap-up. Start and end on substance.
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
- Don't over-format. Plain prose is often clearer than headers and bullet points.
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
3. Does your opening sentence set the scene with a grand statement about the
   state of the world? Delete it, start with the second sentence.
4. Does any paragraph open on a sentence under nine words that only
   announces what's coming? Fold it into the sentence after it.
5. Does any step-by-step explanation have one diagram where it should
   have one per step?
6. Read every paragraph that describes a structure. If it's a run of
   flat "X contains Y" statements, rewrite it around what a reader does
   with the structure.
