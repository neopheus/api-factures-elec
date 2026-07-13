import {
  generateCii,
  generateFacturX,
  generateFluxExtractUbl,
  generateUbl,
  type Invoice,
} from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import type {
  FormatKind,
  GeneratedFormat,
  InvoiceFormatGenerator,
} from './format-generator.port.js'

const XML = 'application/xml'
const PDF = 'application/pdf'

function text(
  kind: FormatKind,
  contentType: string,
  body: string,
): GeneratedFormat {
  return {
    kind,
    contentType,
    bodyText: body,
    bodyBytes: null,
    byteSize: Buffer.byteLength(body),
  }
}
function bytes(
  kind: FormatKind,
  contentType: string,
  body: Buffer,
): GeneratedFormat {
  return {
    kind,
    contentType,
    bodyText: null,
    bodyBytes: body,
    byteSize: body.length,
  }
}

@Injectable()
export class SynchronousFormatGenerator implements InvoiceFormatGenerator {
  // eslint: méthode async pour respecter le port (future file BullMQ).
  async generate(invoice: Invoice): Promise<GeneratedFormat[]> {
    const formats: GeneratedFormat[] = [
      text('ubl', XML, generateUbl(invoice)),
      text('cii', XML, generateCii(invoice)),
      bytes('facturx', PDF, Buffer.from(await generateFacturX(invoice))),
    ]
    if (invoice.businessProcessType) {
      formats.push(
        text('flux_base', XML, generateFluxExtractUbl(invoice, 'BASE')),
      )
      formats.push(
        text('flux_full', XML, generateFluxExtractUbl(invoice, 'FULL')),
      )
    }
    return formats
  }
}
