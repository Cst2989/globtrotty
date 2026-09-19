import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabase } from '@/web/supabase/server'

/** Magic-link redirect target: exchanges the OTP `code` for a session cookie, then sends the user home. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')

  if (code) {
    const supabase = await createServerSupabase()
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(new URL('/', request.url))
}
