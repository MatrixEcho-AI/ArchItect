import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initI18n } from '@architect/i18n'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MAX_IMAGE_BYTES, readPickedImages, sniffImageMime } from '../src/main/services/image-input.js'

initI18n({ locale: 'zh-CN' })

/** 各格式的最小文件头。**只要文件头**——sniff 就该只看文件头。 */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]
const WAV = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]

let workspace: string
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'architect-image-'))
})
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const write = async (name: string, bytes: readonly number[]): Promise<string> => {
  const path = join(workspace, name)
  await writeFile(path, Buffer.from(bytes))
  return path
}

describe('插图：认格式只看文件头', () => {
  it('四种格式都认得出来', () => {
    expect(sniffImageMime(Uint8Array.from(PNG))).toBe('image/png')
    expect(sniffImageMime(Uint8Array.from(JPEG))).toBe('image/jpeg')
    expect(sniffImageMime(Uint8Array.from(GIF))).toBe('image/gif')
    expect(sniffImageMime(Uint8Array.from(WEBP))).toBe('image/webp')
  })

  it('**RIFF 不一定就是 WebP**：wav 用同一层容器，不能被当成图片', () => {
    expect(sniffImageMime(Uint8Array.from(WAV))).toBeUndefined()
  })

  it('不是图片就返回 undefined（调用方必须如实报错，不能猜）', () => {
    expect(sniffImageMime(Uint8Array.from(Buffer.from('hello world')))).toBeUndefined()
    expect(sniffImageMime(new Uint8Array(0))).toBeUndefined()
  })
})

describe('插图：读文件', () => {
  it('读出 data URL 与 mime，名字保留', async () => {
    const path = await write('ok.png', [...PNG, 1, 2, 3])
    const result = await readPickedImages([path])
    expect(result.rejected).toEqual([])
    expect(result.images).toHaveLength(1)
    expect(result.images[0]!.name).toBe('ok.png')
    expect(result.images[0]!.mimeType).toBe('image/png')
    expect(result.images[0]!.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    // 解回来必须是原字节——base64 那一步错了整张图就是花的
    const base64 = result.images[0]!.dataUrl.slice(result.images[0]!.dataUrl.indexOf(',') + 1)
    expect([...Buffer.from(base64, 'base64')].slice(0, PNG.length)).toEqual(PNG)
  })

  it('**扩展名撒谎时以文件头为准**：把 jpg 改名成 .png 仍然按 jpeg 送出去', async () => {
    const path = await write('liar.png', JPEG)
    const result = await readPickedImages([path])
    expect(result.images[0]!.mimeType).toBe('image/jpeg')
  })

  it('不是图片 → 进 rejected，并带上扩展名', async () => {
    const path = await write('notes.txt', [...Buffer.from('just text')])
    const result = await readPickedImages([path])
    expect(result.images).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.name).toBe('notes.txt')
    expect(result.rejected[0]!.reason).toContain('.txt')
  })

  it('**超过上限的一张要挡住并说清多大、上限多少**（否则会伪装成网关 400）', async () => {
    const path = join(workspace, 'huge.png')
    await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89))
    const result = await readPickedImages([path])
    expect(result.images).toEqual([])
    expect(result.rejected[0]!.reason).toContain('上限')
  })

  it('读不了的文件（路径不存在）也只进 rejected，不抛', async () => {
    const result = await readPickedImages([join(workspace, 'nope.png')])
    expect(result.images).toEqual([])
    expect(result.rejected).toHaveLength(1)
  })

  it('**一张坏了不连累其它张**：用户一次选六张，坏的那张只影响它自己', async () => {
    const good = await write('good.png', [...PNG, 9])
    const bad = await write('bad.txt', [...Buffer.from('nope')])
    const also = await write('also.gif', GIF)
    const result = await readPickedImages([good, bad, also])
    expect(result.images.map((image) => image.name).sort()).toEqual(['also.gif', 'good.png'])
    expect(result.rejected.map((item) => item.name)).toEqual(['bad.txt'])
  })
})
