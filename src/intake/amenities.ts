/**
 * The amenities this office has words of its own for, and how to recognise them in a
 * supplier's vocabulary.
 *
 * One table, three consumers that MUST agree: the amenity chips on a hotel card
 * (web/components/HotelCard.tsx), the Amenities popover in the filter bar, and both filter
 * implementations (`applyFilter` over the corpus, `applyFilterLite` over the lite shape). They
 * disagreed the moment there were two copies: the recorded Tokyo response alone contains
 * "Free Wi-Fi", "Parking ($)", "Paid parking", "Kitchen in some rooms", "Kitchen in rooms" and
 * "Outdoor pool", so a filter matching on equality finds nothing a chip showed.
 *
 * Matching is case-insensitive SUBSTRING, because Google's vocabulary is neither ours nor
 * stable. The key is ours and never leaves this repo; the label is what she reads; the patterns
 * are the only part that knows about a supplier at all.
 */
export const AMENITIES = [
  { key: 'wifi', label: 'Wifi', patterns: ['wi-fi', 'wifi', 'wi fi'] },
  { key: 'breakfast', label: 'Breakfast', patterns: ['breakfast'] },
  { key: 'kitchen', label: 'Kitchen', patterns: ['kitchen'] },
  { key: 'pool', label: 'Pool', patterns: ['pool'] },
  { key: 'parking', label: 'Parking', patterns: ['parking'] },
  { key: 'air_conditioning', label: 'Air conditioning', patterns: ['air conditioning', 'air-conditioning'] },
  { key: 'gym', label: 'Gym', patterns: ['gym', 'fitness'] },
  { key: 'spa', label: 'Spa', patterns: ['spa', 'sauna'] },
] as const

export type AmenityKey = typeof AMENITIES[number]['key']

export const AMENITY_KEYS: readonly string[] = AMENITIES.map((a) => a.key)

/**
 * The subset the filter bar offers, in the order it offers them.
 *
 * Shorter than `AMENITIES` on purpose: a card has room to MENTION a gym or a spa when a property
 * has one, and a popover of eight checkboxes is a wall. These six are the ones a traveller
 * narrows on.
 */
export const FILTER_AMENITY_KEYS: readonly string[] = [
  'wifi', 'breakfast', 'kitchen', 'pool', 'parking', 'air_conditioning',
]

/** The key's own label, or the key itself for one this table no longer carries. */
export function amenityLabel(key: string): string {
  return AMENITIES.find((a) => a.key === key)?.label ?? key
}

/** `true` when any of `labels` is this amenity, by the patterns above. */
export function hasAmenity(labels: string[], key: string): boolean {
  const amenity = AMENITIES.find((a) => a.key === key)
  if (!amenity) return false
  const lower = labels.map((l) => l.toLowerCase())
  return amenity.patterns.some((pattern) => lower.some((l) => l.includes(pattern)))
}

/**
 * The amenity keys a stay has, in this table's own order — what a card turns into chips.
 *
 * Order is the table's, not the supplier's: a traveller scanning a list of cards is comparing
 * the same fact in the same place on each one, and reordering it per property defeats that.
 */
export function amenityKeysOf(labels: string[]): string[] {
  return AMENITIES.filter((a) => hasAmenity(labels, a.key)).map((a) => a.key)
}
