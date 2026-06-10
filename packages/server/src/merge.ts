import { diff_match_patch } from 'diff-match-patch'
import { merge as diff3Merge } from 'node-diff3'
import type * as Y from 'yjs'

const dmp = new diff_match_patch()

export interface MergeResult {
  clean: boolean
  text: string // merged text (with conflict markers if !clean)
}

/**
 * Line-based 3-way merge: `base` is the common ancestor (the version the client
 * pulled), `ours` is the client's working text, `theirs` is current head.
 * Returns merged text and whether it merged without conflicts.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  // merge(a, o, b): a=ours, o=base (ancestor), b=theirs. Line-based.
  const region = diff3Merge(ours, base, theirs, { stringSeparator: '\n' })
  return { clean: !region.conflict, text: region.result.join('\n') }
}

/** Apply the minimal char-level edits to turn `ytext` (currently `from`) into `to`. */
export function applyTextEdits(ytext: Y.Text, from: string, to: string): void {
  const diffs = dmp.diff_main(from, to)
  dmp.diff_cleanupSemantic(diffs)
  let index = 0
  for (const [op, data] of diffs) {
    if (op === 0) {
      index += data.length // equal
    } else if (op === 1) {
      ytext.insert(index, data) // insert
      index += data.length
    } else {
      ytext.delete(index, data.length) // delete
    }
  }
}
