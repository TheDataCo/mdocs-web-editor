// When served from the datadocs server (prod), API + WS share the page origin.
// Locally, Vite serves on :5173 and the server is on :3001, so fall back to env
// overrides (set in packages/web/.env.local or the dev command).
const origin = typeof window !== 'undefined' ? window.location.origin : ''
const wsOrigin = origin.replace(/^http/, 'ws')

export const WS_URL = import.meta.env.VITE_WS_URL ?? wsOrigin
export const API_URL = import.meta.env.VITE_API_URL ?? origin
// Shared demo token until per-user auth (milestone 3). Baked into the client.
export const TOKEN = import.meta.env.VITE_COLLAB_TOKEN ?? 'dev-token'
