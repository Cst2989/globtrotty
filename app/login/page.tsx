import { Compass, Receipt, ShieldCheck, Clock } from '@phosphor-icons/react/dist/ssr'
import type { LoginErrorCode } from '@/app/auth/callback/route'
import { LoginForm } from './login-form'

// Fixed, non-echoing sentence per code. See `app/auth/callback/route.ts`'s
// doc comment for why a raw Supabase `error_description` is never rendered.
const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  expired: 'That sign-in link expired. Enter your email to get a new one.',
  invalid: 'That sign-in link is no longer valid. Enter your email to get a new one.',
  unknown: 'Sign-in did not complete. Enter your email to try again.',
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
    <main className="login">
      <section className="login-brand" aria-labelledby="login-headline">
        <span className="wordmark">
          <Compass size={22} weight="duotone" aria-hidden="true" />
          Globetrotty
        </span>

        <div>
          <h1 id="login-headline" className="login-headline">
            Tell me where you want to go.
          </h1>
          <p className="login-sub">
            A travel desk that searches real flights and hotels, puts a plan in front of you, and
            changes it when you ask.
          </p>
        </div>

        <ul className="login-facts">
          <li>
            <Receipt size={18} weight="regular" aria-hidden="true" />
            Live prices from the suppliers, with the time they were fetched
          </li>
          <li>
            <Clock size={18} weight="regular" aria-hidden="true" />
            Accept, reject, swap a flight or shift the dates in one click
          </li>
          <li>
            <ShieldCheck size={18} weight="regular" aria-hidden="true" />
            Never asks for payment or passport details
          </li>
        </ul>
      </section>

      <section className="login-form-side" aria-label="Sign in">
        <div className="login-card">
          {errorCode ? (
            <p className="alert" role="alert">
              {ERROR_MESSAGES[errorCode]}
            </p>
          ) : null}
          <LoginForm />
        </div>
      </section>
    </main>
  )
}
