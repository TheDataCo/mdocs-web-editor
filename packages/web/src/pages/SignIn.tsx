import { SignIn, SignUp } from '@clerk/clerk-react'
import { DataFlow } from '../components/DataFlow'

// Branded auth pages (replacing the Clerk-hosted redirect): dark brand panel
// with the datacoweb token-stream animation + the Clerk card on the right.
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-brand">
        <DataFlow className="auth-anim" />
        <div className="auth-brand-inner">
          <div className="wordmark auth-wordmark">
            <span className="keycap">m</span>
            <div className="wordmark-text">
              <span className="name">mdocs</span>
              <span className="tagline">Docs for Markdown</span>
            </div>
          </div>
          <h1>Markdown docs for humans and agents.</h1>
          <p>
            The same document, live in your browser and your terminal. Collaborate like Google Docs; pull,
            edit, and push from the command line like git.
          </p>
        </div>
      </aside>
      <main className="auth-card">{children}</main>
    </div>
  )
}

export function SignInPage() {
  return (
    <AuthShell>
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </AuthShell>
  )
}

export function SignUpPage() {
  return (
    <AuthShell>
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/" />
    </AuthShell>
  )
}
