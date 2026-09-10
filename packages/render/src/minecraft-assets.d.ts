/**
 * `minecraft-assets` 没有类型声明，也没有 `@types` 包。
 *
 * 这里只声明我们实际用到的那一小块；其余形状在 `colors.ts` 里收窄。
 * loader 返回的是 PC/Bedrock 联合类型，所以外面通过 `as unknown as` 收窄。
 */
declare module 'minecraft-assets' {
  interface TextureEntry {
    name?: string
    /** `data:image/png;base64,...` */
    texture?: string
  }

  interface Assets {
    version?: string
    directory?: string
    textureContent: Record<string, TextureEntry>
    blocksStates?: Record<string, unknown>
    blocksModels?: Record<string, unknown>
    getTexture?: (name: string) => TextureEntry | null
  }

  const loader: (version: string) => Assets
  export default loader
}
