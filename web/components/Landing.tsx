import { MessageBox } from './MessageBox'

const SUGGESTIONS = [
  'A week in Portugal in September for two',
  'Long weekend in Copenhagen, flying from Berlin',
  'Ten days in Japan in spring, mid-range hotels',
]

/**
 * The empty state for a new conversation: a greeting, three prompt chips,
 * and the composer. Server component; `MessageBox` is the client island.
 */
export function Landing() {
  return (
    <div className="landing">
      <div className="landing-inner">
        <div>
          <h1>Where would you like to go?</h1>
          <p>
            Describe the trip in your own words: where, roughly when, who is going and what matters
            to you. The desk searches live flights and hotels and comes back with a plan to react to.
          </p>
        </div>
        <MessageBox
          conversationId="new"
          suggestions={SUGGESTIONS}
          placeholder="A week in Portugal in September for two..."
        />
      </div>
    </div>
  )
}
