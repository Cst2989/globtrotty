import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import { offerForModel } from './supplier/mock.js'
import type { MockSupplier } from './supplier/mock.js'

const FlightInput = z.object({
  from: z.string().describe('IATA code of the departure airport'),
  to: z.string().describe('IATA code of the arrival airport'),
  departureDate: z.string().describe('yyyy-mm-dd'),
  returnDate: z.string().nullable().describe('yyyy-mm-dd, or null for one way'),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
})
const HotelInput = z.object({
  city: z.string(),
  checkIn: z.string().describe('yyyy-mm-dd'),
  checkOut: z.string().describe('yyyy-mm-dd'),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
})

/** Every tool the product owns, in one list; a desk sees a subset (lesson 1.6). */
export const TOOLS: Tool[] = [
  {
    name: 'search_flights',
    description: 'Search return flights between two airports. Returns offers with a price the supplier quoted; quote those prices exactly, never a total.',
    input_schema: z.toJSONSchema(FlightInput) as Tool['input_schema'],
  },
  {
    name: 'search_hotels',
    description: 'Search hotels in a city for a stay. Returns offers priced for the whole stay; quote those prices exactly.',
    input_schema: z.toJSONSchema(HotelInput) as Tool['input_schema'],
  },
]

export type ToolOutcome = { content: string; isError: boolean }
export type ToolRunner = (name: string, input: unknown) => Promise<ToolOutcome>

/** Runs a tool against the mock supplier; a bad input comes back as an error the model can read and correct. */
export function mockRunner(supplier: MockSupplier): ToolRunner {
  return async (name, input) => {
    try {
      if (name === 'search_flights') {
        return { content: JSON.stringify(supplier.searchFlights(FlightInput.parse(input)).map(offerForModel)), isError: false }
      }
      if (name === 'search_hotels') {
        return { content: JSON.stringify(supplier.searchHotels(HotelInput.parse(input)).map(offerForModel)), isError: false }
      }
      return { content: `Unknown tool ${name}`, isError: true }
    } catch (err) {
      return { content: `Invalid input for ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}
