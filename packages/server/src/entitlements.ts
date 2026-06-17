// Open-core seam. The OSS app is UNLIMITED by default (self-host has no caps and
// no billing). The hosted deployment injects a real resolver via
// setEntitlementsResolver() — reading its OWN subscription store, which lives in
// the private cloud overlay, NOT in this open-source schema. No billing tables,
// Stripe ids, or plan rows ever belong in this repo.

export interface Entitlements {
  planName: string // shown in the UI so users know their account ("Self-hosted", "Hobby", "Pro")
  maxDocs: number // across the user's workspaces
  teamWorkspaces: boolean // may create/own team (collaborative) workspaces
  maxCollaboratorsPerDoc: number // people who can be granted access to a single doc (email + link)
  maxMembersPerWorkspace: number // people in a team workspace (incl. the owner's seat-free invites)
  versionHistory: boolean // history + revert
  apiCallsPerMonth: number // metered by the cloud overlay; OSS does not meter
  trashRetentionDays: number // window for seeing/restoring deleted docs & workspaces
}

export const UNLIMITED: Entitlements = {
  planName: 'Self-hosted',
  maxDocs: Infinity,
  teamWorkspaces: true,
  maxCollaboratorsPerDoc: Infinity,
  maxMembersPerWorkspace: Infinity,
  versionHistory: true,
  apiCallsPerMonth: Infinity,
  trashRetentionDays: 90,
}

/** JSON can't carry Infinity; send unlimited as null so the client renders "∞". */
export function serializeEntitlements(e: Entitlements) {
  const n = (v: number) => (v === Infinity ? null : v)
  return {
    ...e,
    maxDocs: n(e.maxDocs),
    maxCollaboratorsPerDoc: n(e.maxCollaboratorsPerDoc),
    maxMembersPerWorkspace: n(e.maxMembersPerWorkspace),
    apiCallsPerMonth: n(e.apiCallsPerMonth),
  }
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
 * principal (from the session JWT). Wired in only when BILLING=clerk.
 * If features are unknown (non-browser principals like dd_ tokens), stays unlimited.
 */
// Plans (by Clerk slug) drive entitlements:
//   'pro'   → unlocks everything (the paid upgrade; renamed from 'individual')
//   anything else → Hobby, the $1/mo entry plan (same caps as the old Free
//     tier). There is no free tier anymore; existing free users are treated as
//     Hobby, so any non-Pro plan resolves here.
// planName undefined → non-browser principal (dd_ token) → unlimited (not
// enforced on the CLI yet).
export async function clerkEntitlements(p: Principal): Promise<Entitlements> {
  if (p.kind !== 'user' || p.planName === undefined) return UNLIMITED
  const paid = p.planName === 'pro'
  return {
    planName: paid ? 'Pro' : 'Hobby',
    maxDocs: Infinity, // unlimited personal docs on every plan
    teamWorkspaces: paid,
    maxCollaboratorsPerDoc: paid ? Infinity : 2,
    maxMembersPerWorkspace: paid ? 5 : 0, // only Pro can own team workspaces
    versionHistory: paid,
    apiCallsPerMonth: paid ? 10000 : 500,
    trashRetentionDays: paid ? 90 : 15,
  }
}

/** Thrown by gates when an action exceeds the user's plan. */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanLimitError'
  }
}
