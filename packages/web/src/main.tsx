import { ClerkProvider, RedirectToSignIn, SignedIn, SignedOut, useAuth } from '@clerk/clerk-react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { setTokenGetter } from './auth'
import { CLERK_PUBLISHABLE_KEY } from './config'
import { AccountPage } from './pages/Account'
import { CliAuthPage } from './pages/CliAuth'
import { DocListPage } from './pages/DocList'
import { EditorPage } from './pages/Editor'
import { PricingPage } from './pages/Pricing'
import { SignInPage, SignUpPage } from './pages/SignIn'
import './style.css'

// Signed-out visitors land on the in-app /sign-in page (branded) instead of
// the Clerk-hosted portal; RedirectToSignIn picks it up via ClerkProvider's
// signInUrl.
function Protected({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  )
}

const router = createBrowserRouter([
  { path: '/', element: <Protected><DocListPage /></Protected> },
  { path: '/d/:id', element: <Protected><EditorPage /></Protected> },
  { path: '/cli-auth', element: <Protected><CliAuthPage /></Protected> },
  { path: '/pricing', element: <Protected><PricingPage /></Protected> },
  { path: '/account', element: <Protected><AccountPage /></Protected> },
  { path: '/sign-in/*', element: <SignInPage /> },
  { path: '/sign-up/*', element: <SignUpPage /> },
])

// Register Clerk's getToken so api.ts and the websocket can fetch session tokens.
// Set it DURING render (not in an effect): child route effects run before parent
// effects, so an effect here would register the getter too late and the first
// API call would go out with an empty token (401).
function AuthBridge() {
  const { getToken, isLoaded } = useAuth()
  setTokenGetter(() => getToken())
  if (!isLoaded) return null
  return <RouterProvider router={router} />
}

createRoot(document.getElementById('root')!).render(
  <ClerkProvider
    publishableKey={CLERK_PUBLISHABLE_KEY}
    afterSignOutUrl="/"
    signInUrl="/sign-in"
    signUpUrl="/sign-up"
    appearance={{
      // Match the app: zero-chroma neutrals, Inter, 0.625rem radius.
      variables: {
        colorPrimary: '#1c1c1c',
        colorText: '#252525',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        borderRadius: '0.625rem',
      },
    }}
  >
    <AuthBridge />
  </ClerkProvider>,
)
