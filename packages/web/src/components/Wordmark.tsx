import { Link } from 'react-router-dom'

// mdocs wordmark: a keycap "m" (like a key on a keyboard, matching the favicon)
// + the name, with a "by The Data Company" byline.
export function Wordmark() {
  return (
    <Link to="/" className="wordmark">
      <span className="keycap" aria-hidden="true">
        m
      </span>
      <span className="wordmark-text">
        <span className="name">mdocs</span>
        <span className="tagline">by The Data Company</span>
      </span>
    </Link>
  )
}
