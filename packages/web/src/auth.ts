// Bridge so non-React modules (api.ts) and the websocket can fetch the current
// Clerk session token. <AuthBridge> registers Clerk's getToken on mount.
type TokenGetter = () => Promise<string | null>

let getter: TokenGetter = async () => null

export function setTokenGetter(fn: TokenGetter) {
  getter = fn
}

export async function getToken(): Promise<string> {
  return (await getter()) ?? ''
}
