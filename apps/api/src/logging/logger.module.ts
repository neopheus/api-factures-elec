import { ConfigModule, ConfigService } from '@nestjs/config'
import { LoggerModule } from 'nestjs-pino'
import type { EnvConfig } from '../config/env.js'

// Options pino brutes, extraites pour être testables unitairement (redaction)
// sans démarrer une application Nest complète.
export function buildPinoHttpOptions(logLevel: EnvConfig['LOG_LEVEL']) {
  return {
    level: logLevel,
    autoLogging: true,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'req.body',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
    },
  }
}

// Logs JSON structurés. Redaction stricte : aucun secret ni PII de facture.
export const AppLoggerModule = LoggerModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvConfig, true>) => ({
    pinoHttp: buildPinoHttpOptions(config.get('LOG_LEVEL', { infer: true })),
  }),
})
