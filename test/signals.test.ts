import { SIGNALS, renderSignals } from '../src/loop/signals.js'
import { describeDb, withTestDb } from './helpers/db.js'

describe('the signal ranking', () => {
  it('ranks three signals and not four, and none of them is a click', () => {
    expect(SIGNALS.map((s) => s.signal)).toEqual(['her decision', 'her edits', 'her booking'])
    expect(renderSignals(SIGNALS)).not.toContain('click')
  })

  it('names the edit as a tool call and not as a third decision value', () => {
    const edits = SIGNALS.find((s) => s.signal === 'her edits')!
    expect(edits.home).toBe('turns')
    expect(edits.perRow).toContain('revise_component')
  })
})

describeDb('every signal has a table', () => {
  it('names a table this schema really has', async () => {
    await withTestDb(async (sql) => {
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'course'`
      const names = tables.map((t) => t.table_name)
      // The check that makes the `home` column worth carrying: a signal whose
      // home does not exist is the shape of every unfalsifiable loop metric.
      for (const signal of SIGNALS) expect(names).toContain(signal.home)
    })
  })
})
