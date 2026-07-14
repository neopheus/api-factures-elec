import type { Invoice } from '@factelec/invoice-core'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// bytea : non natif dans drizzle-orm — type sur mesure pour les octets Factur-X.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const invoiceStatus = pgEnum('invoice_status', [
  'received',
  'generated',
  'failed',
])
export const formatKind = pgEnum('format_kind', [
  'ubl',
  'cii',
  'facturx',
  'flux_base',
  'flux_full',
])

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  siren: text('siren'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_unique').on(t.prefix),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
)

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    typeCode: text('type_code').notNull(),
    issueDate: text('issue_date').notNull(),
    currency: text('currency').notNull(),
    status: invoiceStatus('status').notNull().default('received'),
    canonical: jsonb('canonical').$type<Invoice>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_tenant_number_unique').on(t.tenantId, t.number),
    index('invoices_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
)

export const invoiceFormats = pgTable(
  'invoice_formats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: formatKind('kind').notNull(),
    contentType: text('content_type').notNull(),
    bodyText: text('body_text'),
    bodyBytes: bytea('body_bytes'),
    byteSize: integer('byte_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_formats_invoice_kind_unique').on(t.invoiceId, t.kind),
    index('invoice_formats_tenant_idx').on(t.tenantId),
  ],
)

export const userRole = pgEnum('user_role', [
  'owner',
  'admin',
  'accountant',
  'viewer',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('owner'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_tenant_idx').on(t.tenantId),
  ],
)

export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_admins_email_unique').on(sql`lower(${t.email})`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => platformAdmins.id, {
      onDelete: 'cascade',
    }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_expires_idx').on(t.expiresAt),
    check(
      'sessions_subject_xor',
      sql`(${t.userId} IS NULL) <> (${t.adminId} IS NULL)`,
    ),
    check(
      'sessions_admin_no_tenant',
      sql`${t.adminId} IS NULL OR ${t.tenantId} IS NULL`,
    ),
  ],
)
