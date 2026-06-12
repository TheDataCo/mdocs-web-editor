import { PricingTable } from '@clerk/clerk-react'
import { Wordmark } from '../components/Wordmark'

// Clerk renders the plans + runs Stripe checkout. No billing code on our side.
export function PricingPage() {
  return (
    <>
      <div className="topbar">
        <Wordmark />
      </div>
      <div className="pricing-wrap">
        <h2>Plans</h2>
        <PricingTable />
      </div>
    </>
  )
}
