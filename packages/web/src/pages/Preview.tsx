import type { ComponentProps, JSX } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Sanitization: react-markdown does NOT render raw HTML by default (it is
// escaped as text) and we deliberately do not add rehype-raw. Block-level
// elements carry data-line (source line from remark positions) — the MVP's
// block-level position mapping for toggle/double-click-to-edit.

const BLOCK_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'table',
  'hr',
] as const

function withSourceLine(tag: (typeof BLOCK_TAGS)[number]) {
  const Tag = tag as keyof JSX.IntrinsicElements
  return function Block({ node, ...props }: ComponentProps<'div'> & { node?: unknown }) {
    const line = (node as { position?: { start?: { line?: number } } })?.position?.start?.line
    // @ts-expect-error -- dynamic intrinsic tag
    return <Tag {...props} data-line={line} />
  }
}

const components = Object.fromEntries(
  BLOCK_TAGS.map((tag) => [tag, withSourceLine(tag)]),
) as Components

export function Preview({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
