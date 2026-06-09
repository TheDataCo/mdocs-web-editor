// One-off: create a Clerk user (bypasses waitlist, which only gates sign-up).
// Usage: CLERK_SECRET_KEY=sk_... EMAIL=you@x.com PASSWORD=... tsx scripts/create-user.ts
import { createClerkClient } from '@clerk/backend'

const secretKey = process.env.CLERK_SECRET_KEY
const email = process.env.EMAIL
const password = process.env.PASSWORD
if (!secretKey || !email || !password) {
  throw new Error('need CLERK_SECRET_KEY, EMAIL, PASSWORD')
}

const clerk = createClerkClient({ secretKey })
const user = await clerk.users.createUser({
  emailAddress: [email],
  password,
  skipPasswordChecks: true,
  skipLegalChecks: true,
})
console.log(`created user ${user.id} for ${email}`)
