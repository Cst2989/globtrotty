import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type postgres from 'postgres'
import { SENTINELS } from '../scripts/sentinels.js'
import type { Limits } from '../src/engine.js'
import {
  AGREEMENT_FLOOR, JudgeCappedError, judgeAgreement, judgeContext, loadJudgePrompt,
  parseVerdict, renderForJudge, runJudge, type Labelled,
} from '../src/evals/judge.js'
import type { GateOutcome, RehydratedItem } from '../src/gates/types.js'
import { EVAL_LIMITS } from '../src/limits.js'
import { money, sumMoney } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import { costMicros } from '../src/pricing.js'
import { decideProposal, decidedProposals, recordProposal } from '../src/repo/proposals.js'
import { SEATS } from '../src/seats.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type {
  FlightDetail, FlightSearch, HotelDetail, HotelSearch, LegSummary,
} from '../src/supplier/types.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { fakeClient, textMessage } from './model/fake.js'
import { replayClient } from './model/replay.js'

describe('reading the judge', () => {
  it('reads a verdict and its one-sentence reason', () => {
    expect(parseVerdict('{"verdict":"fail","reason":"Two connections with a toddler."}'))
      .toEqual({ verdict: 'fail', reason: 'Two connections with a toddler.' })
  })

  it('reads a fenced block, because a model asked for JSON often sends one', () => {
    expect(parseVerdict('```json\n{"verdict":"pass","reason":"Direct flights, quiet street."}\n```')!.verdict)
      .toBe('pass')
  })

  it('returns null for a reply it cannot read, rather than calling it a fail', () => {
    // An unreadable reply is a check that did not run. Folding it into `fail`
    // would move the pass rate every time the model wrapped its answer in prose.
    expect(parseVerdict('I would say this one is fine, honestly.')).toBeNull()
    expect(parseVerdict('{"verdict":"maybe","reason":"hm"}')).toBeNull()
    expect(parseVerdict('{"verdict":"pass"}')).toBeNull()
  })

  it('leaves prose around a fence unread, which is the strip\'s real scope', () => {
    // The docstring used to read as though any markdown-shaped reply parsed.
    // These two are the commonest such replies and neither does: the strip
    // removes a fence that opens the trimmed text and one that closes it, and a
    // sentence on either side defeats both. The direction is safe, because
    // unread is dropped from the numerator and the denominator rather than
    // counted as a fail, and the case is here so the docstring cannot drift
    // back to claiming otherwise.
    expect(parseVerdict('Sure.\n```json\n{"verdict":"pass","reason":"Fine."}\n```')).toBeNull()
    expect(parseVerdict('```json\n{"verdict":"pass","reason":"Fine."}\n```\nHope that helps.')).toBeNull()
  })

  it('drops a reason longer than the rubric asks for, and the rubric asks for it', () => {
    // The schema bounds `reason` at 300 characters. A bound only the parser
    // knows about is a bound the model cannot keep, so the rubric states it.
    expect(parseVerdict(`{"verdict":"pass","reason":"${'a'.repeat(300)}"}`)!.reason).toHaveLength(300)
    expect(parseVerdict(`{"verdict":"pass","reason":"${'a'.repeat(301)}"}`)).toBeNull()
    expect(loadJudgePrompt().prompt).toContain('300 characters')
  })

  it('runs on a seat that is not the seat it grades', () => {
    expect(SEATS.reviewer.model).not.toBe(SEATS.driver.model)
    expect(SEATS.reviewer.modelConfigId).not.toBe(SEATS.driver.modelConfigId)
    // And it shares a config id with the other Haiku seats, which the seat's own
    // docstring states rather than leaving a reader to discover. `group by
    // model_config_id` cannot separate a judge call from a classification, so
    // `group by seat` is what has to, and that is the argument for the name.
    expect(SEATS.reviewer.modelConfigId).toBe(SEATS.cheap.modelConfigId)
  })

  it('loads its rubric from a file, versioned by the bytes it sends', () => {
    const raw = readFileSync(new URL('../src/evals/prompts/family-fit.md', import.meta.url), 'utf8')
    expect(raw).toContain('GLOBETROTTY-JUDGE-PROMPT-DO-NOT-SHIP')
    const loaded = loadJudgePrompt()
    // The marker and the sentinel are comments, so neither is on the wire, and
    // the version hashes what was SENT (src/desks.ts).
    expect(loaded.prompt).not.toContain('<!--')
    expect(loaded.prompt).toContain('family fit')
    expect(loaded.promptVersion).toMatch(/^[0-9a-f]{12}$/)
    // Every pattern, taken from the check itself rather than spelled again
    // here, on the scout prompt's precedent (test/scout.test.ts): a rubric the
    // judge can read back to the thing being judged is the one way to make a
    // judge useless, and a sentinel renamed in one place cannot be missed here.
    for (const s of SENTINELS) {
      expect(s.pattern.test(loaded.prompt), `the judge prompt sends ${s.name}`).toBe(false)
    }
  })

  it('names only fail rules the rendered payload can decide', () => {
    // The first draft failed a stay "beside a motorway" and one that
    // "advertises a party atmosphere", and a `SupplierItem` carries no address
    // and no description, so three of its four rules could never fire. A rubric
    // whose rules cannot fire is a judge that always passes. The rules name
    // fields instead, and these are the fields `renderForJudge` puts on the wire.
    const rubric = loadJudgePrompt().prompt
    for (const field of ['stops', 'selfTransfer', 'totalDurationSeconds', 'departureLocal', 'nights', 'rating']) {
      expect(rubric, `the rubric names ${field}`).toContain(field)
    }
    for (const absent of ['motorway', 'nightclub', 'atmosphere', 'crib']) {
      expect(rubric, `the rubric no longer judges a ${absent}`).not.toContain(absent)
    }
  })
})

describe('calibrating against her decisions', () => {
  // A hand-written table, because the arithmetic is the thing under test and a
  // recorded judge reply would only pin the parser, which the cases above pin.
  const table = (pairs: [string, 'accept' | 'reject', 'pass' | 'fail'][]): Labelled[] =>
    pairs.map(([proposalId, decision, verdict]) => ({ proposalId, decision, verdict }))

  it('agrees when accept meets pass and reject meets fail', () => {
    expect(judgeAgreement(table([['a', 'accept', 'pass'], ['b', 'reject', 'fail']])))
      .toEqual({ agreed: 2, total: 2, meetsFloor: true })
  })

  it('refuses to deploy at seventy percent', () => {
    const rows = table([
      ['a', 'accept', 'pass'], ['b', 'accept', 'pass'], ['c', 'accept', 'pass'],
      ['d', 'accept', 'pass'], ['e', 'accept', 'pass'], ['f', 'accept', 'pass'],
      ['g', 'accept', 'pass'], ['h', 'reject', 'pass'], ['i', 'reject', 'pass'],
      ['j', 'reject', 'pass'],
    ])
    const out = judgeAgreement(rows)
    expect(out).toEqual({ agreed: 7, total: 10, meetsFloor: false })
    // A judge that disagrees with her is not a strict judge, it is a wrong one,
    // and the fix is the rubric rather than the users.
    expect(AGREEMENT_FLOOR).toBe(0.8)
  })

  it('passes at exactly the floor and not below it', () => {
    const at = table(Array.from({ length: 10 }, (_, i) =>
      [`p${i}`, 'accept', i < 8 ? 'pass' : 'fail'] as [string, 'accept', 'pass' | 'fail']))
    expect(judgeAgreement(at).meetsFloor).toBe(true)
    const below = table(Array.from({ length: 10 }, (_, i) =>
      [`p${i}`, 'accept', i < 7 ? 'pass' : 'fail'] as [string, 'accept', 'pass' | 'fail']))
    expect(judgeAgreement(below).meetsFloor).toBe(false)
  })

  it('treats an empty calibration set as a calibration nobody performed', () => {
    expect(judgeAgreement([])).toEqual({ agreed: 0, total: 0, meetsFloor: false })
  })
})

const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}
const FLIGHTS: FlightSearch = {
  kind: 'flight', from: 'LGW', to: 'FAO',
  departureDate: '2026-09-19', returnDate: '2026-09-26', flexDays: 0,
  adults: 2, children: 0, infants: 1, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

/**
 * A `GateOutcome` the gates would approve, built out of `mockSuppliers` the way
 * test/grade.test.ts builds its rehydrated items: the seed-1 world's third stay
 * is `Quinta da Ria` and its first flight is the direct one, which is the
 * rubric's own PASS example spelled in items rather than in prose.
 */
async function approvedOutcome(): Promise<GateOutcome> {
  const suppliers = mockSuppliers()
  const stays = await suppliers.hotel.search(STAY)
  const flights = await suppliers.flight.search(FLIGHTS)
  const stay = stays[2]!
  const flight = flights[0]!
  const items: RehydratedItem[] = [
    { ref: { sourceId: flight.sourceId, quantity: 1, slot: 'flight' }, item: flight, lineTotal: flight.price },
    { ref: { sourceId: stay.sourceId, quantity: 1, slot: 'stay' }, item: stay, lineTotal: stay.price },
  ]
  return { ok: true, items, total: sumMoney(items.map((i) => i.lineTotal)) }
}

/** One leg, compliant, with whatever the case under test needs changed on it. */
const leg = (over: Partial<LegSummary> = {}): LegSummary => ({
  from: 'LGW', to: 'FAO',
  departureLocal: '2026-09-19T09:00:00', arrivalLocal: '2026-09-19T12:00:00',
  stops: 0, route: ['LGW', 'FAO'], cabinClass: 'Economy',
  carriers: ['TP'], flightNumbers: ['TP100'], ...over,
})

const flightLine = (over: Partial<FlightDetail> = {}): RehydratedItem => ({
  ref: { sourceId: 'flight-synthetic', quantity: 1, slot: 'flight' },
  item: {
    sourceId: 'flight-synthetic', supplier: 'mock', kind: 'flight',
    name: 'TAP LGW to FAO', price: money(32_100n, 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-08-29T10:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'flight', outbound: leg(), inbound: leg({ from: 'FAO', to: 'LGW' }),
      baggage: { personalItem: 2, cabinBag: 1, checkedBag: 1 },
      totalDurationSeconds: 12_600, selfTransfer: false, ...over,
    } satisfies FlightDetail,
  },
  lineTotal: money(32_100n, 'EUR'),
})

const stayLine = (over: Partial<HotelDetail> = {}): RehydratedItem => ({
  ref: { sourceId: 'hotel-synthetic', quantity: 1, slot: 'stay' },
  item: {
    sourceId: 'hotel-synthetic', supplier: 'mock', kind: 'hotel',
    name: 'Quinta da Ria, Faro', price: money(69_300n, 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-08-29T10:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'hotel', checkIn: '2026-09-19', checkOut: '2026-09-26', nights: 7,
      rating: 4, coordinates: { lat: 37.02, lon: -7.93 }, offerSource: 'mock.example', ...over,
    } satisfies HotelDetail,
  },
  lineTotal: money(69_300n, 'EUR'),
})

const itinerary = (...items: RehydratedItem[]): GateOutcome =>
  ({ ok: true, items, total: sumMoney(items.map((i) => i.lineTotal)) })

/** Nothing on it trips a rule, so it is what every violating payload is read against. */
const compliant = () => itinerary(flightLine(), stayLine())

describe('every fail rule can fire on what the judge is actually shown', () => {
  // The finding this answers is that three of the first draft's four rules read
  // fields no `SupplierItem` carries, so the judge could never fail on them and
  // an unread pass rate would have hidden it. Naming real fields is half the
  // fix. The other half is showing that a violating itinerary renders with the
  // violating value ON THE WIRE, which needs no model and no key: `renderForJudge` is
  // the whole of what the judge sees, so a property it does not print is a
  // property no rubric can decide.
  const cases: { rule: string; field: string; payload: GateOutcome; shows: string }[] = [
    {
      rule: 'more than one connection outbound', field: 'stops',
      payload: itinerary(flightLine({ outbound: leg({ stops: 2, route: ['LGW', 'MAD', 'BCN', 'FAO'] }) }), stayLine()),
      shows: '"stops":2',
    },
    {
      rule: 'more than one connection inbound', field: 'stops',
      payload: itinerary(flightLine({ inbound: leg({ from: 'FAO', to: 'LGW', stops: 3 }) }), stayLine()),
      shows: '"stops":3',
    },
    {
      rule: 'a self transfer', field: 'selfTransfer',
      payload: itinerary(flightLine({ selfTransfer: true }), stayLine()),
      shows: '"selfTransfer":true',
    },
    {
      rule: 'a journey over fourteen hours', field: 'totalDurationSeconds',
      payload: itinerary(flightLine({ totalDurationSeconds: 54_000 }), stayLine()),
      shows: '"totalDurationSeconds":54000',
    },
    {
      rule: 'a departure before six in the morning', field: 'departureLocal',
      payload: itinerary(flightLine({ outbound: leg({ departureLocal: '2026-09-19T05:15:00' }) }), stayLine()),
      shows: '"departureLocal":"2026-09-19T05:15:00"',
    },
    {
      rule: 'an arrival after ten at night', field: 'arrivalLocal',
      payload: itinerary(flightLine({ outbound: leg({ arrivalLocal: '2026-09-19T23:40:00' }) }), stayLine()),
      shows: '"arrivalLocal":"2026-09-19T23:40:00"',
    },
    {
      rule: 'a stay shorter than two nights', field: 'nights',
      payload: itinerary(flightLine(), stayLine({ nights: 1, checkOut: '2026-09-20' })),
      shows: '"nights":1',
    },
    {
      rule: 'a stay rated below three', field: 'rating',
      payload: itinerary(flightLine(), stayLine({ rating: 2 })),
      shows: '"rating":2',
    },
  ]

  for (const c of cases) {
    it(`puts ${c.rule} on the wire, where the rubric reads it`, () => {
      const rendered = renderForJudge(c.payload)
      expect(rendered).toContain(c.shows)
      // The rule that reads it is in the rubric, so the pair is a rule that can
      // fire rather than a field that happens to be printed.
      expect(loadJudgePrompt().prompt).toContain(c.field)
      // And the compliant itinerary does not carry it, so the assertion above
      // discriminates rather than matching anything this function prints.
      expect(renderForJudge(compliant())).not.toContain(c.shows)
    })
  }

  it('shows the judge the total and one line per item, and nothing else', () => {
    const rendered = renderForJudge(compliant())
    expect(rendered.split('\n')).toHaveLength(3)
    expect(rendered.split('\n')[0]).toBe('total \u20ac1,014.00')
    expect(rendered).toContain('flight: TAP LGW to FAO (mock, \u20ac321.00) {')
    expect(rendered).toContain('stay: Quinta da Ria, Faro (mock, \u20ac693.00) {')
  })

  it('renders a refused outcome as nothing at all, because there is no question to ask', () => {
    expect(renderForJudge({ ok: false, violations: [{ gate: 'budget', detail: 'over', sourceIds: [] }] }))
      .toBe('')
  })
})

/**
 * `EVAL_LIMITS` with the cross-user global ceiling lifted above what the
 * account has already spent today.
 *
 * The same reason `dailyOnly` gives in test/handler.test.ts: the global ceiling
 * is cross-user and per UTC day and `whichCeiling` (src/engine.ts) checks it
 * first, so without this a judge case would report `account` on a database with
 * enough eval runs behind it and pass on an empty one. Read from today's ACTUAL
 * total inside the transaction rather than set to a large constant, because
 * deleting rows this test does not own to force a clean slate is what the
 * sibling case in that file says never to do.
 */
async function judgeLimits(sql: postgres.Sql, over: Partial<Limits> = {}): Promise<Limits> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(cost_micros), 0)::text as total
      from course.daily_usage where day = (now() at time zone 'utc')::date`
  return {
    ...EVAL_LIMITS,
    // Today's total plus the eval day's own ceiling, which is four dollars of
    // headroom against a reservation of a few thousand micros.
    globalCeilingMicros: BigInt(row!.total) + EVAL_LIMITS.dailyCeilingMicros,
    ...over,
  }
}

/** The one reply shape a judge is asked for, hand-written. No key, no recording, no network. */
const verdictReply = (verdict: 'pass' | 'fail', reason: string) =>
  textMessage(JSON.stringify({ verdict, reason }),
    // `_request_id` is the SDK's own out-of-band field and is not on `Message`,
    // which is why `callModel` reads it through a cast too.
    { _request_id: 'req_judge' } as unknown as Partial<Message>)

describeDb('the judge, billed and recorded', () => {
  it('writes a reviewer row that names no turn, and settles its own reservation', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const client = fakeClient([verdictReply('pass', 'Direct flights and seven nights.')])
      const verdict = await runJudge(
        {
          sql, client, ctx: judgeContext({ userId, conversationId: c!.id }),
          limits: await judgeLimits(sql), now: Date.now,
        },
        await approvedOutcome(),
      )
      expect(verdict).toEqual({ verdict: 'pass', reason: 'Direct flights and seven nights.' })

      const [row] = await sql<{
        seat: string; model_config_id: string; turn_id: string | null
        conversation_id: string; cost_micros: string; request_id: string | null
      }[]>`select seat, model_config_id, turn_id, conversation_id, cost_micros, request_id
             from course.model_calls where user_id = ${userId}`
      expect(row!.seat).toBe('reviewer')
      expect(row!.model_config_id).toBe(SEATS.reviewer.modelConfigId)
      // The shipped shape, pinned. `evals/run.ts` builds this context through
      // the same `judgeContext`, so the row production writes is the row this
      // case reads. A turn id here would add an offline grader's bill to what
      // her turn is recorded as having cost, because `turnSpendMicros`
      // (src/repo/spend.ts) sums a turn's calls with no seat filter.
      expect(row!.turn_id).toBeNull()
      expect(row!.conversation_id).toBe(c!.id)
      // The provider's own id for the call, which a support conversation about
      // one has nothing to quote without.
      expect(row!.request_id).toBe('req_judge')

      // The ledger settled to what the call really cost rather than to what was
      // reserved for it, through `reserve` and `reconcile` and no fifth writer.
      const expected = costMicros(SEATS.reviewer.model,
        { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '5m')
      expect(BigInt(row!.cost_micros)).toBe(expected)
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${c!.id}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(expected)
      const [day] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.daily_usage
         where user_id = ${userId} and day = (now() at time zone 'utc')::date`
      expect(BigInt(day!.cost_micros)).toBe(expected)
    })
  })

  it('stops the pass at a ceiling, without calling the model and without keeping the debit', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      // Queued with nothing: `fakeClient` throws when a call it was not given a
      // reply for is made, so this case fails loudly if the ceiling is checked
      // after the model rather than before it.
      const client = fakeClient([])
      const deps = {
        sql, client, ctx: judgeContext({ userId, conversationId: c!.id }),
        limits: await judgeLimits(sql, { conversationCeilingMicros: 1n }), now: Date.now,
      }
      await expect(runJudge(deps, await approvedOutcome())).rejects.toThrow(JudgeCappedError)
      expect(client.calls).toBe(0)
      // Refunded, so a capped pass leaves nothing reserved against the
      // conversation it was about to bill. A stranded reservation fails closed,
      // which is safe and is still a number nobody can explain later.
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${c!.id}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(0n)
      const rows = await sql`select seat from course.model_calls where user_id = ${userId}`
      expect(rows).toHaveLength(0)
    })
  })

  it('judges nothing the gates refused, and bills nothing for it', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const client = fakeClient([])
      const verdict = await runJudge(
        {
          sql, client, ctx: judgeContext({ userId, conversationId: c!.id }),
          limits: await judgeLimits(sql), now: Date.now,
        },
        { ok: false, violations: [{ gate: 'budget', detail: 'over the budget', sourceIds: [] }] },
      )
      expect(verdict).toBeNull()
      expect(client.calls).toBe(0)
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${c!.id}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(0n)
    })
  })
})

describeDb('her decided proposals', () => {
  /** One proposal on its own conversation, optionally answered. */
  const proposalFor = async (
    sql: postgres.Sql, userId: string, conversationId: string, decision?: 'accept' | 'reject',
  ): Promise<string> => {
    const id = await recordProposal(sql, {
      conversationId, userId, turnId: null,
      refs: [{ sourceId: `src-${randomUUID()}`, quantity: 1, slot: 'stay' }],
      requirementsSnapshot: emptyNotebook(),
    })
    if (decision) await decideProposal(sql, { proposalId: id, conversationId, decision })
    return id
  }

  it('returns the answered ones newest first and leaves the unanswered one out', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const older = await proposalFor(sql, userId, c!.id, 'accept')
      const newer = await proposalFor(sql, userId, c!.id, 'reject')
      const undecided = await proposalFor(sql, userId, c!.id)

      const rows = await decidedProposals(sql, { limit: 100 })
      const ids = rows.map((p) => p.id)
      // An undecided proposal is not a label: she has not answered it, and
      // counting silence as either answer is how a calibration set comes to
      // disagree with the person it was built from.
      expect(ids).not.toContain(undecided)
      // Newest first, by `seq` and never by `created_at`: two rows written
      // inside one millisecond order arbitrarily by a timestamp, so the hundred
      // a limit takes would be a different hundred on a re-run.
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
      expect(rows.find((p) => p.id === newer)!.decision).toBe('reject')
      expect(rows.find((p) => p.id === older)!.decidedAt).toBeInstanceOf(Date)
    })
  })

  it('scopes to one traveller when it is asked to', async () => {
    await withTestDb(async (sql) => {
      const mine = randomUUID()
      const theirs = randomUUID()
      const [a] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${mine}) returning id`
      const [b] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${theirs}) returning id`
      const ours = await proposalFor(sql, mine, a!.id, 'accept')
      const other = await proposalFor(sql, theirs, b!.id, 'accept')

      const rows = await decidedProposals(sql, { userId: mine })
      expect(rows.map((p) => p.id)).toEqual([ours])
      expect(rows.map((p) => p.id)).not.toContain(other)
    })
  })

  it('takes the limit it is given, so a nightly pass cannot grow without one', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      await proposalFor(sql, userId, c!.id, 'accept')
      await proposalFor(sql, userId, c!.id, 'accept')
      expect(await decidedProposals(sql, { userId, limit: 1 })).toHaveLength(1)
    })
  })
})

/**
 * The recording this case replays, which is not in the tree at this commit.
 *
 * It is gated rather than assumed, and gated the way `describeDb`
 * (test/helpers/db.ts) and `describeLiveModel` (test/helpers/live.ts) gate: a
 * printed reason at module scope and a skip, because a fixture that is missing
 * has to read as a check nobody ran rather than as a red suite or, worse, as a
 * green one. `replayClient` throws on a missing file, so without this gate the
 * absence would land as a failure naming a path instead of a sentence naming
 * what is owed. The command that closes it is in README.md's residuals.
 *
 * `RECORD_MODEL=1` opens the gate, because a gate that skipped the one case
 * that writes the fixture would be a gate nobody could ever close: that is the
 * mode `replayClient` records in, and it needs to reach the call.
 *
 * What it adds over the two cases above, which drive the same function with a
 * hand-written reply, is the only thing a recording can add: that a real model
 * asked this rubric this question answered in a shape `parseVerdict` can read.
 */
const FIXTURE = new URL('./fixtures/model/judge-family-fit.json', import.meta.url)
const hasJudgeFixture = existsSync(FIXTURE) || process.env.RECORD_MODEL === '1'
if (!hasJudgeFixture) {
  console.warn(
    'No test/fixtures/model/judge-family-fit.json: skipping the replayed judge. Record it with '
  + 'RECORD_MODEL=1 and ANTHROPIC_API_KEY set. The judge\'s parse, its rubric, its ledger and its '
  + 'agreement arithmetic are covered above and need no recording.',
  )
}
const describeReplayedJudge = hasJudgeFixture ? describeDb : describe.skip

describeReplayedJudge('the judge, replayed', () => {
  // What a recorded verdict can prove is the parse and the row: it pins one
  // afternoon's answer to one itinerary and says nothing whatever about the
  // judge's calibration, which is what `judgeAgreement` asserts above over a
  // table nobody recorded.
  it('returns a verdict and a reason, and prices its own call', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [c] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const client = replayClient('judge-family-fit')
      const verdict = await runJudge(
        {
          sql, client, ctx: judgeContext({ userId, conversationId: c!.id }),
          limits: await judgeLimits(sql), now: Date.now,
        },
        await approvedOutcome(),
      )
      expect(verdict).not.toBeNull()
      expect(['pass', 'fail']).toContain(verdict!.verdict)
      expect(verdict!.reason.length).toBeGreaterThan(0)
      const rows = await sql<{ seat: string; model_config_id: string; cost_micros: string }[]>`
        select seat, model_config_id, cost_micros from course.model_calls where user_id = ${userId}`
      expect(rows[0]!.seat).toBe('reviewer')
      expect(rows[0]!.model_config_id).toBe(SEATS.reviewer.modelConfigId)
      expect(BigInt(rows[0]!.cost_micros)).toBeGreaterThan(0n)
      client.done()
    })
  })
})
