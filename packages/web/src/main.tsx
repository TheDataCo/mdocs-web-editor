import { ClerkProvider, RedirectToSignIn, SignedIn, SignedOut, useAuth } from '@clerk/clerk-react'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { setTokenGetter } from './auth'
import { CLERK_PUBLISHABLE_KEY } from './config'
import { DocListPage } from './pages/DocList'
import { EditorPage } from './pages/Editor'
import './style.css'

const router = createBrowserRouter([
  { path: '/', element: <DocListPage /> },
  { path: '/d/:id', element: <EditorPage /> },
])

// Register Clerk's getToken so api.ts and the websocket can fetch session tokens.
function AuthBridge() {
  const { getToken, isLoaded } = useAuth()
  useEffect(() => {
    setTokenGetter(() => getToken())
  }, [getToken])
  if (!isLoaded) return null
  return <RouterProvider router={router} />
}

createRoot(document.getElementById('root')!).render(
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/">
    <SignedIn>
      <AuthBridge />
    </SignedIn>
    <SignedOut>
      <RedirectToSignIn />
    </SignedOut>
  </ClerkProvider>,
)
