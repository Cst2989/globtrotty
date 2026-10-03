// Deliberately thin — see web/messagesRoute.ts's header comment for why a
// Route Handler file can export only the recognised HTTP-method functions.
// All the real logic (and the `makeChoose` seam test/web-api-choose.test.ts
// calls directly) lives in web/chooseRoute.ts.
export { postChoose as POST } from '@/web/chooseRoute'
