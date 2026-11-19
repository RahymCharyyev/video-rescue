// Minimal ISO-BMFF / QuickTime reader: just enough to walk top-level atoms,
// read a moov, summarise its tracks and find its chunk-offset tables.
import { promises as fsp } from 'fs';
import type { AtomInfo, MovieSummary, TrackSummary } from '../shared/types';

/** Top-level atom types we accept as "real structure". */
export const TOP_LEVEL_TYPES = new Set([
  'ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'meta', 'pnot', 'pdin',
  'moof', 'mfra', 'sidx', 'styp', 'udta', 'junk', 'prfl', 'PICT', 'emsg', 'prft',
]);

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex']);

export function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64BE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('64-bit value too large');
  return Number(v);
}

export function fourcc(buf: Buffer, off: number): string {
  return buf.toString('latin1', off, off + 4);
}

export function isPrintableFourcc(s: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(s);
}

export async function readAt(fh: fsp.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let done = 0;
  while (done < len) {
    const { bytesRead } = await fh.read(buf, done, len - done, pos + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === len ? buf : buf.subarray(0, done);
}

/**
 * Walk top-level atoms from offset 0. Stops at the first thing that doesn't
 * look like a valid atom. Returns what was parsed.
 */
export async function readTopAtoms(fh: fsp.FileHandle, fileSize: number, maxAtoms = 256): Promise<AtomInfo[]> {
  const atoms: AtomInfo[] = [];
  let off = 0;
  while (off + 8 <= fileSize && atoms.length < maxAtoms) {
    const h = await readAt(fh, off, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = fourcc(h, 4);
    if (!TOP_LEVEL_TYPES.has(type)) break;
    let headerSize = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = u64(h, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - off; // extends to EOF
    }
    if (size < headerSize) break;
    const truncated = off + size > fileSize;
    atoms.push({ type, start: off, size, headerSize, truncated: truncated || undefined });
    if (truncated) break;
    off += size;
  }
  return atoms;
}

interface ChildAtom { type: string; start: number; size: number; headerSize: number }

/** Iterate child atoms inside buf[start, end). */
export function* children(buf: Buffer, start: number, end: number): Generator<ChildAtom> {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = fourcc(buf, off + 4);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = u64(buf, off + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) return;
    yield { type, start: off, size, headerSize };
    off += size;
  }
}

function findChild(buf: Buffer, start: number, end: number, type: string): ChildAtom | undefined {
  for (const c of children(buf, start, end)) if (c.type === type) return c;
  return undefined;
}

function findPath(buf: Buffer, start: number, end: number, path: string[]): ChildAtom | undefined {
  let s = start;
  let e = end;
  let found: ChildAtom | undefined;
  for (const p of path) {
    found = findChild(buf, s, e, p);
    if (!found) return undefined;
    s = found.start + found.headerSize;
    e = found.start + found.size;
  }
  return found;
}

export interface ChunkTable {
  kind: 'stco' | 'co64';
  /** Byte offset (inside the moov buffer) of the first entry */
  entriesAt: number;
  count: number;
}

/** All stco/co64 tables inside a moov buffer (buffer starts at the moov header). */
export function chunkTables(moov: Buffer): ChunkTable[] {
  const out: ChunkTable[] = [];
  const walk = (s: number, e: number) => {
    for (const c of children(moov, s, e)) {
      if (CONTAINERS.has(c.type)) walk(c.start + c.headerSize, c.start + c.size);
      else if (c.type === 'stco' || c.type === 'co64') {
        const body = c.start + c.headerSize;
        out.push({ kind: c.type, entriesAt: body + 8, count: moov.readUInt32BE(body + 4) });
      }
    }
  };
  const hs = moov.readUInt32BE(0) === 1 ? 16 : 8;
  walk(hs, moov.length);
  return out;
}

export function readChunkOffset(moov: Buffer, t: ChunkTable, i: number): number {
  return t.kind === 'co64' ? u64(moov, t.entriesAt + i * 8) : moov.readUInt32BE(t.entriesAt + i * 4);
}

export function writeChunkOffset(moov: Buffer, t: ChunkTable, i: number, v: number): void {
  if (t.kind === 'co64') moov.writeBigUInt64BE(BigInt(v), t.entriesAt + i * 8);
  else {
    if (v < 0 || v > 0xffffffff) throw new Error('chunk offset does not fit into stco');
    moov.writeUInt32BE(v, t.entriesAt + i * 4);
  }
}

const CODEC_NAMES: Record<string, string> = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', mp4v: 'MPEG-4', ap4h: 'ProRes 4444',
  apch: 'ProRes HQ', apcn: 'ProRes', apcs: 'ProRes LT', apco: 'ProRes Proxy', mjpa: 'MJPEG',
  jpeg: 'JPEG', mp4a: 'AAC', twos: 'PCM', sowt: 'PCM', lpcm: 'PCM', ipcm: 'PCM', in24: 'PCM 24',
  in32: 'PCM 32', fl32: 'PCM float', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', rtmd: 'Sony rtmd',
  gpmd: 'GoPro meta', tmcd: 'Timecode', mebx: 'Metadata', alac: 'ALAC',
};

export function codecName(fcc: string): string {
  return CODEC_NAMES[fcc] ?? fcc;
}

/** Summarise a moov buffer (buffer starts at the moov atom header). */
export function summarizeMoov(moov: Buffer): MovieSummary {
  const hs = moov.readUInt32BE(0) === 1 ? 16 : 8;
  let movieDuration = 0;
  const mvhd = findChild(moov, hs, moov.length, 'mvhd');
  if (mvhd) {
    const b = mvhd.start + mvhd.headerSize;
    const ver = moov[b];
    const ts = ver === 1 ? moov.readUInt32BE(b + 20) : moov.readUInt32BE(b + 12);
    const dur = ver === 1 ? u64(moov, b + 24) : moov.readUInt32BE(b + 16);
    if (ts > 0) movieDuration = dur / ts;
  }

  const tracks: TrackSummary[] = [];
  for (const trak of children(moov, hs, moov.length)) {
    if (trak.type !== 'trak') continue;
    const ts0 = trak.start + trak.headerSize;
    const te = trak.start + trak.size;
    const mdhd = findPath(moov, ts0, te, ['mdia', 'mdhd']);
    const hdlr = findPath(moov, ts0, te, ['mdia', 'hdlr']);
    const stbl = findPath(moov, ts0, te, ['mdia', 'minf', 'stbl']);
    let timescale = 0;
    let dur = 0;
    if (mdhd) {
      const b = mdhd.start + mdhd.headerSize;
      const ver = moov[b];
      timescale = ver === 1 ? moov.readUInt32BE(b + 20) : moov.readUInt32BE(b + 12);
      dur = ver === 1 ? u64(moov, b + 24) : moov.readUInt32BE(b + 16);
    }
    const handler = hdlr ? fourcc(moov, hdlr.start + hdlr.headerSize + 8) : '????';
    let codec = '????';
    let width: number | undefined;
    let height: number | undefined;
    let audioChannels: number | undefined;
    let audioSampleRate: number | undefined;
    let sampleCount = 0;
    if (stbl) {
      const sb = stbl.start + stbl.headerSize;
      const se = stbl.start + stbl.size;
      const stsd = findChild(moov, sb, se, 'stsd');
      if (stsd) {
        const entry = stsd.start + stsd.headerSize + 8;
        if (entry + 8 <= stsd.start + stsd.size) {
          codec = fourcc(moov, entry + 4);
          if (handler === 'vide' && entry + 36 <= moov.length) {
            width = moov.readUInt16BE(entry + 32);
            height = moov.readUInt16BE(entry + 34);
          }
          if (handler === 'soun' && entry + 36 <= moov.length) {
            audioChannels = moov.readUInt16BE(entry + 24);
            audioSampleRate = moov.readUInt32BE(entry + 32) / 65536;
          }
        }
      }
      const stsz = findChild(moov, sb, se, 'stsz');
      if (stsz) sampleCount = moov.readUInt32BE(stsz.start + stsz.headerSize + 8);
      else {
        const stz2 = findChild(moov, sb, se, 'stz2');
        if (stz2) sampleCount = moov.readUInt32BE(stz2.start + stz2.headerSize + 8);
      }
    }
    const durationSec = timescale ? dur / timescale : 0;
    const t: TrackSummary = { handler, codec, timescale, durationSec, sampleCount };
    if (width) t.width = width;
    if (height) t.height = height;
    if (audioChannels) t.audioChannels = audioChannels;
    if (audioSampleRate) t.audioSampleRate = audioSampleRate;
    if (handler === 'vide' && durationSec > 0 && sampleCount > 0) t.fps = Math.round((sampleCount / durationSec) * 100) / 100;
    tracks.push(t);
  }

  let maxChunkOffset = 0;
  for (const t of chunkTables(moov)) {
    for (let i = 0; i < t.count; i++) maxChunkOffset = Math.max(maxChunkOffset, readChunkOffset(moov, t, i));
  }
  if (!movieDuration) movieDuration = Math.max(0, ...tracks.map((t) => t.durationSec));
  return { durationSec: movieDuration, tracks, maxChunkOffset };
}

export function describeMovie(m: MovieSummary): string {
  const parts: string[] = [];
  for (const t of m.tracks) {
    if (t.handler === 'vide') {
      let s = codecName(t.codec);
      if (t.width && t.height) s += ` ${t.width}×${t.height}`;
      if (t.fps) s += ` ${Number.isInteger(t.fps) ? t.fps : t.fps.toFixed(2)} fps`;
      parts.push(s);
    } else if (t.handler === 'soun') {
      let s = codecName(t.codec);
      if (t.audioChannels) s += ` ${t.audioChannels} кан.`;
      if (t.audioSampleRate) s += ` ${Math.round(t.audioSampleRate / 100) / 10} кГц`;
      parts.push(s);
    }
  }
  return parts.join(' · ') || 'неизвестный формат';
}

export interface LoadedMovie {
  atoms: AtomInfo[];
  moov: Buffer;
  moovAtom: AtomInfo;
  summary: MovieSummary;
  ftypBrand?: string;
}

const MAX_MOOV = 512 * 1024 * 1024;

/** Open a (healthy) MP4/MOV and read its moov. Returns null if there is none. */
export async function loadMovie(path: string): Promise<LoadedMovie | null> {
  const fh = await fsp.open(path, 'r');
  try {
    const { size } = await fh.stat();
    const atoms = await readTopAtoms(fh, size);
    const moovAtom = atoms.find((a) => a.type === 'moov' && !a.truncated);
    if (!moovAtom || moovAtom.size > MAX_MOOV) return null;
    const moov = await readAt(fh, moovAtom.start, moovAtom.size);
    if (moov.length !== moovAtom.size) return null;
    let ftypBrand: string | undefined;
    const ftyp = atoms.find((a) => a.type === 'ftyp');
    if (ftyp) ftypBrand = fourcc(await readAt(fh, ftyp.start + 8, 4), 0);
    return { atoms, moov, moovAtom, summary: summarizeMoov(moov), ftypBrand };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
