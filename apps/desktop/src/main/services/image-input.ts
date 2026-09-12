import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { t } from '@architect/i18n'

/**
 * **用户插图**这一步只做三件事：读文件、认格式、挡住过大的。
 *
 * 为什么不用扩展名判格式：扩展名是用户写的一个字，而 magic bytes 是文件本身。
 * 把 `.png` 改名的 `.jpg` 交给网关只会换回一个 400，而 400 看起来像"API 配错了"——
 * 那是把一次输入问题伪装成一次配置问题，最费时间的一类报错。
 *
 * 为什么在这里限尺寸：一张图会被 base64 之后塞进请求体，而 base64 会再胖 1/3。
 * 一张 20 MB 的照片够把一次请求推到网关的大小上限，回回来的还是一条难懂的错。
 * 在入口就挡住，并说清楚是哪一张、多大、上限多少。
 */

/** 单张图的上限。够放 4K 截图，又远在网关的体积限制之下。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 认得出来的图片格式。**只收这四种**——它们都是网关普遍接受的。 */
const SIGNATURES: ReadonlyArray<{ mimeType: string; magic: readonly number[] }> = [
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  // WebP 是 RIFF 容器：前 4 字节 "RIFF"、第 8..11 字节 "WEBP"
  { mimeType: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
]

/** 按**文件头**认格式；认不出来返回 `undefined`（调用方要如实报错，不能猜）。 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  for (const { mimeType, magic } of SIGNATURES) {
    if (bytes.length < magic.length) continue
    if (magic.every((byte, index) => bytes[index] === byte)) {
      if (mimeType === 'image/webp') {
        // RIFF 只是容器，还要看第 8..11 字节是不是 WEBP（也可能是 wav/avi）
        const tag = String.fromCharCode(...bytes.slice(8, 12))
        if (tag !== 'WEBP') continue
      }
      return mimeType
    }
  }
  return undefined
}

export interface PickedImage {
  /**
   * 给界面画缩略图用（`data:` URL）。
   *
   * 缩略图直接吃这个，而不是再开一条"按 id 取字节"的通道：这一张还没进过任何
   * 会话（用户可能选完又删掉），它此刻只存在于渲染进程的内存里，没有 id 可取。
   */
  dataUrl: string
  mimeType: string
  /** 原始文件名，只用于提示语里点名是哪一张。 */
  name: string
}

export interface PickResult {
  images: PickedImage[]
  /** 被拒的文件（读不了 / 不是图片 / 太大）。**如实回给界面**，不静默丢。 */
  rejected: Array<{ name: string; reason: string }>
}

/**
 * 把一批文件路径读成可用作插图的数据。
 *
 * 逐张独立处理：一张坏了不该把用户一次选的另外五张一起丢掉。
 */
export async function readPickedImages(paths: readonly string[]): Promise<PickResult> {
  const images: PickedImage[] = []
  const rejected: Array<{ name: string; reason: string }> = []

  for (const path of paths) {
    const name = path.split('/').pop() ?? path
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (error) {
      rejected.push({ name, reason: t('image.unreadable', { error: error instanceof Error ? error.message : String(error) }) })
      continue
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      rejected.push({
        name,
        reason: t('image.tooLarge', { mb: (bytes.byteLength / 1024 / 1024).toFixed(1), max: MAX_IMAGE_BYTES / 1024 / 1024 }),
      })
      continue
    }
    const mimeType = sniffImageMime(bytes)
    if (mimeType === undefined) {
      rejected.push({ name, reason: t('image.notAnImage', { ext: extname(path) || '—' }) })
      continue
    }
    images.push({
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      name,
    })
  }
  return { images, rejected }
}

/** 文件选择框的过滤器：只列图片，省得用户在一堆文件里翻。 */
export const IMAGE_FILE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
]
