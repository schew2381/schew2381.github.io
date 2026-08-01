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

## Tone

```yaml
---
title: "Title Here"
date: YYYY-MM-DD HH:MM:SS -0800
categories: [category1, category2]
tags: [tag1, tag2, tag3]
---
```

## Voice and tone

Conversational, like explaining something to a sharp friend, without
getting too casual. Dry humor over exclamation marks. Honest about
limitations, because nothing is actually perfect and pretending
otherwise reads as marketing.

First person is fine and usually better. "We hardcoded streaming and
deleted the flag" tells the reader a person made a choice. "The
streaming chunker is the only chunker" tells them a fact fell out of
the sky.

Vary the rhythm deliberately. A short punchy line lands only when the
sentences around it are longer. Uniform paragraphs of uniform length
are the strongest tell that a machine wrote something.

End sections with a practical takeaway when there is one. Don't
manufacture one when there isn't.

More things to avoid, on top of the banned lists below:

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

## Process

- Work section by section. Don't generate a full draft in one pass.
- Ask clarifying questions when the topic or scope is unclear.
- Flag anything that reads as generic so it can be fixed rather than shipped.

## Tone

- Direct and concise. State facts and move on.
- No rhetorical questions ("How does X work?", "What happens when...?").
- No lecturing or tutorial voice ("Let's explore...", "Consider a scenario where...").
- No filler words ("Simple.", "Surprisingly.", "Interestingly.").
- Write like notes for a sharp colleague, not a classroom lecture.

## Formatting

- Use code blocks with the correct language identifier (`sql`, `c`, `python`, etc.).
- Use ASCII diagrams/visualizations where they clarify a process or architecture.
- Use tables for comparisons.
- Use links to source code where appropriate (e.g., GitHub permalink to the relevant line).
- Keep sections focused — one concept per section.
- Section names should be short and descriptive, not clever.

## Structure

- Open with a short (1-2 sentence) statement of what the post covers and why it matters.
- Include an overview section with a visual summary for complex multi-step processes.
- Detailed walkthrough follows the overview.
- End with trade-offs or practical implications, not a "conclusion" section.

## Voice

Be direct. Have opinions. Use specific examples and names, not vague claims. State your point first, then support it. Trust the reader to recognise what matters without labelling it as "significant" or "important."

## Banned words

Never use these — they are the most flagged AI-writing markers:

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

## Writing Structure

- Vary paragraph and sentence length. Don't write uniform blocks.
- Never use the "Bold term: explanation sentence" list format. It's the single most recognisable AI pattern.
- Don't signpost ("Let's explore," "Now let's turn to"). Just make your point.
- Don't open with a sweeping contextual statement. Don't close with a summary or inspirational wrap-up. Start and end on substance.
- Don't restate the question back before answering it.

## Style

- Use contractions. "It's," "don't," "won't."
- Maximum one em dash per response. Use commas or parentheses instead.
- Don't over-format. Plain prose is often clearer than headers and bullet points.
- Drop preamble ("Great question!"), performative enthusiasm ("exciting," "incredible," "powerful"), and unsolicited caveats.
- Match tone to context. Casual question, casual answer.

## Before finishing, check:

1. Read it out loud. Does any sentence sound like a press release? Rewrite it.
2. Are you repeating the same point in different words? Say it once.
3. Does your opening sentence set the scene with a grand statement about the state of the world? Delete it, start with the second sentence.
