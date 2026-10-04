// Deliberately thin — see web/messagesRoute.ts's header comment for why a
// Route Handler file can export only the recognised HTTP-method functions.
// All the real logic (and the `makeRefresh` seam test/web-api-refresh.test.ts
// calls directly) lives in web/refreshRoute.ts.
export { postRefresh as POST } from '@/web/refreshRoute'
