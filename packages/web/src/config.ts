// When served from the datadocs server (prod), API + WS share the page origin.
// Locally, Vite serves on :5173 and the server is on :3001, so .env.local sets
// VITE_API_URL / VITE_WS_URL.
const origin = typeof window !== 'undefined' ? window.location.origin : ''
const wsOrigin = origin.replace(/^http/, 'ws')

export const WS_URL = import.meta.env.VITE_WS_URL ?? wsOrigin
export const API_URL = import.meta.env.VITE_API_URL ?? origin
export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
// Hosted deployment sets VITE_BILLING=clerk to enforce plan limits; self-host leaves
// it unset → everything unlimited (no upgrade gates).
export const BILLING_ON = import.meta.env.VITE_BILLING === 'clerk'
