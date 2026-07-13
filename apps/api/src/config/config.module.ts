import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './env.js'

// Global : ConfigService<EnvConfig, true> injectable partout.
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateEnv,
})
