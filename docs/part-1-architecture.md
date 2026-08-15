---
title: "AI Agents: Architecture"
excerpt: "This series focuses on building AI agents in production. In the first part we're discussing different types of architecture and how to connect multiple agents working together with all the pros and cons."
publishDate: 2026-08-12
image: "~/assets/images/articles/production-ai-agents.jpg"
category: "AI"
readTime: "26 min"
tags: ['AI', 'Agents', 'LLM', 'Evals', 'Observability', 'Security', 'LangChain']
---

In late 2022, ChatGPT launched. For most of us that was our first contact with AI, and back then we had only two ways to use it: a chat box or a simple API call. 

Then providers added tool calling to their APIs. A model can now ask your code to run a function, read the result, and decide what to do next.

That combination, a model choosing steps inside a loop your code runs, is what people call an AI agent.

Let's imagine we have a travel product.

One of our users types: "find us a week in Portugal in September, near a beach, under 1,500 euros, and we're bringing a toddler."

Our AI agents does all the work and comes back with 2 proposals. The user picks one. Everybody's happy, including the agent.

This guide covers what agents are and how to architect this agentic flow, as part of a multi-article series where will discuss how to setup a harness for your agent, how to run evals and how to build a self improvement loop. 

Let's go! 

## What an AI agent is

Underneath every SDK, an AI call is an HTTP request: you POST text to an endpoint, and you get text back.

```js
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'Write a haiku about databases.' }],
  }),
});
```

It differs from every other API you've integrated in four ways:

**Non-deterministic.** Call it twice with identical input and you get two different answers.

**It doesn't know when it's wrong.** A false answer arrives with the same confidence as a true one. There's no error code for "I made this up." This is called hallucination.

**You pay per token, both directions.** Your text gets chopped into tokens, chunks of roughly three quarters of a word, before the model reads any of it. A long document in your prompt costs money on every send. In a multi-step system that's every step.

**It's bad at math.** Counting the characters it wrote is a computation it doesn't perform. Precise arithmetic is almost always wrong unless you hand it a tool.

Now, the word "agent" itself can mean three different things:

**A single call.** You send one request and you get one response back. Our Portugal message goes in, and one word comes out saying whether the traveler wants a new trip or a change to a booking she already has.

**A workflow.** Several calls wired together by your code, in an order fixed in advance. You draft it, you review it, then you fix whatever the review found.

**An independent agent.** The model decides what happens next and when it's finished. You don't know the sequence before it runs. This is what we want to build.

## Picking a model

At the top sits a frontier model, their smartest and slowest one, which costs the most per call. Small, fast models fill the bottom of that range, answering in under a second for a fraction of a cent.

So which one does our vacation agent use? The honest answer is several, because an agent is composed of jobs that each need a different level of intelligence.

For example the agent that is driving the loop. 

This is the model that reads "find us a week in Portugal with a toddler," decides that searching for flights comes first, reads the prices that come back, realizes the dates are wrong, and needs better information. 

Driving takes judgment. Paying the frontier rate per call gives us a model that picks the right tool the first time and recognizes a bad result when it reads one. 

If we put a small model in the driver's seat, it picks the wrong tool, misreads results, and loops. Sometimes forever.

The second kind of job is the simple, repetitive one. 

Somewhere in the pipeline, something reads each incoming message and answers one small question about it. Is this email a booking request or a complaint? That question, picking one label from a fixed list, is called **classification**. 

What's the traveler's budget in this message? Pulling a specific value out of free text like that is **extraction**. 

And once the message has a label, sending it to the right handler, complaints to one prompt, bookings to another, is called **routing**.

All three go to the small models, since every answer is short and easy to check against the message it came from.

Another job a model can do is reviewing. 

Does this itinerary make sense for a family with a toddler? Would I send this reply to an angry customer? Nothing below our strongest model answers those. 

There's one more thing that determines which models we pick: how long the user is willing to wait. 

When we build something new, we start every job with the strongest model, because our first question is whether the feature works at all. A weak model makes that question unanswerable: when the output is bad, we can't tell if the idea failed or the model did.

Then we can downgrade later, one job at a time, after we have evals and we can measure the result of the cheaper models vs the frontier models. 

## Architecture types

So far, we've decided that our feature needs a model and have picked which models to use. The next decision is how the calls fit together: does one call do everything, do several calls run in a fixed order, or does one model check another's work?

Those arrangements repeat across products. After you build a few of these, the same ten patterns keep showing up.

* The code examples use a small `ask()` helper that wraps the SDK call from the first section: you give it a system prompt, the user content, and optionally tools. 

### 1. Single call

```
  input ──▶ [model] ──▶ output
```

This diagram describes any feature that transforms one input into one output. 

Before any agent runs, something has to read each incoming message and decide what the user wants:

```js
async function classifyRequest(message) {
  return ask({
    system: 'Classify this travel message. Reply with JSON: ' +
            '{ "intent": "new_trip" | "change_booking" | "question" }',
    user: message,
  });
}
```

This is how we were building agents 3 years ago. And it works, but you will hit the limits pretty fast. As people add more requests to a single message, you end up adding more instructions to your prompt.

You will start adding: "and if the message mentions a booked trip, also...", then another clause, then another. The accuracy drops with each one, because the model juggles too many rules at once.

### 2. Chain

```
  input ──▶ [call 1] ──▶ [call 2] ──▶ [call 3] ──▶ output
```

A chain runs a fixed sequence where each output feeds the next call. For example, every itinerary the agent produces gets turned into a friendly confirmation email, in the user's language.

```js
async function confirmationEmail(itinerary, userLang) {
  const draft  = await ask({ system: WRITE_CONFIRMATION_PROMPT, user: itinerary });
  const local  = await ask({ system: `Translate to ${userLang}.`, user: draft });
  const report = await ask({ system: CHECK_NUMBERS_PROMPT,
                             user: JSON.stringify({ itinerary, email: local }) });
  if (report.mismatches.length === 0) return local;
  return ask({ system: FIX_NUMBERS_PROMPT, user: JSON.stringify({ local, report }) });
}
```

The steps never change order; no matter what the input says, that means our code owns the sequence.

But be aware that errors compound down a chain, because every step inherits the previous step's mistakes and adds its own. If we chain five steps that each succeed 95% of the time, the arithmetic leaves us a run that succeeds about 77% of the time. (60% of the time, it works everytime)

### 3. Router

```
             ┌──▶ [refund handler]
  input ──▶ [classify] ──▶ [bug handler]
             └──▶ [sales handler]
```

A router classifies first, then dispatches to a specialist prompt. Our new-trip handler knows how to gather requirements for the agent, our change-booking handler knows the rebooking rules, and our question handler knows the product FAQ, without any of them carrying the others' rules.

```js
const HANDLERS = {
  new_trip:       { system: NEW_TRIP_PROMPT },
  change_booking: { system: CHANGE_BOOKING_PROMPT },
  question:       { system: QUESTION_PROMPT },
};

async function respond(message) {
  const { intent } = await classifyRequest(message);  // shape 1, reuse
  return ask({ ...HANDLERS[intent], user: message.body });
}
```

But it can easily go wrong, first you need all the options beforehand and then when the classifier sends a change-booking request to the question handler, the question handler doesn't complain; it produces a confident, well-written FAQ answer to someone whose flight leaves tomorrow.

### 4. Fan-out and voting

```
  input ──┬──▶ [chapter 1] ──┐
          ├──▶ [chapter 2] ──┼──▶ combine ──▶ output
          └──▶ [chapter 3] ──┘
```

Fan-out splits independent work and runs it in parallel.

```js
async function compareDestinations(requirements, cities) {   
// ['Lisbon', 'Faro', 'Madeira']
  const briefs = await Promise.all(
    cities.map(c => ask({ system: DESTINATION_BRIEF_PROMPT,
                          user: JSON.stringify({ city: c, requirements }) }))
  );
  return ask({ system: COMPARE_PROMPT, user: briefs.join('\n---\n') });
}
```

Each brief was written blind to the others, so if Faro's brief doesn't know Lisbon's flights cost half as much, the final comparison rests on three documents that dont know anything about each other.

Voting runs the same task several times and aggregates the answers.

```js
async function readFareTotal(farePage) {
  const reads = await Promise.all([1, 2, 3].map(() =>
    ask({ system: EXTRACT_FARE_PROMPT, user: farePage })
  ));
  const counts = tally(reads.map(r => r.total));
  const [winner, votes] = counts[0];
  return votes >= 2 ? { total: winner } : { needsHuman: true, reads };
}
```


### 5. Generator plus reviewer

```
  input ──▶ [writer] ──▶ draft ──▶ [reviewer] ──┬─▶ good ──▶ output
                 ▲                              │
                 └────── "fix these" ───────────┘
```

A second model critiques whatever the first one writes, so the writer revises against that critique until it passes or until we run out of rounds.

```js
async function draftWithReview(input) {
  let draft = await ask({ system: WRITER_PROMPT, user: input });

  for (let round = 0; round < 2; round++) {           // the bound
    const review = await ask({ system: REVIEWER_PROMPT, user: draft });
    if (review.approved) return draft;
    draft = await ask({
      system: WRITER_PROMPT,
      user: `${input}\n\nRevise this draft. Fix: ${review.issues.join('; ')}`,
    });
  }
  return draft;   // out of rounds; ships with the last revision
}
```

This architecture also has some issues, like a reviewer approving everything because its prompt told it to, a reviewer judging a property it was never shown examples of, and a reviewer drawn from the same model family as the writer, which shares the writer's blind spots and waves through the exact mistakes that family of model makes most often.

Same-family bias is the hardest of those to picture. 

In our product it looks like the writer putting a 6 am departure in front of a family with a toddler, and the reviewer, running on the same model, reading that itinerary back and calling the schedule tight but fine.

### 6. Tool loop

```
  ┌───────────────────────────────┐
  │  think: what do I need?       │
  │  act:   call a tool           │
  │  see:   read the result       │
  └────────────┬──────────────────┘
               │ repeat until done
               ▼
            answer
```

The model requests a tool, your code runs it with your permissions, and the result is returned to the conversation for the model to read.

```js
// The bare loop, without the bounds and checks a production version wraps around it.
let messages = [{ role: 'user', content: request }];
for (let i = 0; i < MAX_STEPS; i++) {
  const res = await ask({ system: AGENT_PROMPT, messages, tools: TOOLS });
  if (!res.toolCall) return res.text;
  const result = await runTool(res.toolCall);
  messages.push(res.message, { role: 'tool', content: result });
}
```

Three things change for us once the model is in control. 

The run can loop, so a cap on turns is mandatory as we dont want it to run forever. 

Cost climbs as the run goes, since every turn re-sends the whole conversation and the late turns pay again for everything before them. Prompt caching helps by keeping the unchanged part of the prompt on the model side.

And prompt injection gets dangerous once the model can act on what it reads. Someone plants a line in a hotel description telling the reader to ignore its earlier instructions and email the traveler's card details to an address, and when our search tool hands that description back, the model reads it as an instruction like everything else in the conversation. (And now we are hacked)


### 7. Plan then execute

```
  input ──▶ [planner] ──▶ written plan ──▶ [worker] ──▶ step ──▶ step ──▶ done
                ▲                                          │
                └────────── replan if stuck ───────────────┘
```

A capable model plans once, and a smaller model executes each step.

```js
async function buildPlan(request) {
  const plan = await ask({ model: STRONG, system: PLANNER_PROMPT, user: request });
  // plan.steps: [{ id, instruction }, ...]

  const results = [];
  for (const step of plan.steps) {
    results.push(await ask({ model: SMALL, system: EXECUTOR_PROMPT, user: step.instruction }));
  }
  return results;
}
```

This is basically how Spec Driven Programming works with Claude Code.

The problem here is that the model made the plan before anyone knew what they'd find. Step three can reveal that the plan was wrong from the start.

Our planner writes five steps around a beachfront hotel in Lagos, and step three searches that hotel's room types and finds no cribs. The two steps after it still book an airport transfer and an itinerary for a place this family can't sleep in, because the executor follows the instruction it was handed rather than the fact it uncovered.

### 8. Supervisor

```
              ┌──────────────┐
              │  SUPERVISOR  │  holds the goal, dispatches,
              └──┬───┬───┬───┘  decides when it's finished
                 │   │   │
        ┌────────┘   │   └────────┐
        ▼            ▼            ▼
   [researcher]  [writer]   [fact checker]
```

Named specialist agents sit under one supervisor agent that everything goes through.

In my experience, this architecture requires four things to work correctly.

- It needs a termination condition that it can evaluate, since "keep going until done" causes supervisors to loop.

- It needs structured worker output, so the supervisor acts on results instead of reading through them.

- It needs workers who return conclusions instead of full transcripts, because the supervisor's context accumulates everything its workers say.

- It needs workers we can verify one at a time, because once a worker's error is folded into the supervisor's aggregated answer, nothing downstream can tell us which worker got it wrong.

The basic implementation is a loop where the supervisor's output is a dispatch decision:

```js
let state = { requirements, findings: [] };
while (!state.done) {
  const decision = await ask({ model: STRONG, system: SUPERVISOR_PROMPT,
                               user: JSON.stringify(state) });
  // decision: { worker: 'flights' | 'hotels' | 'activities' | 'finish', task }
  if (decision.worker === 'finish') break;
  const result = await WORKERS[decision.worker](decision.task);
  state.findings.push({ worker: decision.worker, result });   // conclusions, never transcripts
}
```

### 9. Handoff

```
   [triage] ──▶ [billing] ──▶ [refunds]
                    ▲            │
                    └────────────┘
```

Peers pass control directly, with no coordinator above them. 

We see this on our travel product's support side: a triage agent hands the conversation to the booking-changes agent. Halfway through, the user mentions the airline already canceled the flight, which makes it a refund case for a different specialist.

```js
let current = 'triage';
for (let turn = 0; turn < GLOBAL_BUDGET; turn++) {   // nobody owns "done", so the budget does
  const res = await AGENTS[current].respond(conversation);
  conversation.push(res.message);
  if (res.handoffTo) current = res.handoffTo;        // changes passes to refunds mid-thread
  else if (res.finished) return conversation;
}
```

Handoffs fail in a specific, almost comic way: no single agent owns "we're done," so control bounces between changes and refunds indefinitely, with each one politely handing the customer back to the other.

### 10. Human in the loop

```
  [agent] ──▶ proposal ──▶ [you] ──┬─▶ approve ──▶ do it
                                   ├─▶ edit ──▶ do the edited version
                                   └─▶ reject
```

In this shape, a person checks the agent's work before anything irreversible happens. The agent drafts the email and you press send, or it stops at a proposed migration until you approve.

The implementation is a pause: the agent writes a proposal and stops, and a separate handler handles the response when the human responds.

```js
async function proposeBooking(runId, itinerary) {
  await db.saveProposal(runId, { itinerary, status: 'awaiting_approval' });
  await notifyUser(runId);          // the run now sits idle, costing nothing
}

async function onUserDecision(runId, decision) {      // approve | edit | reject
  await db.recordDecision(runId, decision);           // the training data, one row
  if (decision.action !== 'reject') {
    await bookTrip(decision.itinerary);               // the edited version, if edited
  }
}
```

This implementation produces the best training data you will ever collect, because approve, edit, and reject are graded labels generated by users in the course of their work.

## Picking one architecture

| Your situation | Architecture | Number |
|---|---|---|
| One well-defined transformation | Single call | 1 |
| Stages you can name in advance | Chain | 2 |
| Your prompt fills up with "if the user asks about X..." | Router | 3 |
| Independent pieces of one big job, or a wrong answer that costs more than three model calls | Fan-out and voting | 4 |
| Quality improves when told what's wrong | Generator + reviewer | 5 |
| The next step depends on what it finds | Tool loop | 6 |
| Many simple steps, cost matters | Plan then execute | 7 |
| Named specialists, one accountable place | Supervisor | 8 |
| Specialist unknowable until it unfolds | Handoff | 9 |
| Anything irreversible | Human in the loop | 10 |

As you can imagine, its not as simple as it looks. There are all sort of issues and problems when building multi-agent systems. Here are some that I encountered:

- Multiple agents multiply what we spend. 

- Every extra worker multiplies the chance of being wrong, without us knowing

- Passing information between agents takes longer than it looks. 

- When agents are expecting something concrete and they receive something else, they dont complain and do what they are told, which usually means bad results

What you should do before committing to multiple agents: describe each agent's job in one sentence, then ask whether another engineer would independently agree which agent handles a given input.

## Our architecture for the vacation agent

Everything so far was theory, so let's run it against our original example. A user lands on our website and types this into our one chat interface:

"My husband and I want to go on vacation, find us a week in Portugal in September, near a beach, under 1,500 euros, and we're bringing a toddler."

How would we architect this to optimize results and costs?

My first sketch was a pipeline. Classify the message, extract the requirements, run a loop, check the budget, review, propose. Every request on the same conveyor belt, every stage in a fixed order.

Then I imagined a second user typing "find me a hotel near the beach in Faro for Saturday night," and watched the sketch fall apart. The pipeline interrogates her about a trip budget she never mentioned, reviews her one hotel search like a full itinerary, and asks her to approve a search result. Nothing crashes. She just sits through a trip-planning ritual for a simple question, and she pays for every step of it.

The problem is that our product is a conversation, and no sequence we fix in advance can hold one. She reveals the budget in message one, the toddler in message three, and "ground floor please, my husband hates stairs" a day later. Knowing what to do next is literally the job we hired the model for.

So let's forget models and tokens for a minute. We're staffing a travel agency, and the question is who works there.

A real agency has a front desk that answers the phone. It has her personal agent, the one who knows her name, owns her file, and does the actual work of finding a trip. 

That agent has a staff: juniors who research destinations, assistants who sweep the fare space, a colleague who knows visa rules cold. Down the hall sit two more desks, one for changing bookings and one that watches trips already booked. 

In the back office, someone strict checks every offer's numbers, and someone senior reads the whole trip and asks "would I sell this?". At the end, a cashier re-checks the price before any card is charged. 

And when a situation needs a person, a human colleague picks up the file with a summary already written.

Nobody buys anything until the client says yes.

We can draw the whole agency as one org chart:

```
                          HER MESSAGE
                               │
                        ┌──────▼───────┐
          FAQs answered │  FRONT DESK  │  small model. routes the
          on the spot ◀─│              │  message, then it's done:
                        └──────┬───────┘  she never sees it again (this session)
                               │
             ┌─────────────────┼──────────────────┐
             ▼                 ▼                  ▼
      ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
      │ PLANNING    │   │ CHANGES     │   │ DISRUPTION   │
      │ DESK        │   │ DESK        │   │ WATCHER      │
      │ her agent:  │   │ rebooking,  │   │ watches her  │
      │ frontier    │   │ refunds,    │   │ BOOKED trips │
      │ model, owns │   │ own tools   │   │ and messages │
      │ her file    │   │ and rules   │   │ her first    │
      └──┬──────────┘   └─────────────┘   └──────────────┘
         │ its staff, in parallel, small models:
         ├── destination scouts     briefs, never prices
         ├── fare explorer          sweeps dates, layovers,
         │                          nearby airports → shortlist
         ├── hotel explorer         same for stays → shortlist
         └── visa & rules agent     entry rules, toddler papers
         │
      ┌──▼──────────────────────────┐
      │ BACK OFFICE                 │  checker: plain code
      │ every offer passes through  │  senior: frontier, 2 rounds
      └──┬──────────────────────────┘
         │ offer approved            (an async monitor also reads
         ▼                            finished chats for drift:
      SHE SAYS YES                    it alarms, it never blocks)
         │
      ┌──▼──────────┐        ┌──────────────┐
      │ THE CASHIER │        │  HUMAN DESK  │  hard cases arrive
      │ plain code, │        │              │  with a written
      │ re-quotes   │        │              │  handoff summary
      └─────────────┘        └──────────────┘
```

Now let's map every seat onto the architectures we just learned, and onto the model tiers from the beginning of the article.

**The front desk is architectures 1 and 3 on the small model.** Architecture 1 was the single call, one input in and one answer out, and architecture 3 was the router, which reads a label and dispatches to the right handler. 

The front desk does both: one call to label her message, one routing decision to send it to the right desk. 

A new trip goes to the planning desk, a change to an existing booking goes to the changes desk, and anything the front desk isn't sure about goes to the planning desk too, because her agent can answer anything the front desk can, and the reverse is false. 

"I want to go somewhere and I don't know where" must never get stuck at reception.

And once the routing decision is made, the front desk's job is over. It doesn't monitor the conversation, it doesn't relay messages, it never appears again. 

**Her agent is the tool loop, architecture 6, on the frontier model.** The loop was the first architecture on our list where the model decides the sequence itself: it picks a tool, reads the result, and chooses the next step from what it found. That's the seat where judgment lives, and judgment is what the expensive models are expensive for.

In code, we call the frontier model with the conversation so far and a list of tools it may use. It answers with either a tool request or a message for her. Our code runs the tool, appends the result, and calls the model again, until it has nothing left to ask for. 

The tools are the agent's entire reach into the world:

```js
const TOOLS = [
  'update_requirements',    // write a new fact into the notebook
  'ask_user',               // ask her 1-3 questions, then wait
  'explore_fares',          // sweep dates, layovers, airports → shortlist
  'explore_hotels',         // sweep stays for a date window → shortlist
  'check_transfers',        // airport to hotel, minutes and cost
  'research_destination',   // send a scout to study one city
  'check_entry_rules',      // visas, toddler documents
  'propose_itinerary',      // submit an offer to the back office
  'book_trip',              // only works after she said yes
];
```

The notebook is a JSON object: budget 1,500, toddler true, near "beach". The agent writes to it through `update_requirements`, its prompt reads from it on every turn, and the checker reads the same object later, so the agent and its checks can never disagree about what the user asked for.

So who finds the flights and juggles the budget? Her agent decides everything, and its staff does the work.


**The staff are the fan-out, architecture 4, on the small model.** Fan-out was the architecture that splits independent work and runs it in parallel.

The scouts research destinations when she doesn't know where she wants to go: 3 parallel calls, each handed one city plus a copy of the notebook, each returning a brief under 300 words. A brief is words, never prices.

The fare explorer and the hotel explorer sweep the search space her agent would otherwise crawl through one expensive turn at a time: date grids, layover options, nearby airports, whole hotel categories, compressed into a shortlist with the trade-offs. 

In code, an explorer is a small-model worker over the raw search APIs, and some of its sweeps are pure code with no model at all.

The visa and rules agent answers one narrow kind of question from documents: what papers everyone needs to enter a specific country. It covers one narrow domain and never improvises.

Staff explore, and staff report. The moment a decision is needed, the shortlist lands on the agent's desk.

**The back office is the extractor plus the checker plus the senior** The checker is plain code, the cheapest architecture of all: no model. It adds up the prices against extracted by a small model from the  notebook and verifies the dates sit inside the month she asked for. 

The senior is the reviewer, architecture 5, back on the frontier model: one model produces, a second one critiques, and the first revises against the critique inside a bounded number of rounds. Our senior judges what arithmetic can't: does this trip make sense with a toddler, and is an 11 pm landing followed by an hour of transfer something we'd sell to this family? Two rounds, then the best version ships.

In code, the checker and the senior live together inside the `propose_itinerary` tool, in that order, because the free check should reject a broken offer before the expensive one reads it:

<!-- REVIEW(globetrotty) — three problems in this eleven-line gate.

     1. THE EXHAUSTED-ROUNDS BRANCH SHIPS A REJECTED OFFER, UNMARKED. When
        `!review.approved && rounds >= 2`, control falls straight through to
        `saveProposal(offer)` — an itinerary the senior reviewer rejected twice reaches her
        looking identical to an approved one. Part 2 explicitly argues that a system needs a
        state meaning "finished but the checks failed"; this gate has one available and
        silently doesn't use it. It also poisons part 4: if she accepts a reviewer-rejected
        offer, it enters the example pool as exemplary work — the inversion bug wearing a
        different costume. Either don't ship it, or ship it flagged and say so on the card.

     2. `rounds` IS NOT DURABLE. It lives in the loop, not in turn state, so a crash and
        resume resets it to zero and the "bounded at 2 rounds" promise isn't a bound at all —
        a crash-looping turn pays for unbounded frontier reviewer calls.

     3. NO CURRENCY, ANYWHERE. The flagship example is "under 1,500 euros", flights and hotels
        and transfers come from three different suppliers, and `checkBudget` sums bare
        numbers. Summing minor units across currencies is a correctness bug that every
        downstream check then blesses. Every price wants {amount_minor, currency}, and the
        checker should emit a VIOLATION on any currency that doesn't match the notebook's
        budget currency rather than converting. Never convert inside a gate. -->
```js
// what runs when the agent submits an offer
const violations = checkBudget(offer, notebook);        // the checker: free
if (violations.length) return violations.join(' ');     // back to the agent as feedback

const review = await reviewOffer(offer, notebook);      // the senior: frontier model
if (!review.approved && rounds < 2) {
  return `Revise before proposing: ${review.issues.join('; ')}`;
}
return saveProposal(offer);                             // it reaches her
```

Both verdicts return to the agent as tool results, in words, with the numbers named, and the agent revises on its own, because feedback inside the conversation is how a loop learns.

One more employee reads over everyone's shoulder: an async monitor, a cheap model that reviews finished conversations for drift, an agent recommending a competitor, a tone gone wrong, a policy bent. 

**The user is architecture 10, the human in the loop.** A person checks the agent's work before anything irreversible happens, and here that person is our user. Her agent brings her two finished offers. 

In code, the offer lands as a saved proposal, and her click writes one labeled row: approve, edit, or reject.

<!-- REVIEW(globetrotty) — the cashier needs three more branches than it has here.
     - "Same or lower, it books" treats a PRICE DROP as safe. It often isn't: a total that
       fell because the supplier swapped a refundable fare for basic economy, or a sea-view
       room for an interior one, is a downgrade she never approved. Compare per ITEM and on
       item identity (fare class, baggage, refundability, board type), not just on the sum.
     - There is no branch for "we don't know". If the re-quote call times out or errors, the
       article's own philosophy elsewhere — a missing record is an answer, not a bug — pushes
       the implementer toward reading it as benign. Unknown is not unchanged. Any item whose
       re-quote doesn't return a fresh, successful, same-currency price must BLOCK.
     - No tolerance policy: a re-quote one cent higher refuses, which on FX-rounded data will
       fire constantly. Make the tolerance an explicit decision, not an accident of `>`.
     Also worth stating: if the re-quote reads the same cached feed that produced the original
     price, the gate compares cache to cache and passes while the traveller still lands on the
     higher number. The gate is only as live as its price source. -->

**The cashier is plain code again.** Between the offer and the booking, prices move. So at the end, code makes one API call to re-read the fare and one comparison against the number she approved. Same or lower, it books. 

Higher, it comes back to her with the new number.

**The human desk is where the fleet admits its limits.** Some situations need a person: a medical emergency abroad, a visa refusal, a customer in tears. The agent that owns the conversation writes a handoff summary, the notebook, what happened, what was tried, and a human picks up a file instead of a cold start.

**And the confirmation email is the chain, architecture 2, on the small model.**  this one runs three small-model calls in a fixed order: draft the email, translate it to her language, verify every number against what was booked.

If you count the seats, we've hired eight of the ten architectures into one agency: the single call and the router at the front desk, the loop at every desk that owns a conversation, the fan-out in the staff, the reviewer in the back office, the human in the loop twice, once as her and once as the human desk, the one-way handoff between desks, and the chain on the email.

## Why not one genius working alone?

Everything above looks like a lot of hiring, and a fair reader will ask the obvious question: the frontier model is smart, so why not give it the search tools and let it do the whole job alone?

In a demo, the genius produces the same two itineraries as our agency, with a tenth of the code.

But at scale, the agency has at least four benefits:

- Money. Every token the genius touches, input and output, is billed at frontier rates, where the frontier model costs 5 to 10 times more per token than the small one. Our agency hands the sweeping, the briefs, the front desk, the watching, and the email to the small tier. Prompt caching softens the genius's growing conversation, since a loop's transcript is exactly the repeating prefix that caches reward, but what caching can't touch is the rate itself.

- Seams. Meaning places where our code can step in. Our checker reads the notebook, a structured object the agent maintains. The genius holds her budget somewhere in 30 turns of prose, so there's nothing for code to check against, and the budget arithmetic happens inside the model, which is the one place we've established it sometimes fails.

- Visibility. When a run goes wrong, we can see which seat failed. When the genius proposes a hotel with no crib, we're left staring at one long transcript, asking whether it missed the toddler while reading, ignored it while planning, or never checked at all. Our agency leaves an artifact at every desk: the notebook, the shortlists, the checker's verdict, the senior's notes, her decision.

- Optimisations. With separate seats, we can move one seat at a time to a cheaper model and measure whether anything got worse. The genius gives us a single dial, so the day the bill demands savings, the judgment downgrades together with the grunt work.

But let me be honest with you: the genius isn't wrong, it's early. One loop, four tools, the strongest model, shipped to a handful of users, that's exactly the right first version. Anthropic's own guidance on agents says the same thing: find the simplest solution, then add complexity when it demonstrably pays.

Nobody hires this whole agency on day one.

Expedia started with one do-everything concierge and rebuilt toward specialized agents, while the teams that started with elaborate fleets spent months discovering a well-prompted single agent matched them.

Also keep in mind that this agency is still missing everything that makes it work in production: records, surviving crashes, shared memory, tool context, guards. None of that code exists yet.

We call all of that the harness. And its coming in part 2. 

If you want to get notified when its out. [Subscribe here](https://neciudan.dev/subscribe). 

## References

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) - Anthropic
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) - Anthropic
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) - Claude Platform docs
- [Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks](https://arxiv.org/abs/2601.06007) - the 41 to 80% measurement across three providers
- [AI Agents for Travel](https://navan.com/blog/ai-agents-for-travel) - Navan, on Ava's fleet of specialized agents and the hybrid human handoff
- [Expedia acquired AI trip-planner Layla](https://skift.com/2026/07/31/expedia-acquired-ai-trip-planner-layla-exclusive/) - Skift, on the pivot from one concierge to specialized agents
- [AI agent case studies](https://arize.com/customers/ai-agent-useful-case-study/) - Arize, on Booking.com's layered trip planner and the fine-tuned intent model