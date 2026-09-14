import { randomUUID } from 'node:crypto'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

describeDb('which proposals became bookings, at lesson-6-6', () => {
  it('has no table to ask', async () => {
    await withTestDb(async (sql) => {
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'course'`
      // P4 rests the whole loop on bookings.proposal_id. There is no bookings
      // table on this branch and there never will be: this product hands off,
      // so the row that says a trip happened is written by somebody else and
      // reported back to us. The only join key we own is the sub-id the cashier
      // minted before it built the URL, and the table it lands on does not exist.
      expect(tables.map((t) => t.table_name)).not.toContain('bookings')
      expect(tables.map((t) => t.table_name)).not.toContain('conversions')
    })
  })

  it('has one column that measures a click, and nothing writes it', async () => {
    await withTestDb(async (sql) => {
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'course' and table_name = 'link_clicks'`
      // The column is here, from 0013, and it is the tempting one.
      expect(columns.map((c) => c.column_name)).toContain('clicked_at')
      const clicked = await sql<{ n: number }[]>`
        select count(*)::int as n from course.link_clicks where clicked_at is not null`
      // And it is empty, in every environment, because no code path anywhere
      // sets it. Step 4 pins that as a grep rather than as a count.
      expect(clicked[0]!.n).toBe(0)
    })
  })

  it('would report a link nobody booked as a success, if we built the rate', async () => {
    // The rate a link-out product reaches for first, written out in full so the
    // lesson can refuse a real thing rather than a described one.
    const clickThroughRate = (emitted: number, clicked: number): string =>
      `${clicked}/${emitted}`
    // Three links went out for her Portugal trip. She opened two and booked
    // none, because the hotel wanted a fourteen night minimum she found on the
    // supplier's page. This rate calls that a 67% success.
    expect(clickThroughRate(3, 2)).toBe('2/3')
    // P4 says it plainly: a link-out product that treats click-through as its
    // success signal is measuring the attractiveness of a link, not the quality
    // of a trip. The number is real, it is cheap, and it answers the wrong
    // question, which is the most expensive kind of number to put on a card.
  })
})
