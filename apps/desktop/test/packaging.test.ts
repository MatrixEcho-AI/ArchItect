import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * **装出来的 app 里，运行时真要读的那些纹理必须在包里。**
 *
 * 这条测试的来源是一次真实的缺口（plan §18.7）：实体那一期把
 * `data/1.21.4/entity` 加进了资源来源，但 `build.files` 里那句通配的总排除
 * （"资源包 data 下所有版本的每个子目录都排掉"）后面只把 `data/1.21.4/blocks`
 * 放了回来。于是开发机上一切正常（`node_modules` 就在旁边），
 * **打包之后放一条船读不到贴图**。
 *
 * 两件事让它不是一条同义反复的断言：
 *
 * 1. 断言的判据不是"package.json 里有没有那一行"，而是**运行时代码能请求到哪些
 *    纹理根**（`assetsTexturePack` 的 `read()` 认哪几个前缀）。将来加第四个前缀
 *    而忘了放回，这里会红。
 * 2. 顺带验证那些目录**真的存在**——一条写错路径的 include 不会报错，
 *    只会安静地什么都不匹配。
 *
 * "被引用的那张贴图到底存不存在"是另一条不变式（它属于渲染数据，不属于打包），
 * 放在 `packages/render/test/entity-textures.test.ts`。
 */

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')

/**
 * 运行时代码会从资源包里读的那些**前缀 → 目录**。
 *
 * 与 `packages/render/src/assets.ts` 的 `read()` 一一对应。注意前缀与目录名
 * **不总是同名**（`block/` 落在 `blocks/`），所以这里写的是两列而不是一列。
 * 手工维护是刻意的：它是一条**契约**，不是从实现里反射出来的东西；
 * 改了那边就必须来改这里，而那正是我们想要的提醒。
 */
const TEXTURE_ROOTS: ReadonlyArray<{ prefix: string; dir: string }> = [
  { prefix: 'block', dir: 'blocks' },
  { prefix: 'entity', dir: 'entity' },
  { prefix: 'item', dir: 'items' },
]

interface DesktopPackage {
  build: { files: string[] }
}

function buildFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as DesktopPackage
  return pkg.build.files
}

/** `data/1.21.4/<dir>/**` 那条"放回来"的 include（相对包内的 node_modules 路径）。 */
function includeFor(dir: string, version: string): string {
  return `node_modules/minecraft-assets/minecraft-assets/data/${version}/${dir}/**`
}

const VERSION = '1.21.4'

describe('打包：运行时读得到的纹理根都要放回安装包', () => {
  const files = buildFiles()

  it('总排除那一句还在（否则下面几条 include 就没有意义了）', () => {
    // 没有这句总排除的话，整份 `data/*/*/**` 都会被打进去，后面几条 include
    // 变成纯装饰——而"包体积靠这几条精确控制"这个前提就悄悄没了。
    expect(
      files,
      '找不到 data/*/*/** 的总排除；包体积的控制逻辑变了，请重新审视这几条 include',
    ).toContain('!node_modules/minecraft-assets/minecraft-assets/data/*/*/**')
  })

  it.each(TEXTURE_ROOTS)('`$prefix/` 下的纹理被放回了包', ({ prefix, dir }) => {
    const wanted = includeFor(dir, VERSION)
    expect(
      files,
      `build.files 里没有 "${wanted}"，所以 \`${prefix}/\` 这个命名空间的纹理读不到。` +
        `缺了它，开发机上正常，装出来的 app 里这部分纹理读不到，` +
        `表现是模型画成兜底灰盒（见 plan §18.7）。`,
    ).toContain(wanted)
    expect(
      existsSync(join(desktopRoot, wanted.replace(/\/\*\*$/, ''))),
      `"${wanted}" 指向的目录在磁盘上不存在——一条写错路径的 include 不会报错，只会安静地什么都不匹配`,
    ).toBe(true)
  })
})
