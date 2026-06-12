// Open-core seam. The OSS app is UNLIMITED by default (self-host has no caps and
// no billing). The hosted deployment injects a real resolver via
// setEntitlementsResolver() — reading its OWN subscription store, which lives in
// the private cloud overlay, NOT in this open-source schema. No billing tables,
// Stripe ids, or plan rows ever belong in this repo.

export interface Entitlements {
  planName: string // shown in the UI so users know their account ("Self-hosted", "Free", "Individual")
  maxDocs: number // across the user's workspaces
  teamWorkspaces: boolean // may create/own team (collaborative) workspaces
  maxCollaborators: number // distinct people a user may share their docs with
  versionHistory: boolean // history + revert
  apiCallsPerMonth: number // metered by the cloud overlay; OSS does not meter
}

export const UNLIMITED: Entitlements = {
  planName: 'Self-hosted',
  maxDocs: Infinity,
  teamWorkspaces: true,
  maxCollaborators: Infinity,
  versionHistory: true,
  apiCallsPerMonth: Infinity,
}

/** JSON can't carry Infinity; send unlimited as null so the client renders "∞". */
export function serializeEntitlements(e: Entitlements) {
  const n = (v: number) => (v === Infinity ? null : v)
  return { ...e, maxDocs: n(e.maxDocs), maxCollaborators: n(e.maxCollaborators), apiCallsPerMonth: n(e.apiCallsPerMonth) }
}

import type { Principal } from './auth.js'

let resolver: (p: Principal) => Promise<Entitlements> = async () => UNLIMITED

/** Hosted overlay calls this at startup to enforce paid plans. OSS leaves it default. */
export function setEntitlementsResolver(fn: (p: Principal) => Promise<Entitlements>): void {
  resolver = fn
}

export function getEntitlements(principal: Principal): Promise<Entitlements> {
  return resolver(principal)
}

/**
 * Hosted resolver: derive entitlements from Clerk Billing features carried on the
 * principal (from the session JWT). Wired in only when MDOCS_BILLING=clerk.
 * If features are unknown (non-browser principals like dd_ tokens), stays unlimited.
 */
// Plans (by slug) drive entitlements: 'individual' unlocks everything; anything
// else (incl. 'free_user') is the Free tier. planName undefined → non-browser
// principal (dd_ token) → unlimited (not enforced on the CLI yet).
export async function clerkEntitlements(p: Principal): Promise<Entitlements> {
  if (p.kind !== 'user' || p.planName === undefined) return UNLIMITED
  const paid = p.planName === 'individual'
  return {
    planName: paid ? 'Individual' : 'Free',
    maxDocs: Infinity, // unlimited personal docs on both plans
    teamWorkspaces: paid,
    maxCollaborators: paid ? Infinity : 1,
    versionHistory: paid,
    apiCallsPerMonth: paid ? 10000 : 500,
  }
}

/** Thrown by gates when an action exceeds the user's plan. */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanLimitError'
  }
}
