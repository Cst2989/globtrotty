// Deliberately thin — see web/messagesRoute.ts's header comment for why a
// Route Handler file can export only the recognised HTTP-method functions.
// All the real logic (and the `makeRevise` seam test/api-proposals.test.ts
// calls directly) lives in web/reviseRoute.ts.
export { postRevise as POST } from '@/web/reviseRoute'
