import postgres from 'postgres'
import { env } from '../env.js'

// Raw client for the transactional persistence paths (advisory locks, byteas);
// drizzle is used for schema definition / migrations.
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
})
