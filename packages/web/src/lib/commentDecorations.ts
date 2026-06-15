import { type CommentValue, DOC_COMMENTS_FIELD } from '@mdocs/core'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { decodeAnchor } from './anchors'

// Highlights for open, anchored comments. Decorations map through edits
// automatically; we push a fresh set whenever the comments map changes.
export const setCommentMarks = StateEffect.define<DecorationSet>()

export const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) {
      // Mapping can throw if the set holds a position past the change's start
      // doc — e.g. marks computed against the Y.Doc land before yCollab's
      // initial insert (a "changeset of length 0") populates CodeMirror. That
      // throw runs inside transaction application, so it would corrupt the
      // editor for EVERY later transaction (blank pane, typing does nothing).
      // Drop stale marks instead; refreshMarks repopulates them, clamped.
      try {
        deco = deco.map(tr.changes)
      } catch {
        deco = Decoration.none
      }
    }
    for (const e of tr.effects) if (e.is(setCommentMarks)) deco = e.value
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const mark = Decoration.mark({ class: 'cm-comment-mark' })

// `maxLen` is the length of the CodeMirror document the marks will be applied
// to. Comment anchors resolve against the Y.Doc, which during load can be
// populated a transaction ahead of CodeMirror — a range past the editor's end
// makes dispatch throw, so clamp to maxLen and drop ranges that start past it.
export function computeCommentMarks(doc: Y.Doc, maxLen = Number.POSITIVE_INFINITY): DecorationSet {
  const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
  const ranges: [number, number][] = []
  for (const c of ymap.values()) {
    if (c.status !== 'open' || !c.anchorStart || !c.anchorEnd) continue
    const s = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorStart), doc)
    const e = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorEnd), doc)
    if (!s || !e) continue
    const from = s.index
    const to = Math.min(e.index, maxLen)
    if (from >= maxLen || to <= from) continue
    ranges.push([from, to])
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const builder = new RangeSetBuilder<Decoration>()
  for (const [from, to] of ranges) builder.add(from, to, mark)
  return builder.finish()
}
