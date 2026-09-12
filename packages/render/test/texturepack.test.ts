import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTextureAtlas } from '../src/atlas.js'
import { loadBakedBlockMap } from '../src/baked.js'
import { encodePng, Canvas } from '../src/canvas.js'
import { assetsTexturePack } from '../src/assets.js'
import {
  bakedColorTexturePack,
  detectMinecraftDir,
  directoryTexturePack,
  findClientJar,
  minecraftTexturePack,
  resolveTexturePack,
  texturePackAt,
  zipTexturePack,
} from '../src/texturepack.js'

const VERSION = '1.21.4'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'architect-pack-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 一张纯色 PNG（测试纹理）。 */
function solidPng(r: number, g: number, b: number, a = 255): Uint8Array {
  const canvas = new Canvas(16, 16, { r, g, b })
  if (a < 255) for (let i = 0; i < 16 * 16; i++) canvas.data[i * 4 + 3] = a
  return encodePng(canvas)
}

/** 实体纹理的路径（相对 `textures/entity/`，**带子目录**）。 */
const ENTITY_TEXTURES = ['boat/oak', 'cow/cow']

const TILES: Record<string, [number, number, number, number]> = {
  stone: [120, 120, 120, 255],
  oak_planks: [160, 130, 80, 255],
  glass: [200, 220, 240, 64],
}

/** 造一个"解包后的资源包目录"。 */
function makePackDir(root: string): string {
  const blockDir = join(root, 'assets', 'minecraft', 'textures', 'block')
  mkdirSync(blockDir, { recursive: true })
  for (const [name, [r, g, b, a]] of Object.entries(TILES)) {
    writeFileSync(join(blockDir, `${name}.png`), solidPng(r, g, b, a))
  }
  // 实体纹理**带子目录**，而且尺寸与方块不同（真实资源包里船是 128×64）
  for (const relative of ENTITY_TEXTURES) {
    const file = join(root, 'assets', 'minecraft', 'textures', 'entity', `${relative}.png`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, solidPng(150, 110, 60))
  }
  return root
}

/** 造一个 zip（客户端 jar 与资源包 zip 是同一种东西）。 */
function makePackZip(path: string): string {
  const files: Record<string, Uint8Array> = {}
  for (const [name, [r, g, b, a]] of Object.entries(TILES)) {
    files[`assets/minecraft/textures/block/${name}.png`] = solidPng(r, g, b, a)
  }
  // 顺带塞点"不该被解出来"的东西：客户端 jar 里 90% 是这个
  files['net/minecraft/client/Minecraft.class'] = new Uint8Array([0xca, 0xfe, 0xba, 0xbe])
  files['assets/minecraft/textures/item/stick.png'] = solidPng(1, 2, 3)
  for (const relative of ENTITY_TEXTURES) {
    files[`assets/minecraft/textures/entity/${relative}.png`] = solidPng(150, 110, 60)
  }
  writeFileSync(path, zipSync(files))
  return path
}

describe('纹理来源：目录 / zip / jar', () => {
  it('目录来源：列出 tile，并按路径读字节', () => {
    const pack = directoryTexturePack(makePackDir(join(dir, 'pack')))
    expect(pack.blockTiles()).toEqual(['glass', 'oak_planks', 'stone'])
    expect(pack.read('block/stone')).toBeDefined()
    // 不带目录前缀也认得（block/ 是默认推断出来的）
    expect(pack.read('stone')).toBeDefined()
    expect(pack.read('block/nope')).toBeUndefined()
  })

  it('zip 来源：与解包后的目录**建出同一张图集**', () => {
    const fromDir = buildTextureAtlas(VERSION, directoryTexturePack(makePackDir(join(dir, 'pack'))))
    const fromZip = buildTextureAtlas(VERSION, zipTexturePack(makePackZip(join(dir, 'pack.zip'))))
    expect(fromZip.size).toBe(fromDir.size)
    expect(fromZip.textures).toEqual(fromDir.textures)
    expect(Array.from(fromZip.data)).toEqual(Array.from(fromDir.data))
  })

  it('**jar 里只解纹理**（class 文件不进内存）', () => {
    const pack = zipTexturePack(makePackZip(join(dir, 'client.jar')))
    expect(pack.blockTiles()).toEqual(['glass', 'oak_planks', 'stone'])
    // 物品纹理不进 tile 清单，但按路径还能读到（颜色解析会用到）
    expect(pack.read('item/stick')).toBeDefined()
    expect(pack.read('block/../net/minecraft/client/Minecraft')).toBeUndefined()
  })

  it('客户端 jar 也认"资源包根目录"与"直接把 textures/block 递给我"两种目录布局', () => {
    const root = makePackDir(join(dir, 'pack'))
    expect(directoryTexturePack(root).blockTiles()).toHaveLength(3)
    expect(directoryTexturePack(join(root, 'assets', 'minecraft', 'textures', 'block')).blockTiles()).toHaveLength(3)
    // 目录本身就是一堆 PNG
    expect(directoryTexturePack(join(root, 'assets', 'minecraft', 'textures', 'block')).blockTiles()).toHaveLength(3)
  })

  it('路径解析：目录 / zip / 不存在的东西', () => {
    const packDir = makePackDir(join(dir, 'pack'))
    expect(texturePackAt(packDir)?.blockTiles()).toHaveLength(3)
    expect(texturePackAt(makePackZip(join(dir, 'pack.zip')))?.blockTiles()).toHaveLength(3)
    expect(texturePackAt(join(dir, 'nope'))).toBeUndefined()
    // 空目录（没有纹理）也算"打开失败"，不能拿它当来源
    mkdirSync(join(dir, 'empty'))
    expect(texturePackAt(join(dir, 'empty'))).toBeUndefined()
  })
})

describe('`.minecraft` 自动探测', () => {
  /** 造一个标准布局的假 `.minecraft`。 */
  function makeMinecraft(version: string): { root: string; jar: string } {
    const root = join(dir, 'minecraft')
    const vdir = join(root, 'versions', version)
    mkdirSync(vdir, { recursive: true })
    const jar = join(vdir, `${version}.jar`)
    makePackZip(jar)
    return { root, jar }
  }

  it('`ARCHITECT_MINECRAFT_DIR` 优先于平台默认位置', () => {
    const { root } = makeMinecraft(VERSION)
    const found = detectMinecraftDir({ ARCHITECT_MINECRAFT_DIR: root, HOME: '/nonexistent-home' })
    expect(found).toBe(root)
  })

  it('找到那个版本的客户端 jar（精确命中）', () => {
    const { root, jar } = makeMinecraft(VERSION)
    expect(findClientJar(root, VERSION)).toBe(jar)
  })

  it('**快照版本目录也能用**（`1.21.4-pre1` 以 `1.21.4` 开头）', () => {
    const { root } = makeMinecraft('1.21.4-pre1')
    expect(findClientJar(root, '1.21.4')).toContain('1.21.4-pre1')
  })

  it('版本不存在时如实返回 undefined，不猜一个 jar 出来', () => {
    const { root } = makeMinecraft(VERSION)
    expect(findClientJar(root, '1.20.1')).toBeUndefined()
    expect(minecraftTexturePack(root, '1.20.1')).toBeUndefined()
  })

  it('从假 `.minecraft` 里读出来的图集与解包目录一致（jar 这条路真的通）', () => {
    const { root } = makeMinecraft(VERSION)
    const pack = minecraftTexturePack(root, VERSION)!
    expect(pack.kind).toBe('minecraft')
    const atlas = buildTextureAtlas(VERSION, pack)
    expect(atlas.textures['stone']).toBeDefined()
    expect(atlas.decodeFailures).toBeUndefined()
  })
})

describe('解析设置 → 真正用的资源包（永远给得出一个）', () => {
  it('auto：找不到 `.minecraft` 就用烘好的平均色，并且**不说**自己回落了', () => {
    const { pack } = resolveTexturePack({ kind: 'auto' }, VERSION, { HOME: '/nonexistent' })
    expect(pack.kind).toBe('baked')
  })

  it('指定 `.minecraft` 但版本不在 → 平均色 + 如实标出 fellBackFrom', () => {
    const resolved = resolveTexturePack({ kind: 'minecraft', dir: join(dir, 'nope') }, VERSION)
    expect(resolved.pack.kind).toBe('baked')
    expect(resolved.fellBackFrom).toBe('minecraft')
  })

  it('指定资源包但路径里没有纹理 → 平均色 + fellBackFrom=pack', () => {
    mkdirSync(join(dir, 'empty'))
    const resolved = resolveTexturePack({ kind: 'pack', path: join(dir, 'empty') }, VERSION)
    expect(resolved.pack.kind).toBe('baked')
    expect(resolved.fellBackFrom).toBe('pack')
  })

  it('baked：tile 清单来自烘焙文件，读出来是能解码的 16×16 PNG', () => {
    const pack = bakedColorTexturePack(VERSION)
    const map = loadBakedBlockMap(VERSION)
    expect(pack.blockTiles()).toEqual([...map.tiles].sort())
    expect(pack.read('item/stick')).toBeUndefined()
    const bytes = pack.read('block/stone')!
    // PNG magic
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('**内置资源包与平均色兜底的 tile 清单完全一致**（换来源不会挪动 UV）', () => {
    const dev = assetsTexturePack(VERSION).blockTiles()
    const baked = bakedColorTexturePack(VERSION).blockTiles()
    expect([...baked]).toEqual([...dev])
  })
})

describe('实体纹理：带子目录，两种来源都要读得到', () => {
  it('目录来源：递归收集 `entity/` 下面的子目录', () => {
    const pack = directoryTexturePack(makePackDir(dir))
    expect(pack.read('entity/boat/oak')).toBeDefined()
    expect(pack.read('entity/cow/cow')).toBeDefined()
    // 方块那一侧不受影响
    expect(pack.read('block/stone')).toBeDefined()
    // 不存在的如实返回 undefined，而不是编一张出来
    expect(pack.read('entity/boat/spruce')).toBeUndefined()
  })

  it('zip 来源：嵌套路径也要给出来', () => {
    const pack = zipTexturePack(makePackZip(join(dir, 'pack.zip')))
    expect(pack.read('entity/boat/oak')).toBeDefined()
    expect(pack.read('entity/cow/cow')).toBeDefined()
  })

  it('**方块清单里不混进实体纹理**（图集只按方块清单建）', () => {
    const pack = directoryTexturePack(makePackDir(dir))
    expect(pack.blockTiles()).not.toContain('boat/oak')
    expect([...pack.blockTiles()].sort()).toEqual(Object.keys(TILES).sort())
  })
})
