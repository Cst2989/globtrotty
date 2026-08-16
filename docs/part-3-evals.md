---
title: "AI Agents: Evals"
excerpt: "The agency plans trips and the harness keeps it alive. Now the hard question: how do we know it's any good, and how do we know tomorrow's deploy didn't make it worse? Snapshot tests lie to non-deterministic systems, so we grade the output, grade the path that produced it, and calibrate every judge against the one person whose opinion counts: her."
publishDate: 2026-08-26
image: "~/assets/images/articles/production-ai-agents-evals.png"
category: "AI"
readTime: "16 min"
tags: ['AI', 'Agents', 'LLM', 'Evals', 'Testing', 'Quality']
---

In part 1, we staffed a travel agency: a front desk, her agent with nine doors of staff, a back office, a cashier. In part 2, we built the harness that keeps it alive: the notebook, the turns, the gates, the guards.

She types "find us a week in Portugal in September, near a beach, under 1,500 euros, and we're bringing a toddler," and the agency produces two itineraries.

Are they good?

We can read them and nod, but we can't read 400 conversations a day, and nodding doesn't survive the next deploy. Every prompt edit, every model migration, every new tool changes behaviour somewhere, and without measurement, we find out from her.

This part builds the measurement.

## Why our old tests lie here

The tests we write for normal code assume the same input produces the same output. Our agency breaks that assumption on purpose, because we hired a model precisely to produce judgment, and judgment varies.

If we run the same Portugal request twice, one run proposes the Monday flight, the other proposes Saturday, and both are defensible. A snapshot test fails on the first harmless variation, so we loosen it until it only checks that JSON came back, and now it passes while quality collapses. The tests stay green while the customer gets angry.

The fix is to stop asking "is the output identical" and start asking two better questions.

Is the output acceptable? Budget respected, crib present, prices real, dates inside her month.

And did the agency work correctly to produce it? Searches before quotes, questions before guesses, the right desk, a sane number of calls.

Those two questions are output grading and trajectory grading, and everything in this part is one of the two.

## The floor: the gates are already evals

The harness bought us a head start: our strictest evals already run in production, on every offer, because we built them as gates.

`checkBudget` refuses arithmetic violations. `checkDates` refuses trips outside her month. `checkProvenance` refuses any hotel or fare that no tool returned this conversation, which is the hallucination guard from part 2.

An eval suite reuses the exact same functions offline. That identity matters more than it looks, because the checks we test with are the checks production enforces, so a case that passes evals can't fail the same check live. It's one implementation carrying two duties.

The gates are the floor, and a floor is not a ceiling. An itinerary can pass every gate and still be a bad trip: a beach hotel by a motorway, a "family-friendly" resort with a nightclub, two connections with a toddler. Code can't see those. The rest of this part is about what can.

## Golden trips: the fixed cases

The core asset is a set of golden trips: real requests from our traces, each with the outcome we agreed is right, frozen in a file that's reviewed like code.

For a chat product, a golden case can't be one message, because the agency asks questions back. So each case ships with a script: the persona, the facts she'd reveal if asked, and the limits we hold the agency to.

```json
{
  "id": "portugal-toddler-01",
  "firstMessage": "we want a week in portugal in september, near a beach, under 1500, with our toddler",
  "persona": {
    "facts": { "departureCity": "Berlin", "flexibleDates": true, "budgetEur": 1500 },
    "style": "brief, types fast, lowercase"
  },
  "expect": {
    "gates": "all pass",
    "mustInclude": ["crib"],
    "maxFrontierCalls": 10,
    "maxQuestionsAsked": 3,
    "proposals": 2
  }
}
```

Running a case means simulating her. A small model plays the user: it answers the agent's questions from the scripted facts, never invents anything beyond them, and stops when a proposal arrives. Sierra's τ-bench benchmarks agents exactly this way, with a simulated user over airline and retail scenarios, because a conversational product can only be tested conversationally.

```js
// evals/run.js
import cases from './golden-trips.json';

for (const c of cases) {
  const convo = await startEvalConversation(c.firstMessage);
  const sim   = makeSimulatedUser(c.persona);          // small model, scripted facts

  while (convo.status !== 'awaiting_decision' && convo.turnCount < 15) {
    const question = await lastAgentMessage(convo);
    await sendReply(convo, await sim.reply(question)); // answers from the script only
  }

  const offer  = await latestProposal(convo);
  const trace  = await loadTrace(convo);

  // REVIEW(globetrotty) — these two lines are the article's central claim ("one
  // implementation carrying two duties") and both have a hole that makes the reuse unsound.
  //
  // 1. `convo.requirements` IS THE NOTEBOOK AS IT STANDS NOW, not as it stood when the gate
  //    ran in production. update_requirements mutates it in place and nothing snapshots it
  //    onto the proposal. So: she rejected a 1,500 EUR offer, later raised her budget to
  //    2,000, and replaying the gate today PASSES an offer production rejected. The identity
  //    between production checks and eval checks — which this article rightly says matters
  //    more than it looks — is broken silently, and in the direction that makes evals look
  //    green. Fix: snapshot the requirements onto the proposal row at save time. This is
  //    unbackfillable — the prior notebook states are gone the moment the notebook is
  //    overwritten.
  //
  // 2. `trace.toolResults` HAS NO HOME. Results from code tools (fare sweeps, hotel sweeps,
  //    transfers) are not model calls, so they never enter model_calls. They exist only in
  //    turn state, which part 2 describes as "the memory of one wake of the loop", overwrites
  //    every step, and gives no retention guarantee. Whatever survives has also been through
  //    trimForContext ("3 fields per fare, not 40"), so the fields provenance needs to check
  //    may be gone. Provenance needs its own durable, untrimmed, append-only store keyed
  //    (conversation_id, source_id) — separate from what the model reads.
  assertEmpty(checkBudget(offer, convo.requirements));      // the gates, reused
  assertEmpty(checkProvenance(offer, trace.toolResults));
  assertIncludes(offer, c.expect.mustInclude);
  assertAtMost(trace.frontierCalls, c.expect.maxFrontierCalls);
  assertAtMost(trace.questionsAsked, c.expect.maxQuestionsAsked);
}
```

Twenty cases cover more than you'd think, if they're chosen adversarially: the hotel-only lookup, the "I don't know where" discovery, the budget she never states, the gibberish opener, the request in Portuguese, the trip that's impossible under the budget so the honest answer is "not for 1,500 in August." That last kind matters most, because an agency that never says "no" is an agency that invents.

Non-determinism cuts through here too, so the suite runs each case 3 times on the nightly schedule, and a case that passes twice out of 3 is a flaky case, which is information rather than noise. τ-bench formalizes this as pass^k, the probability of passing k runs in a row, which is the honest number for anything customer-facing.

<!-- REVIEW(globetrotty) — pass^k is meant to measure MODEL variance, so three other sources
     of variance have to be pinned or the number measures nothing. None are mentioned:
     - THE SUPPLIER SEED. If the mock supplier seeds from a per-run conversation id, three
       runs of one case see three different fare universes. Seed from the golden case id.
     - THE CLOCK. Golden trips with relative dates ("a week in September") drift into the past
       and start failing for calendar reasons. Part 2 already says the shell owns the clock and
       hands it in — evals must inject a fixed `now`.
     - THE SIMULATED USER. It is itself a small model, so its variance contaminates every
       pass^k number unless its model, prompt, and seat are pinned and traced.
     Also worth noting: this suite needs to drive a conversation WITHOUT the HTTP layer, and
     20 cases x 3 runs against per-user daily spend caps will trip those caps nightly. Both are
     cheap to design for on day one and painful to retrofit. -->


## Trajectory grading: how it got there

The second axis reads the path instead of the destination, and the harness already recorded the path, because every turn's tool calls sit in the trace.

Three trajectory checks catch most of what we care about, and all three are plain code over `model_calls` and turn state.

**Every quoted number has a search behind it.** An offer from a conversation that never called `explore_fares` got its prices from the model's memory. `checkProvenance` blocks this at the gate, and the trajectory version tells us how often the model tried, which is drift we want on a chart before it's an incident.

**Questions came before guesses.** A discovery conversation ("somewhere warm?") that fires searches before its first `ask_user` is burning money on an unknown budget. The check reads the tool-call order from the trace.

**The call count matches the job.** A hotel lookup that took 14 frontier turns and a full trip that took 4 are both wrong, in opposite directions. We assert ranges per case type, and the ranges come from our own traces of good runs.

A model can also announce work it never did, in fluent and specific language, because "I've checked the visa rules for you" is a plausible sentence whether or not `check_entry_rules` was ever called. The transcript reads perfectly. The trace shows no such call. Trajectory checks are the only tests that catch this class, because the output alone is flawless.

## The judge: grading quality with a model

The gates check rules and the trajectories check process, and neither can tell us whether the trip is good. For that, we use a model as judge, and we use it knowing exactly how it fails.

A judge fails by grading vibes. "Rate this itinerary 1-10" produces confident nonsense, because the judge doesn't know what we mean by good. So each judge measures one property, with a rubric, with examples of pass and fail:

```
You judge ONE property of a proposed itinerary: family fit.

The travellers: {{ notebook }}

Family fit means the trip works with the party as described.
FAIL examples: an 11pm landing with a toddler and no transfer plan.
  A hotel the brief places 20 minutes from the beach, sold as beachfront.
  Two flight connections when a direct exists within budget.
PASS example: mid-morning direct flight, crib confirmed, beach at 300m.

Reply with JSON: { "verdict": "pass" | "fail", "reason": "one sentence" }
```

A judge also fails by nepotism. Models measurably prefer their own writing, so a judge from the same family as the desk it grades scores like a proud parent. Our senior reviewer already runs on the frontier model, so the offline judge runs on a different family, and the disagreement between them is itself a signal worth reading.

And a judge fails silently, which is why it never gets deployed uncalibrated. We have the calibration set nobody else has: her decisions. Every proposal carries `approve`, `edit`, or `reject` in the proposals table, from part 2's schema. Before a judge's verdicts count for anything, we run it over 100 past proposals and measure agreement with what she and users like her did:

```js
const past   = await db.decidedProposals({ limit: 100 });
const agree  = await judgeAgreement(judge, past);   // judge pass/fail vs her approve/reject
// Below ~80% agreement, the judge is measuring something users don't care about.
// Fix the rubric, not the users.
```

A judge that disagrees with her is not a strict judge. It's a wrong one.

## Where each eval runs

The suite splits by cost, because we can't run everything everywhere.

**On every pull request:** the gates' unit tests and 5 golden trips, minutes, cents. A prompt edit that breaks the crib case never merges.

**Nightly:** all golden trips times 3 runs, the trajectory checks over the day's production traces, and the judges over a sample of the day's proposals. This is where flakiness and drift show up as trends instead of incidents.

<!-- REVIEW(globetrotty) — this sentence inherits a defect from what it cites. Part 2's drift
     section prescribes detecting a model change by comparing `response.model` against the
     requested ID; confirmed against the live API on 2026-08-16, an aliased model echoes the
     alias back verbatim, so that comparison can never fire for the frontier seats. See the
     REVIEW note at part 2's drift paragraph.

     The dependency runs the wrong way here, and fixing part 2 does not fix this line. "Before
     a model migration" assumes you KNOW a migration is happening — which is true for a
     migration you perform deliberately, and false for the case part 2's section exists to
     catch, where the provider moves the weights under a stable alias and nobody schedules
     anything. This suite is the right instrument; the trigger is what's missing.

     Suggested rewrite: make it a SCHEDULE, not an event. Run the shadow suite on a fixed
     cadence against the aliased seats regardless of whether anyone announced a migration, and
     alarm on the score moving rather than on the version string changing. That turns this
     paragraph into the behavioural detector part 2 needs and currently lacks — which is also
     what part 4 line ~103 already assumes exists. -->

**Before a model migration:** the full suite on the new model, shadowed against the old, exactly the machinery from part 2's drift section. The new model needs a number to beat, and this suite is the number.

One honesty rule for all of it: every pass rate carries its denominator. "92% pass" means nothing if traces dropped silently, which is why part 2 made silent drops impossible: a missing trace is distinguishable from a dropped one, so the denominator is real.

## What we still can't measure

The suite grades what we thought to encode. It can't grade the trip being boring, the tone being off for a grieving customer, or the proposal being fine while a better one existed one search away. Users grade those, with the approve, edit, and reject clicks they were already making, and the edits are the richest signal in the entire system, because an edit says "close, and here's exactly what was wrong."

That signal is sitting in our proposals table right now, unused.

Spending it is part 4.

## References

- [τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) - Sierra, simulated users and the pass^k metric
- [LLM Evaluators Recognize and Favor Their Own Generations](https://arxiv.org/abs/2404.13076) - the self-preference bias measurement
- [Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) - Hamel Husain
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) - Anthropic
