import { UserButton } from '@clerk/clerk-react'

// Clerk user button with a custom dropdown item linking to the account/usage page.
export function UserMenu() {
  return (
    <UserButton>
      <UserButton.MenuItems>
        <UserButton.Link
          label="Usage & activity"
          labelIcon={<span style={{ fontSize: 14, lineHeight: 1 }}>📊</span>}
          href="/account"
        />
      </UserButton.MenuItems>
    </UserButton>
  )
}
