import { UserButton } from '@clerk/clerk-react'

// Clerk user button with a custom dropdown item linking to the account/usage page.
export function UserMenu() {
  return (
    <UserButton>
      <UserButton.MenuItems>
        <UserButton.Link
          label="Usage & activity"
          labelIcon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="6" y1="20" x2="6" y2="13" />
              <line x1="12" y1="20" x2="12" y2="5" />
              <line x1="18" y1="20" x2="18" y2="10" />
            </svg>
          }
          href="/account"
        />
      </UserButton.MenuItems>
    </UserButton>
  )
}
