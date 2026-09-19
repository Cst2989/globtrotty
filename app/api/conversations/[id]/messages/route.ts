// Deliberately thin: Next's generated route types reject any export from a
// Route Handler file besides the recognised HTTP-method functions and a
// handful of special names — see `web/messagesRoute.ts`'s header comment
// for the build error that proved it. All the real logic (and the
// `makePost` seam `test/web-api-messages.test.ts` calls directly) lives
// there.
export { postMessages as POST } from '@/web/messagesRoute'
