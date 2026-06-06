import { defineConfig } from 'drizzle-kit'
import './src/env.js' // loads .env from the monorepo root

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
