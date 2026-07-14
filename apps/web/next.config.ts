import type { NextConfig } from 'next'

// lint = Biome (racine), pas ESLint. `eslint` n'est plus une clé reconnue par NextConfig en
// 16.2.10 (avertissement "Unrecognized key(s)" empirique à Task 8) — de toute façon sans
// effet puisque le paquet `eslint` n'est pas installé (`next build` saute l'étape silencieusement).
const config: NextConfig = {
  reactStrictMode: true,
}
export default config
