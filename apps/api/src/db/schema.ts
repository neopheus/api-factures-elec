import type { Invoice } from '@factelec/invoice-core'
import {
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
