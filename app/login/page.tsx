import type { LoginErrorCode } from '@/app/auth/callback/route'
import { LoginForm } from './login-form'

// Fixed, non-echoing sentence per code — see `app/auth/callback/route.ts`'s
// doc comment (fix round 1, Minor) for why a raw Supabase
// `error_description` is never rendered directly.
const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  expired: 'That sign-in link expired. Enter your email below to get a new one.',
  invalid: 'That sign-in link is no longer valid. Enter your email below to get a new one.',
  unknown: 'We could not complete sign-in. Enter your email below to try again.',
}

function isLoginErrorCode(value: string): value is LoginErrorCode {
  return value === 'expired' || value === 'invalid' || value === 'unknown'
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const rawError = params.error
  const errorCode = typeof rawError === 'string' && isLoginErrorCode(rawError) ? rawError : null

  return (
    <div>
      {errorCode ? <p role="alert">{ERROR_MESSAGES[errorCode]}</p> : null}
      <LoginForm />
    </div>
  )
}
