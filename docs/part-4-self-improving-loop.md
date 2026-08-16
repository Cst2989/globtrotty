---
title: "AI Agents: The Self-Improving Loop"
excerpt: "The agency plans, the harness protects, the evals grade. One thing is still missing: the agency that plans her fourth trip is exactly as good as the one that planned her first. Users have been telling us how to improve the whole time, with every approve, edit, and reject. This part builds the loop that listens."
publishDate: 2026-09-02
image: "~/assets/images/articles/production-ai-agents-loop.png"
category: "AI"
readTime: "14 min"
tags: ['AI', 'Agents', 'LLM', 'Feedback', 'Learning', 'Data']
---

In part 3, we built the evals: gates, golden trips, trajectory checks, and judges calibrated against her decisions. They hold the floor. A bad deploy gets caught, a drifting model gets a number to beat.

Holding the floor is not rising. The agency that plans her fourth trip today is exactly as good as the one that planned her first. That's a strange kind of product, because she's been teaching it the whole time.

Every proposal came back with an approve, an edit, or a reject. Every edit named the exact thing that was wrong: she swapped the hotel, she moved the dates, she killed the layover. Every booking either matched what we proposed or diverged from it, and the divergence is a measurement.

All of that is sitting in the proposals table, from part 2's schema, unused. This part spends it.

## The signal we already collect

The reason we can build a learning loop at all is one foreign key we wrote back in part 2: `bookings.proposal_id`, plus the `decision` column on proposals.

<!-- REVIEW(globetrotty) — this section assumes the product OWNS the booking, and a large
     share of readers building on this series won't. Anyone who hands off to a supplier —
     affiliate, metasearch, referral — never writes a bookings row at all, and the article's
     own "capture at the moment or never" rule then bites harder, not softer: the conversion
     is reported back by the affiliate network days later, keyed ONLY by whatever sub-id was
     embedded in the outbound URL. If that id isn't minted and stored before the link is
     built, the commission arrives with no way to join it to a proposal, a prompt version, or
     a traveller — and it cannot be reconstructed afterwards.
     Worth a paragraph, because the fix is three lines and the failure is silent: mint the
     click id first, embed it as the sub-id, store the exact string you sent (networks mangle,
     truncate, and lowercase parameters), and create the conversions table on day one even
     though it stays empty for weeks. Also worth saying plainly that a CLICK IS NOT A
     CONVERSION — a link-out product that treats click-through as its success signal is
     measuring the attractiveness of a link, not the quality of a trip. -->


That link has a property that makes it precious: it can only be recorded at the moment it happens. When she books, we know which proposal the booking came from. A week later, the booking exists, the proposals exist, and nothing ties them together, so the capture is a write at booking time or it's nothing. I call it the provenance link, the same idea as part 2's provenance check, pointed backwards: not "where did this price come from" but "where did this booking come from."

With the link in place, the signals rank themselves by how much they say.

**Her decision labels say the most per row.** Approve is a graded example of what she wanted. Reject is a graded example of what she didn't. Both were produced while she did the thing she came to do, which makes them worth more than any rating widget, because a widget asks for extra work and gets noise.

**Her edits say what was almost right.** An approved-with-edits proposal where the hotel got swapped is a hotel-scoring signal. Dates moved 2 days is a flexibility signal. The layover killed every single time it appears is a rule we should have had.

**Conversion says how the whole desk performs.** Proposals per booking, per desk, per prompt version. When a prompt change ships and conversion drops 8 points, the evals passed and the users voted, and the users win.

**And the watcher has its own signal:** how often her answer to "your flight died, here's a rebooking" is yes. A watcher whose drafts get accepted is drafting well.

## The three requirements

Every learning loop needs three properties, and each one exists because skipping it produced a specific bug in a system I watched.

**Capture at the moment.** Covered above: the link is written at booking time or never.

**A fallback before the data exists.** On day one, there are zero decided proposals, and learning code that runs on zero observations doesn't abstain, it amplifies noise. The bug compounds, because each skewed output it produces feeds back in as a new observation, so the mechanism trains itself on its own mistake. Every consumer below carries the same guard:

```js
const survivors = await db.approvedProposals({ segment });
if (survivors.length < MIN_OBSERVATIONS) {
  return recencyFallback(segment);   // newest good bookings, no learning applied
}
```

The fallback is boring on purpose. Boring and explicit beats clever and accidental, because an accidental fallback is usually `?? 0`, and part 2 already showed where that road goes.

**Provenance on every derived number.** Any similarity score, any ranking, any "users prefer X" carries which rows produced it. A number that can't name its rows can't be debugged when it goes wrong, and it will go wrong, as the next section shows.

## The inversion bug, so you don't ship it

The most dangerous learning bug isn't learning nothing. It's learning backwards, and here's the version of it that fits our schema exactly.

We rank past proposals by how much of them survived into the booking: high survival means she took what we made, so those proposals become the examples we show the model for future trips. The similarity function compares `proposals.itinerary` against the booked itinerary.

Now a refactor changes what gets stored, and the itinerary column starts holding only the flight leg. The similarity function compares her full booked trip, flights, hotel, transfers, against flights alone, and scores a completely untouched proposal as heavily rewritten.

The system's next move deserves slow reading. Its best work, the proposals she booked without changing a word, scores as its most-rejected work, and gets suppressed from the examples. Its strongest positive signal, filed as its strongest negative, one booking at a time, with no error anywhere to notice.

And every test passes, because the fixture uses a flights-only itinerary, a shape production never writes.

<!-- REVIEW(globetrotty) — there is a fourth defense, and it's cheaper than all three below:
     put a schema version on the itinerary column itself. The whole failure mode in this
     section is a shape change going undetected, and an explicit `itinerary_schema_version`
     written at save time turns "the similarity function silently compared two different
     shapes" into a loud mismatch at the first row. One integer column. Worth adding, since
     the section's own argument is that the bug is invisible by construction. -->

Three defenses close it, all cheap. The similarity function asserts its inputs have the same shape and refuses mismatches loudly. The derived scores carry provenance, so one query shows the untouched proposal scoring 0.2 and someone asks why. And the golden trips from part 3 include one case that asserts a known-booked-unchanged proposal scores above 0.9, which turns the inversion into a red build instead of a quiet slide.

## The consumers: where the signal goes

Collected signal that nothing reads is a log, so four consumers read ours.

**Examples in the desk prompts.** The planning desk's prompt carries 2 or 3 past itineraries as examples of what good looks like, and the loop's job is choosing them: approved proposals with high survival, matched to the current trip's segment, beach-with-kids examples for beach-with-kids requests. Refreshed monthly, from a query, with the fallback guard on top.

One honest trap in this consumer, because it costs quality exactly where users need us most. Heavy edits mean two different things: the proposal was bad, or the trip was hard and she rearranged our scaffold into something we'd never have found. If we treat every heavy edit as failure, the ranking steadily learns to prefer easy trips, and the agency gets worse precisely on the complicated requests. The fix is segmenting the signal: survival rates compare within trip difficulty, never across it.

**Her own memory.** The `agent_memory` table from part 2 is a learning-loop consumer with one user in scope: her edits write inferred preferences, marked as inferred, and her next trip's notebook arrives pre-warmed. She rejected a red-eye once, so the agent weighs late landings without her repeating it, and says "last time you swapped away from a late landing" rather than asserting a preference she never stated.

**Judge calibration, continuously.** Part 3 calibrated the judges against 100 of her decisions once. The loop makes it a standing job: agreement between judge verdicts and user decisions, recomputed monthly, charted. A judge drifting away from users is measuring something users stopped caring about, and the chart says so before the judge quietly reshapes the product.

<!-- REVIEW(globetrotty) — "ships behind part 2's canary" is a forward reference to something
     part 2 never builds. Part 2's drift section builds a STRING COMPARISON (`response.model`
     against the requested ID), not a canary; and confirmed live on 2026-08-16, that
     comparison cannot fire for aliased models, because the API echoes the alias back
     verbatim. So this sentence rests on a mechanism that is absent in the cited part and
     inoperative in the form it does take.

     Two separate things are being conflated under one word, and the series would be clearer
     if it separated them:
       - a RELEASE canary — ship a prompt edit to a fraction of traffic, compare outcomes,
         roll back on regression. This is what THIS paragraph actually needs, and nothing in
         parts 1–3 builds it.
       - a DRIFT canary — replay a fixed prompt set on a schedule and fingerprint the output,
         to notice the provider changing weights under you. This is what part 2 needs and
         doesn't have.

     They share a name and almost no machinery: one is a traffic split with a rollback, the
     other is a scheduled replay with a diff. Suggested fix: build the release canary here in
     part 4 where it belongs, build the drift canary in part 2, and make each cross-reference
     name which one it means. As written, part 4 borrows from part 2 and part 3 line ~188
     borrows from part 2, and the thing all three borrow was never built. -->

**And prompt changes, gated the long way around.** The loop's biggest outputs are hypotheses: the layover keeps getting killed, so the desk prompt should weigh layovers against party composition. A hypothesis becomes a prompt edit, the edit runs the part 3 suite, ships behind part 2's canary, and gets judged by conversion, which closes the circle: users generate the signal, the signal changes the prompt, the users grade the change.

## The cadence

None of this runs on vibes or on someone remembering. Three rhythms cover it.

Weekly, a human reads the worst conversations: rejected proposals, `limit_reached` exits, watcher offers declined. Thirty minutes of reading traces finds what no metric names, and it's where next month's hypotheses come from.

Monthly, the mechanical refresh: example selection re-queried, judge agreement recomputed, survival scores re-derived with their provenance spot-checked.

And quarterly, the one structural option: the front desk is a classifier with thousands of labeled examples by now, ours from routing decisions and corrections, and a small fine-tuned model at that seat is the same upgrade Booking.com measured at sharply better accuracy for a fraction of the latency. The cheapest seat in the agency, upgraded with data the agency generated itself.

That's the whole machine. She types one sentence. An agency of models plans it, guards it, prices it honestly, survives its own crashes, and asks for her yes before a euro moves. And every month, because of what she clicked, it gets a little better at being hers.

Now we build it.

## References

- [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) - Sierra
- [LLM Evaluators Recognize and Favor Their Own Generations](https://arxiv.org/abs/2404.13076) - the self-preference measurement behind continuous judge calibration
- [Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) - Hamel Husain, on the weekly trace-reading habit
- [AI agent case studies](https://arize.com/customers/ai-agent-useful-case-study/) - Arize, on Booking.com's fine-tuned intent model
