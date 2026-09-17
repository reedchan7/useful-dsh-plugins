/**
 * Reading the session store's concatenated zstd logs.
 *
 * The store appends one frame per durable write, so a log holds hundreds of them and a decoder that
 * only reads the first frame sees nothing but the session header. The cases here pin both halves of
 * that: every frame is decoded, and a torn final frame — a write caught mid-append — keeps the
 * frames before it instead of discarding the whole session.
 */

import { describe, expect, test } from 'bun:test'
import { zstdCompressSync } from 'node:zlib'

import { decompressFrames, zstdFrameRanges } from '../src/zstd.ts'

/** One frame as the store writes it: independently decodable, checksummed. */
function frame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text), { params: {} })
}

describe('concatenated frame reading', () => {
  test('every frame of a concatenated stream is decoded, in order', () => {
    // The failure this guards: `zstdDecompressSync` over the whole buffer returns
    // the first frame alone, so a 1315-frame log read as one header event and the
    // day total came back empty while the session's own figure looked right.
    const frames = ['{"seq":0}\n', '{"seq":1}\n', '{"seq":2}\n'].map(frame)
    const joined = Buffer.concat(frames)
    expect(decompressFrames(joined)).toBe('{"seq":0}\n{"seq":1}\n{"seq":2}\n')
    expect(zstdFrameRanges(joined)).toEqual([
      { start: 0, end: frames[0]?.length ?? 0 },
      { start: frames[0]?.length ?? 0, end: (frames[0]?.length ?? 0) + (frames[1]?.length ?? 0) },
      {
        start: (frames[0]?.length ?? 0) + (frames[1]?.length ?? 0),
        end: (frames[0]?.length ?? 0) + (frames[1]?.length ?? 0) + (frames[2]?.length ?? 0),
      },
    ])
  })

  test('many small frames decode without losing one', () => {
    const lines = Array.from({ length: 512 }, (_, index) => `{"seq":${index}}\n`)
    expect(decompressFrames(Buffer.concat(lines.map(frame)))).toBe(lines.join(''))
  })

  test('a torn final frame keeps the frames written before it', () => {
    // The last frame of a live session is mid-append, exactly as a partial last
    // line is: the frames already written are real events and must survive.
    const complete = Buffer.concat(['{"seq":0}\n', '{"seq":1}\n'].map(frame))
    const torn = frame('{"seq":2}\n').subarray(0, 6)
    const text = decompressFrames(Buffer.concat([complete, torn]))
    expect(text).toBe('{"seq":0}\n{"seq":1}\n')
  })

  test('a single-frame buffer still decodes', () => {
    expect(decompressFrames(frame('{"seq":0}\n'))).toBe('{"seq":0}\n')
  })

  test('bytes that hold no frame at all are reported, not guessed', () => {
    expect(decompressFrames(Buffer.from('not zstd at all'))).toBeNull()
  })
})
