import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  apiKeys,
  formatKind,
  invoiceFormats,
  invoiceStatus,
  invoices,
  tenants,
} from '../../src/db/schema.js'

describe('db schema (Drizzle)', () => {
  it('declares the invoice_status and format_kind enums used by the tables', () => {
    expect(invoiceStatus.enumValues).toEqual([
      'received',
      'generated',
      'failed',
    ])
    expect(formatKind.enumValues).toEqual([
      'ubl',
      'cii',
      'facturx',
      'flux_base',
      'flux_full',
    ])
  })

  it('names tables to match the generated SQL migration', () => {
    expect(getTableConfig(tenants).name).toBe('tenants')
    expect(getTableConfig(apiKeys).name).toBe('api_keys')
    expect(getTableConfig(invoices).name).toBe('invoices')
    expect(getTableConfig(invoiceFormats).name).toBe('invoice_formats')
  })

  it('tenants has no tenant_id column (it IS the tenant) and defaults an id', () => {
    const { columns } = getTableConfig(tenants)
    const names = columns.map((c) => c.name)
    expect(names).toEqual(['id', 'name', 'siren', 'created_at'])
    expect(names).not.toContain('tenant_id')
  })

  it('api_keys enforces a unique prefix and indexes tenant_id, FK-ing to tenants', () => {
    const {
      columns,
      uniqueIndexes: _unused,
      indexes,
      foreignKeys,
    } = getTableConfig(apiKeys) as ReturnType<typeof getTableConfig> & {
      uniqueIndexes?: unknown
    }
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'tenant_id',
      'prefix',
      'secret_hash',
      'label',
      'created_at',
      'last_used_at',
      'revoked_at',
    ])
    expect(indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining(['api_keys_prefix_unique', 'api_keys_tenant_idx']),
    )
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]?.reference().foreignTable).toBe(tenants)
  })

  it('invoices carries the canonical jsonb payload and a per-tenant unique number', () => {
    const { columns, indexes, foreignKeys } = getTableConfig(invoices)
    const canonical = columns.find((c) => c.name === 'canonical')
    expect(canonical?.notNull).toBe(true)
    expect(canonical?.dataType).toBe('json')
    expect(indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining([
        'invoices_tenant_number_unique',
        'invoices_tenant_created_idx',
      ]),
    )
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]?.reference().foreignTable).toBe(tenants)
  })

  it('invoice_formats stores raw bytes via the custom bytea type and FKs to both tenants and invoices', () => {
    const { columns, indexes, foreignKeys } = getTableConfig(invoiceFormats)
    const bodyBytes = columns.find((c) => c.name === 'body_bytes')
    expect(bodyBytes?.getSQLType()).toBe('bytea')
    expect(indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining([
        'invoice_formats_invoice_kind_unique',
        'invoice_formats_tenant_idx',
      ]),
    )
    expect(foreignKeys).toHaveLength(2)
    const referencedTables = foreignKeys.map(
      (fk) => fk.reference().foreignTable,
    )
    expect(referencedTables).toContain(tenants)
    expect(referencedTables).toContain(invoices)
  })
})
