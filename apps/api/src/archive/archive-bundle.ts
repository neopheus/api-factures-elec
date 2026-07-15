import { createHash } from 'node:crypto'

export interface BundleFormat {
  kind: string
  contentType: string
  bodyText: string | null
  bodyBytes: Buffer | null
  byteSize: number
}
// Événement du bundle : identité probative (tenant, seq) — JAMAIS le PK
// surrogate `id` (cf. SealedEvent du repository, même parti pris). N'ajoutez
// pas de champ `id` ici.
export interface BundleEvent {
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: string // ISO
  prevHash: string // hex
  hash: string // hex
}
export interface ArchiveBundleInput {
  tenantId: string
  invoiceId: string
  canonical: unknown
  formats: BundleFormat[]
  events: BundleEvent[]
}
export interface ArchiveManifest {
  version: 'v1'
  tenantId: string
  invoiceId: string
  formats: {
    kind: string
    contentType: string
    byteSize: number
    sha256: string
  }[]
  ledger: { seq: number; hash: string; prevHash: string }[]
  contentHash: string // sha256 des octets du bundle (renseigné après sérialisation)
}

function formatBytes(f: BundleFormat): Buffer {
  return f.bodyBytes ?? Buffer.from(f.bodyText ?? '', 'utf8')
}

// Bundle probatoire d'une facture : canonique + 5 formats (base64) + extrait
// scellé du journal + manifeste d'empreintes. Sérialisation à ordre de clés
// FIGÉ → octets déterministes (empreinte reproductible).
export function buildArchiveBundle(input: ArchiveBundleInput): {
  key: string
  content: Buffer
  manifest: ArchiveManifest
} {
  const formats = input.formats.map((f) => ({
    kind: f.kind,
    contentType: f.contentType,
    byteSize: f.byteSize,
    sha256: createHash('sha256').update(formatBytes(f)).digest('hex'),
    base64: formatBytes(f).toString('base64'),
  }))
  const document = {
    version: 'v1' as const,
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    canonical: input.canonical,
    formats,
    ledger: input.events,
  }
  const content = Buffer.from(JSON.stringify(document), 'utf8')
  const manifest: ArchiveManifest = {
    version: 'v1',
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    formats: formats.map(({ kind, contentType, byteSize, sha256 }) => ({
      kind,
      contentType,
      byteSize,
      sha256,
    })),
    ledger: input.events.map((e) => ({
      seq: e.seq,
      hash: e.hash,
      prevHash: e.prevHash,
    })),
    contentHash: createHash('sha256').update(content).digest('hex'),
  }
  return {
    key: `${input.tenantId}/${input.invoiceId}/v1.bundle.json`,
    content,
    manifest,
  }
}
