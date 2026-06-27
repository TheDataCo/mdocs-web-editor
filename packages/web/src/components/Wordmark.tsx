import { Link } from 'react-router-dom'

// mdocs wordmark: a keycap "m" (like a key on a keyboard, matching the favicon)
// + the name, with a "Docs for Markdown" byline.
export function Wordmark() {
  return (
    <Link to="/" className="wordmark">
      <span className="keycap" aria-hidden="true">
        m
      </span>
      <span className="wordmark-text">
        <span className="name">mdocs</span>
        <span className="tagline">Docs for Markdown</span>
      </span>
    </Link>
  )
}
