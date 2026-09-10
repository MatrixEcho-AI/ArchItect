import { unzlibSync } from 'fflate'

export interface RgbaImage {
  width: number
  height: number
  /** 长度 = width * height * 4，RGBA8。 */
  data: Uint8Array
}

export class PngError extends Error {
  override readonly name = 'PngError'
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 极简 PNG 解码器：只覆盖 Minecraft 资源包里的方块纹理。
 *
 * 支持位深 8（以及调色板/灰度的 1/2/4 位），色彩类型 0/2/3/4/6，非隔行。
 * 不校验 CRC（这些纹理来自本地资源包，不是不可信输入）——但要校验结构，
 * 坏数据必须报错而不是安静地渲染出花屏。
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new PngError('不是 PNG（签名不匹配）')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    )
    const dataStart = offset + 8
    if (dataStart + length + 4 > bytes.length) {
      throw new PngError(`PNG 块 ${type} 声明长度 ${length} 超出文件末尾`)
    }

    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      interlace = bytes[dataStart + 12]!
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataStart + length)
    } else if (type === 'tRNS') {
      transparency = bytes.subarray(dataStart, dataStart + length)
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }

  if (width === 0 || height === 0) throw new PngError('PNG 缺少有效的 IHDR')
  if (interlace !== 0) throw new PngError('不支持隔行 PNG')
  if (idat.length === 0) throw new PngError('PNG 没有任何 IDAT 数据')

  const merged = concat(idat)
  // PNG 的 IDAT 是 **zlib** 流（带 2 字节头与 Adler-32），不是裸 deflate
  const raw = unzlibSync(merged)

  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new PngError(`不支持的色彩类型 ${colorType}`)
  if (bitDepth !== 8 && !(bitDepth === 1 || bitDepth === 2 || bitDepth === 4) ) {
    throw new PngError(`不支持的位深 ${bitDepth}`)
  }

  const bitsPerPixel = channels * bitDepth
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8)
  const expected = (bytesPerRow + 1) * height
  if (raw.length < expected) {
    throw new PngError(`PNG 像素数据不足：有 ${raw.length} 字节，需要 ${expected}`)
  }

  const unfiltered = unfilter(raw, bytesPerRow, height, bytesPerPixel)
  const data = toRgba(unfiltered, width, height, bitDepth, colorType, channels, palette, transparency)

  return { width, height, data }
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function unfilter(
  raw: Uint8Array,
  bytesPerRow: number,
  height: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(bytesPerRow * height)
  let rawOffset = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset]!
    rawOffset++
    const rowStart = y * bytesPerRow
    const prevStart = rowStart - bytesPerRow
    for (let x = 0; x < bytesPerRow; x++) {
      const value = raw[rawOffset + x]!
      const a = x >= bpp ? out[rowStart + x - bpp]! : 0
      const b = y > 0 ? out[prevStart + x]! : 0
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp]! : 0
      let restored: number
      switch (filter) {
        case 0: restored = value; break
        case 1: restored = value + a; break
        case 2: restored = value + b; break
        case 3: restored = value + ((a + b) >> 1); break
        case 4: restored = value + paeth(a, b, c); break
        default: throw new PngError(`未知的行过滤器 ${filter}`)
      }
      out[rowStart + x] = restored & 0xff
    }
    rawOffset += bytesPerRow
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function toRgba(
  rows: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  channels: number,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
): Uint8Array {
  const out = new Uint8Array(width * height * 4)

  // 调色板要能在位深 1/2/4 下取到索引，统一走位读取
  if (colorType === 3) {
    if (palette === undefined) throw new PngError('调色板 PNG 缺少 PLTE 块')
    const bitsPerPixel = bitDepth
    const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8)
    const mask = (1 << bitDepth) - 1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitOffset = x * bitsPerPixel
        const byte = rows[y * bytesPerRow + (bitOffset >> 3)]!
        const shift = 8 - bitDepth - (bitOffset & 7)
        const index = (byte >> shift) & mask
        const o = (y * width + x) * 4
        out[o] = palette[index * 3] ?? 0
        out[o + 1] = palette[index * 3 + 1] ?? 0
        out[o + 2] = palette[index * 3 + 2] ?? 0
        out[o + 3] = transparency !== undefined && index < transparency.length ? transparency[index]! : 255
      }
    }
    return out
  }

  if (bitDepth !== 8) {
    // 灰度低位深（类型 0）
    const bytesPerRow = Math.ceil((width * bitDepth) / 8)
    const mask = (1 << bitDepth) - 1
    const scale = 255 / mask
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitOffset = x * bitDepth
        const byte = rows[y * bytesPerRow + (bitOffset >> 3)]!
        const shift = 8 - bitDepth - (bitOffset & 7)
        const g = Math.round(((byte >> shift) & mask) * scale)
        const o = (y * width + x) * 4
        out[o] = out[o + 1] = out[o + 2] = g
        out[o + 3] = 255
      }
    }
    return out
  }

  const stride = width * channels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * stride + x * channels
      const o = (y * width + x) * 4
      switch (colorType) {
        case 0:
          out[o] = out[o + 1] = out[o + 2] = rows[s]!
          out[o + 3] = 255
          break
        case 2:
          out[o] = rows[s]!
          out[o + 1] = rows[s + 1]!
          out[o + 2] = rows[s + 2]!
          out[o + 3] = 255
          break
        case 4:
          out[o] = out[o + 1] = out[o + 2] = rows[s]!
          out[o + 3] = rows[s + 1]!
          break
        case 6:
          out[o] = rows[s]!
          out[o + 1] = rows[s + 1]!
          out[o + 2] = rows[s + 2]!
          out[o + 3] = rows[s + 3]!
          break
        default:
          throw new PngError(`不支持的色彩类型 ${colorType}`)
      }
    }
  }
  return out
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 纯 JS base64 解码（不依赖 Buffer / atob，浏览器与 Node 都能跑）。 */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.ceil((clean.length * 3) / 4))
  let accumulator = 0
  let bits = 0
  let index = 0
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char)
    if (value < 0) continue
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (accumulator >> bits) & 0xff
      // 必须清掉已经取出的高位：JS 位运算是 32 位的，
      // 不清的话从第 5 个字符起就会溢出，解出来的字节全是错的。
      accumulator &= (1 << bits) - 1
    }
  }
  return out.subarray(0, index)
}

/** 解码 `data:image/png;base64,...`。 */
export function decodeDataUri(uri: string): RgbaImage {
  if (typeof uri !== 'string') {
    throw new PngError(`期望 data URI 字符串，收到 ${uri === null ? 'null' : typeof uri}`)
  }
  const comma = uri.indexOf(',')
  if (comma < 0 || !uri.startsWith('data:')) throw new PngError('不是合法的 data URI')
  return decodePng(decodeBase64(uri.slice(comma + 1)))
}

export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * 纹理的平均色。
 *
 * 全透明的像素被排除（Minecraft 纹理大量使用透明区域做镂空）；
 * 其余像素按 alpha 加权，避免半透明边缘把颜色拉黑。
 */
export function averageColor(image: RgbaImage): Rgb & { alpha: number } {
  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  let opaqueCount = 0
  const total = image.width * image.height
  for (let i = 0; i < total; i++) {
    const alpha = image.data[i * 4 + 3]!
    if (alpha === 0) continue
    const w = alpha / 255
    r += image.data[i * 4]! * w
    g += image.data[i * 4 + 1]! * w
    b += image.data[i * 4 + 2]! * w
    weight += w
    opaqueCount++
  }
  if (weight === 0) return { r: 0, g: 0, b: 0, alpha: 0 }
  return {
    r: Math.round(r / weight),
    g: Math.round(g / weight),
    b: Math.round(b / weight),
    alpha: Math.round((opaqueCount / total) * 255),
  }
}
