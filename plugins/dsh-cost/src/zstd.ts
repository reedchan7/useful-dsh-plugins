/**
 * Concatenated-frame reading for the session store's zstd logs.
 *
 * The store appends one independently decodable, checksummed zstd frame per durable write, so a
 * live session's log is hundreds of frames long — the log this was fixed against held 1315 of them
 * in 1.2 MB. `zstdDecompressSync` decodes only the FIRST frame of such a buffer and silently drops
 * the rest, which made a whole session read as its single `session` header event: the day total
 * showed nothing at all while the open session's own figure looked right, because the open session
 * is folded from the live registry instead of the file.
 *
 * Frame boundaries are walked from the frame headers rather than located by searching for the magic
 * bytes: a compressed block may contain the magic as a literal, and a search that split there would
 * lose every event after it. A torn final frame — a write caught mid-append — ends the walk with
 * the frames before it kept, which is the same tolerance the line parser applies to a partial last
 * line.
 */

import { zstdDecompressSync } from 'node:zlib'

/** First four bytes of every zstd frame, little-endian. */
const ZSTD_MAGIC = 0xfd2fb528

/** Frames a scan will walk before it gives up on a malformed file. */
const MAX_FRAMES = 1_000_000

const BLOCK_HEADER_BYTES = 3
const BLOCK_TYPE_RAW = 0
const BLOCK_TYPE_RLE = 1
const BLOCK_TYPE_COMPRESSED = 2
const DICTIONARY_ID_BYTES = [0, 1, 2, 4] as const

/** Walk the structurally complete frames of one concatenated zstd buffer, in file order. */
export function zstdFrameRanges(buffer: Buffer): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = frameEnd(buffer, offset)
    if (end === null) break
    ranges.push({ start: offset, end })
    offset = end
  }
  return ranges
}

/** Find where one frame ends, or null when the bytes are torn or malformed. */
function frameEnd(buffer: Buffer, start: number): number | null {
  if (buffer.length - start < 4 + 1) return null
  if (buffer.readUInt32LE(start) !== ZSTD_MAGIC) return null
  const descriptor = buffer.readUInt8(start + 4)
  // Bits 3 and 4 are reserved and must be zero; a set bit means this is not a
  // frame header, so the file cannot be walked any further.
  if ((descriptor & 0x18) !== 0) return null
  const singleSegment = (descriptor & 0x20) !== 0
  const contentSizeBytes =
    descriptor >>> 6 === 0 ? (singleSegment ? 1 : 0) : 1 << (descriptor >>> 6)
  // Window descriptor (absent for a single-segment frame), dictionary id, and
  // the frame content size, whose width the descriptor's top two bits select.
  let offset = start + 5
  if (!singleSegment) offset += 1
  offset += DICTIONARY_ID_BYTES[descriptor & 0x03] ?? 0
  offset += contentSizeBytes

  while (offset + BLOCK_HEADER_BYTES <= buffer.length) {
    const header = buffer.readUIntLE(offset, BLOCK_HEADER_BYTES)
    offset += BLOCK_HEADER_BYTES
    const last = (header & 0x01) !== 0
    const type = (header >>> 1) & 0x03
    const size = header >>> 3
    if (type === BLOCK_TYPE_RAW || type === BLOCK_TYPE_COMPRESSED) offset += size
    else if (type === BLOCK_TYPE_RLE) offset += 1
    else return null
    if (offset > buffer.length) return null
    if (!last) continue
    // The content checksum, when the descriptor asks for one, closes the frame.
    if ((descriptor & 0x04) !== 0) offset += 4
    return offset > buffer.length ? null : offset
  }
  return null
}

/** Decompress a concatenated zstd stream, or null when no frame could be decoded. */
export function decompressFrames(raw: Buffer): string | null {
  const ranges = zstdFrameRanges(raw)
  if (ranges.length === 0) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      return null
    }
  }
  const parts: string[] = []
  for (const range of ranges.slice(0, MAX_FRAMES)) {
    try {
      parts.push(zstdDecompressSync(raw.subarray(range.start, range.end)).toString('utf8'))
    } catch {
      // A frame that will not decode after an earlier one succeeded ends the
      // walk: the frames already decoded are real events, and the rest of the
      // file is damaged or still being written.
      break
    }
  }
  return parts.length === 0 ? null : parts.join('')
}
