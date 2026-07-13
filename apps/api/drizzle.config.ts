import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  // Migrations exécutées par le rôle OWNER (DDL + RLS + fonction SECURITY DEFINER).
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
})
