/**
 * Trip-stage pass, section 2: what the results pane shows, as ONE pure function of what the
 * server has and what the screen is optimistically claiming.
 *
 * The screenshots at 16.24 are the reason this exists. The pane was deciding, in eight separate
 * places in its own JSX, whether to draw a skeleton, a pinned card, a list, a map, a summary and
 * a button — and the combinations nobody had written a condition for were the ones she saw: the
 * hotels list still open underneath the stay she had already chosen, a `Proposed trip` card in
 * the chat saying the same thing as the pinned block beside it, a totals row that was one item's
 * own price. A layout is not eight independent booleans; it is one answer with four values, and
 * this is that answer. `test/web-pane-layout.test.ts` pins every stage.
 *
 * Pure: no hooks, no DOM, no clock.
 */
import type { LinkLite, ProposalRowLite, ResultsView, SkeletonMode } from '@/web/data'
import type { PendingAction } from './pending'

export type PaneStage =
  /** Nothing chosen: the flights list, with its bar, filters and tabs. */
  | 'flights'
  /** A flight is chosen: it is pinned, and the stays are the list. */
  | 'hotels'
  /** A stay is chosen too and the proposal is undecided: both pinned, with a total and Accept. */
  | 'trip'
  /** The trip is accepted: no Change buttons, and the booking links. */
  | 'accepted'

export type PaneAction =
  /** Nothing to press: she is still choosing. */
  | 'none'
  /** `Accept this trip`. */
  | 'accept'
  /** `Accept the updated trip` — the cashier replaced an item and wants her word on it. */
  | 'accept_updated'
  /** `Checking prices and getting your booking links…`. */
  | 'working'
  /** One primary button per item, from `proposal.links`. */
  | 'book'
  /** The turn failed; the reason and `Try again`. */
  | 'retry'

export type PaneLayout = {
  stage: PaneStage
  /**
   * The one placeholder at the top of the pane, or `null`. Never beside a list of the same kind,
   * which was the other half of the 16.24 complaint.
   */
  skeleton: 'flights' | 'hotels' | 'trip' | null
  /** The chosen flight's `sourceId`, server-recorded or optimistic. */
  chosenFlight: string | null
  chosenHotel: string | null
  /** A `Chosen flight` / `Chosen hotel` card is pinned at the top. */
  pinFlight: boolean
  pinHotel: boolean
  /** The flights list, with its own bar, filters and tabs, is on screen. */
  flightsOpen: boolean
  /** The hotels list, its filters and the map are on screen. */
  hotelsOpen: boolean
  /** The hotels list is behind an `Other hotels` disclosure rather than being the pane's subject. */
  hotelsCollapsible: boolean
  /** The flight / stay / total / per person block. */
  totals: boolean
  /** `Change` is offered on the pinned cards. Gone once the trip is accepted. */
  changeable: boolean
  action: PaneAction
  /** The reviewer's own words, as an amber note, or empty. */
  issues: string[]
  /** An item of the newest proposal that the cashier replaced after the accept. */
  updatedSlots: string[]
}

export type PaneLayoutInput = {
  /** Every `results` row, oldest first. */
  results: ResultsView[]
  /** The NEWEST proposal, links included — `loadProposals`'s own first row, or `null`. */
  proposal: (ProposalRowLite & { links: LinkLite[] }) | null
  /**
   * The newest proposal that is both ACCEPTED and holds a stay, links included.
   *
   * Not `proposal.decision === 'accept'`: `handleChooseFlight` records a flights-only proposal
   * and accepts it immediately (that acceptance is how the office remembers the flight, not a
   * decision about a trip), so the flights-only row is accepted for the whole of the hotels
   * stage. Only a proposal with a stay in it means the trip was accepted.
   */
  acceptedProposal: (ProposalRowLite & { links: LinkLite[] }) | null
  /** What the screen is claiming ahead of the server — `web/components/pending.ts`. */
  pending: PendingAction | null
  /** `web/data.ts`'s own `skeletonMode`. */
  skeleton?: SkeletonMode
  /** `conversations.status`. */
  status?: string
  /** She pressed `Change` on the pinned flight. */
  flightsExpanded?: boolean
  /** She pressed `Change` on the pinned stay, or opened `Other hotels`. */
  hotelsExpanded?: boolean
}

function newestOfKind(results: ResultsView[], kind: 'flights' | 'hotels'): ResultsView | null {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.kind === kind) return results[i]!
  }
  return null
}

function sourceIdOf(proposal: ProposalRowLite | null, kind: 'flight' | 'hotel'): string | null {
  return proposal?.items.find((i) => i.kind === kind)?.sourceId ?? null
}

/**
 * Exactly one layout. See `PaneLayout` for what each field means and the file comment for why
 * this is one function rather than eight conditions spread through a render.
 */
export function paneLayout(input: PaneLayoutInput): PaneLayout {
  const {
    results, proposal, acceptedProposal, pending,
    skeleton = null, status, flightsExpanded = false, hotelsExpanded = false,
  } = input

  const newestFlights = newestOfKind(results, 'flights')
  const newestHotels = newestOfKind(results, 'hotels')

  const pendingFlight = pending?.kind === 'choose_flight' ? pending.sourceId ?? null : null
  const pendingHotel = pending?.kind === 'choose_hotel' ? pending.sourceId ?? null : null

  // The server's own answer wins when both exist: an optimistic id is a guess about what the
  // proposal is going to say, and once it says it there is nothing left to guess about.
  const chosenFlight = sourceIdOf(proposal, 'flight') ?? sourceIdOf(acceptedProposal, 'flight') ?? pendingFlight
  const chosenHotel = sourceIdOf(proposal, 'hotel') ?? sourceIdOf(acceptedProposal, 'hotel') ?? pendingHotel

  const proposalHasStay = proposal?.items.some((i) => i.kind === 'hotel') ?? false
  const accepted = acceptedProposal !== null
  const swapped = accepted
    && proposal !== null
    && proposal.decision === null
    && proposal.id !== acceptedProposal.id
    && proposalHasStay

  const stage: PaneStage = accepted
    ? 'accepted'
    : proposalHasStay
      ? 'trip'
      : chosenFlight !== null
        ? 'hotels'
        : 'flights'

  // Section 2's last rule, and the one the screenshots caught: a placeholder never stands beside
  // a list of the same kind. The trip placeholder has the same shape of condition — it is only
  // honest while there is no proposal with a stay to replace it.
  const tripSkeleton = pending?.kind === 'choose_hotel' && !proposalHasStay && !accepted
  const hotelsSkeleton = !tripSkeleton
    && newestHotels === null
    && (pending?.kind === 'choose_flight' || skeleton === 'hotels')
  const fullSkeleton = skeleton === 'full' && newestFlights === null && newestHotels === null

  const paneSkeleton: PaneLayout['skeleton'] = fullSkeleton
    ? 'flights'
    : tripSkeleton
      ? 'trip'
      : hotelsSkeleton
        ? 'hotels'
        : null

  // The card is only pinnable when the row it came from still carries it; a refreshed list that
  // dropped the id leaves the list open rather than a card that cannot be drawn.
  const flightItemPresent = chosenFlight !== null
    && (newestFlights?.items.some((i) => i.sourceId === chosenFlight) ?? false)
  const hotelItemPresent = chosenHotel !== null
    && (newestHotels?.items.some((i) => i.sourceId === chosenHotel) ?? false)

  const pinFlight = stage !== 'flights' && flightItemPresent
  const pinHotel = (stage === 'trip' || stage === 'accepted') && hotelItemPresent

  const flightsOpen = fullSkeleton
    ? false
    : stage === 'flights'
      ? newestFlights !== null
      : (flightsExpanded && newestFlights !== null)

  const hotelsOpen = fullSkeleton || newestHotels === null
    ? false
    : stage === 'trip'
      ? hotelsExpanded
      // Accepted: she is past choosing, so the list is not offered at all. At every other stage
      // a hotels row on the page IS the list.
      : stage !== 'accepted'

  const links = (swapped ? acceptedProposal?.links : proposal?.links) ?? []
  const failed = status === 'failed'
  const handingOff = pending?.kind === 'accept'
    || (stage === 'accepted' && links.length === 0 && status === 'working')

  const action: PaneAction = stage === 'flights' || stage === 'hotels'
    ? 'none'
    : failed
      ? 'retry'
      : handingOff
        ? 'working'
        : swapped
          ? 'accept_updated'
          : stage === 'accepted'
            ? (links.length > 0 ? 'book' : 'working')
            : 'accept'

  const shown = swapped ? proposal : (stage === 'accepted' ? acceptedProposal : proposal)
  const issues = shown?.gateOutcome === 'shipped_unapproved' ? shown.reviewIssues : []

  // Which of the newest proposal's items the cashier replaced: the slots whose `sourceId` is not
  // the one she accepted. Only meaningful while `swapped`.
  const updatedSlots = swapped && acceptedProposal
    ? proposal!.items
      .filter((i) => !acceptedProposal.items.some((a) => a.slot === i.slot && a.sourceId === i.sourceId))
      .map((i) => i.slot)
    : []

  return {
    stage,
    skeleton: paneSkeleton,
    chosenFlight,
    chosenHotel,
    pinFlight,
    pinHotel,
    flightsOpen,
    hotelsOpen,
    hotelsCollapsible: stage === 'trip' && newestHotels !== null,
    totals: stage === 'trip' || stage === 'accepted',
    changeable: stage !== 'accepted',
    action,
    issues,
    updatedSlots,
  }
}

/** The fixed sentence an `Updated` badge carries. Never a supplier's own words about why. */
export const UPDATED_REASON = 'Sold out; replaced'
