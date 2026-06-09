import { Link } from 'react-router-dom'

// mdocs wordmark — Inter, tight tracking, in the minimal monochrome style of
// The Data Company. Tagline hides on narrow screens.
export function Wordmark() {
  return (
    <Link to="/" className="wordmark">
      <span className="name">mdocs</span>
      <span className="tagline">Docs for Markdown</span>
    </Link>
  )
}
