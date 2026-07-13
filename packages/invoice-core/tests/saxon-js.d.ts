declare module 'saxon-js' {
  function transform(
    options: unknown,
    mode: 'sync',
  ): { principalResult: string }
  const SaxonJS: { transform: typeof transform }
  export default SaxonJS
}
