// Deliberately thin — see web/messagesRoute.ts's header comment for why a
// Route Handler file can export only the recognised HTTP-method functions.
// All the real logic (and the `makeDecide` seam test/web-api-proposals.test.ts
// calls directly) lives in web/decideRoute.ts.
export { postDecide as POST } from '@/web/decideRoute'
