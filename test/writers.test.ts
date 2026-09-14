import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Every file under src/, so the walk cannot miss a directory somebody adds. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join('src', f))
}

/**
 * Which files contain a statement that writes one table.
 *
 * A grep and not a type, because the thing being pinned is a fact about the
 * whole tree rather than about one module's exports: the defect this guards
 * against is a SECOND writer appearing somewhere nobody was looking, and a
 * type can only see the callers that already import it.
 */
function writersOf(table: string): string[] {
  const statement = new RegExp(`(insert into|update)\\s+course\\.${table}\\b`)
  return sourceFiles()
    .filter((f) => statement.test(readFileSync(path.join(SRC, '..', f), 'utf8')))
    .sort()
}

describe('what already writes to each table this lesson touches', () => {
  it('has exactly one writer of course.link_clicks', () => {
    // recordLinkClicks, called by handOffToBooking and by nothing else. The
    // sub-id minting this lesson was about to design already exists, three
    // lessons old, and this is how the lesson knows that without reading the
    // whole of src/ by hand.
    expect(writersOf('link_clicks')).toEqual(['src/repo/linkClicks.ts'])
  })

  it('has exactly one writer of course.proposals', () => {
    // recordProposal and decideProposal, in one file. Two statements, one
    // module, one door.
    expect(writersOf('proposals')).toEqual(['src/repo/proposals.ts'])
  })

  it('has exactly one writer of course.user_memory', () => {
    // Pinned here rather than in lesson 7.4, because 7.4 adds a caller of
    // rememberUserFact and this is the check that tells it whether it is adding
    // a caller or a second writer. LL3 section 21: B2 duplicated the spend
    // writer and B3 duplicated the tool_calls writer, and both were invisible
    // to every test because no test exercised the seam.
    expect(writersOf('user_memory')).toEqual(['src/repo/memory.ts'])
  })

  it('never writes course.link_clicks.clicked_at anywhere', () => {
    const setsIt = sourceFiles()
      .filter((f) => /clicked_at/.test(readFileSync(path.join(SRC, '..', f), 'utf8')))
    // The column exists since 0013 and has no writer, which is the same shape
    // 0013's own proposals comment warns about: a column added for a reader
    // that does not exist is a column nobody keeps correct. This lesson does
    // NOT add the writer. A click-through rate measures the attractiveness of a
    // link, and this module is about the quality of a trip.
    expect(setsIt).toEqual([])
  })
})
