import { SignIn, SignUp } from '@clerk/clerk-react'
import { AgentDemo } from '../components/AgentDemo'

// Branded auth pages (replacing the Clerk-hosted redirect): dark brand panel
// with a looping agent-workflow demo + the Clerk card on the right.
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <div className="wordmark auth-wordmark">
            <span className="keycap">m</span>
            <div className="wordmark-text">
              <span className="name">mdocs</span>
              <span className="tagline">by The Data Company</span>
            </div>
          </div>
          <h1>Work with your agent.</h1>
          <p>
            The same document, live in your browser and your terminal. You write like Google Docs; your
            agent pulls, edits, and pushes from the command line like git.
          </p>
          <AgentDemo />
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
