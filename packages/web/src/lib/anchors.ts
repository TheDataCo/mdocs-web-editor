import * as Y from 'yjs'

// Encode/decode Yjs RelativePositions as base64 strings (how comment anchors are
// stored in the Y.Map). Shared by the comments panel and the editor highlights.
export const encodeAnchor = (r: Y.RelativePosition): string =>
  btoa(String.fromCharCode(...Y.encodeRelativePosition(r)))

export const decodeAnchor = (s: string): Y.RelativePosition =>
  Y.decodeRelativePosition(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
