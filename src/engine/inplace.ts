// In-place repair: instead of copying gigabytes, write a valid header into the
// broken file and append the moov that untrunc rebuilt. Needs only a few MB of
// free space. Everything we overwrite is saved to a small backup file so the
// operation can be undone exactly.
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { AtomInfo } from '../shared/types';
import { chunkTables, readAt, readChunkOffset, readTopAtoms, writeChunkOffset } from './mp4';

export interface BackupFile {
  tool: 'video-rescue';
  version: 1;
  createdAt: string;
  originalPath: string;
  patchedPath: string;
  origSize: number;
  appendedBytes: number;
  regionStart: number;
  regionBase64: string;
}

export interface InPlaceInput {
  broken: string;
  /** untrunc output written with UNTRUNC_MOOV_ONLY=1 (ftyp + moov, no mdat) */
  moovOnlyFile: string;
  /** healthy reference: its pre-mdat atoms are reused when the header is garbage */
  reference: string;
  /** offset in the broken file where sample data starts (untrunc -range start) */
  dataOffset: number;
  /** existing mdat atom in the broken file (no-moov case); undefined => garbage header */
  mdat?: AtomInfo;
  /** all valid top-level atoms of the broken file */
  atoms: AtomInfo[];
  renameToMp4?: boolean;
}

export interface InPlaceOutput {
  path: string;
  backupPath: string;
  moovBytes: number;
}

const PAD_TYPES = new Set(['free', 'skip', 'wide']);

function mdatHeader(size: number, hdr: 8 | 16): Buffer {
  const b = Buffer.alloc(hdr);
  if (hdr === 16) {
    b.writeUInt32BE(1, 0);
    b.write('mdat', 4, 'latin1');
    b.writeBigUInt64BE(BigInt(size), 8);
  } else {
    if (size > 0xffffffff) throw new Error('mdat too large for 32-bit header');
    b.writeUInt32BE(size, 0);
    b.write('mdat', 4, 'latin1');
  }
  return b;
}

function freeAtom(len: number): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32BE(len, 0);
  b.write('free', 4, 'latin1');
  return b;
}

function minimalFtyp(): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  b.writeUInt32BE(0x200, 12);
  b.write('isommp41', 16, 'latin1');
  return b;
}

/** Bytes for [0, dataOffset) when the original header is garbage. */
export function buildHeaderFromReference(refPre: Buffer[], dataOffset: number, origSize: number): Buffer {
  const hasFtyp = refPre.length > 0 && refPre[0].toString('latin1', 4, 8) === 'ftyp';
  const pre = hasFtyp ? refPre : [minimalFtyp(), ...refPre];
  for (const hdr of [16, 8] as const) {
    const mdatStart = dataOffset - hdr;
    const mdatSize = origSize - mdatStart;
    if (hdr === 8 && mdatSize > 0xffffffff) continue;
    const avail = mdatStart;
    for (let k = pre.length; k >= 1; k--) {
      const keep = pre.slice(0, k);
      const len = keep.reduce((s, b) => s + b.length, 0);
      const gap = avail - len;
      if (gap === 0 || gap >= 8) {
        const parts = [...keep];
        if (gap) parts.push(freeAtom(gap));
        parts.push(mdatHeader(mdatSize, hdr));
        return Buffer.concat(parts);
      }
    }
  }
  throw new Error(
    `Перед данными всего ${dataOffset} байт — заголовок туда не помещается. Используйте режим «Копия».`,
  );
}

/** Region to rewrite when the file already has ftyp…mdat but no moov. */
export function buildMdatFix(atoms: AtomInfo[], mdat: AtomInfo, origSize: number, existing: Buffer, existingStart: number): { start: number; bytes: Buffer } {
  const sizeFrom = (start: number) => origSize - start;
  if (mdat.headerSize === 16) return { start: mdat.start, bytes: mdatHeader(sizeFrom(mdat.start), 16) };
  if (sizeFrom(mdat.start) <= 0xffffffff) return { start: mdat.start, bytes: mdatHeader(sizeFrom(mdat.start), 8) };
  // 8-byte header but > 4 GB: borrow 8 bytes from a preceding free/wide atom
  const prev = atoms.find((a) => a.start + a.size === mdat.start);
  if (prev && PAD_TYPES.has(prev.type) && prev.headerSize === 8) {
    const newStart = mdat.start - 8;
    const hdr = mdatHeader(sizeFrom(newStart), 16);
    if (prev.size === 8) return { start: newStart, bytes: hdr };
    if (prev.size >= 16) {
      const region = Buffer.from(existing.subarray(prev.start - existingStart, mdat.start + 8 - existingStart));
      region.writeUInt32BE(prev.size - 8, 0);
      hdr.copy(region, newStart - prev.start);
      return { start: prev.start, bytes: region };
    }
  }
  throw new Error('Заголовок mdat нельзя расширить на месте (файл больше 4 ГБ). Используйте режим «Копия».');
}

/** Load the moov from the moov-only file and shift its chunk offsets to point into the broken file. */
export async function relocatedMoov(moovOnlyFile: string, dataOffset: number, origSize: number): Promise<Buffer> {
  const fh = await fsp.open(moovOnlyFile, 'r');
  let moov: Buffer;
  let end = 0;
  try {
    const { size } = await fh.stat();
    const atoms = await readTopAtoms(fh, size);
    const m = atoms.find((a) => a.type === 'moov');
    if (!m) throw new Error('untrunc не записал moov');
    end = Math.max(...atoms.map((a) => a.start + a.size));
    moov = await readAt(fh, m.start, m.size);
  } finally {
    await fh.close();
  }
  const tables = chunkTables(moov);
  if (!tables.length) throw new Error('В восстановленном moov нет таблиц смещений');
  let min = Infinity;
  for (const t of tables) for (let i = 0; i < t.count; i++) min = Math.min(min, readChunkOffset(moov, t, i));
  if (!Number.isFinite(min)) throw new Error('Восстановленный moov пустой — кадры не найдены');

  // In untrunc's output the mdat content starts right after ftyp+moov+mdat header.
  let contentStart: number;
  if (min - end === 8 || min - end === 16) contentStart = min;
  else contentStart = end + (origSize - dataOffset + 8 > 0xffffffff ? 16 : 8);
  if (min < contentStart) throw new Error('Неожиданная раскладка вывода untrunc');
  const delta = dataOffset - contentStart;

  for (const t of tables) {
    for (let i = 0; i < t.count; i++) {
      const v = readChunkOffset(moov, t, i) + delta;
      if (v < dataOffset || v >= origSize) throw new Error(`Смещение ${v} вне данных файла — раскладка не совпала`);
      writeChunkOffset(moov, t, i, v); // throws if stco overflows
    }
  }
  return moov;
}

function backupPathFor(p: string): string {
  return `${p}.videorescue-backup.json`;
}

async function fsyncFile(fh: fsp.FileHandle) {
  try {
    await fh.sync();
  } catch {
    /* some network filesystems don't support fsync */
  }
}

export async function repairInPlace(i: InPlaceInput): Promise<InPlaceOutput> {
  const st = await fsp.stat(i.broken);
  const origSize = st.size;
  const moov = await relocatedMoov(i.moovOnlyFile, i.dataOffset, origSize);

  // Header region
  let region: { start: number; bytes: Buffer };
  const fh = await fsp.open(i.broken, 'r+');
  try {
    if (i.mdat) {
      if (i.mdat.start + i.mdat.headerSize !== i.dataOffset) throw new Error('dataOffset не совпадает с mdat');
      const from = Math.max(0, i.mdat.start - 4096);
      const existing = await readAt(fh, from, i.mdat.start + 16 - from);
      region = buildMdatFix(i.atoms, i.mdat, origSize, existing, from);
    } else {
      const rfh = await fsp.open(i.reference, 'r');
      const refPre: Buffer[] = [];
      try {
        const { size } = await rfh.stat();
        const ratoms = await readTopAtoms(rfh, size);
        const rmdat = ratoms.find((a) => a.type === 'mdat');
        for (const a of ratoms) {
          if (!rmdat || a.start >= rmdat.start || a.type === 'moov') break;
          if (a.size > 64 * 1024) break; // don't copy huge atoms into the header
          refPre.push(await readAt(rfh, a.start, a.size));
        }
      } finally {
        await rfh.close();
      }
      region = { start: 0, bytes: buildHeaderFromReference(refPre, i.dataOffset, origSize) };
    }
    if (region.start + region.bytes.length !== i.dataOffset && !i.mdat) throw new Error('internal: header size');

    // 1) backup what we are about to overwrite
    const old = await readAt(fh, region.start, region.bytes.length);
    const backup: BackupFile = {
      tool: 'video-rescue',
      version: 1,
      createdAt: new Date().toISOString(),
      originalPath: i.broken,
      patchedPath: i.broken,
      origSize,
      appendedBytes: moov.length,
      regionStart: region.start,
      regionBase64: old.toString('base64'),
    };
    const backupPath = backupPathFor(i.broken);
    await fsp.writeFile(backupPath, JSON.stringify(backup, null, 2));

    // 2) append moov, 3) write header
    await fh.write(moov, 0, moov.length, origSize);
    await fsyncFile(fh);
    await fh.write(region.bytes, 0, region.bytes.length, region.start);
    await fsyncFile(fh);
    await fh.close();

    let finalPath = i.broken;
    let finalBackup = backupPath;
    if (i.renameToMp4) {
      const ext = path.extname(i.broken);
      if (!/^\.(mp4|mov|m4v)$/i.test(ext)) {
        const newExt = ext === ext.toUpperCase() ? '.MP4' : '.mp4';
        let target = i.broken.slice(0, i.broken.length - ext.length) + newExt;
        try {
          await fsp.access(target);
          target = i.broken.slice(0, i.broken.length - ext.length) + '_fixed' + newExt;
        } catch {
          /* free */
        }
        await fsp.rename(i.broken, target);
        finalPath = target;
        backup.patchedPath = target;
        finalBackup = backupPathFor(target);
        await fsp.writeFile(finalBackup, JSON.stringify(backup, null, 2));
        if (finalBackup !== backupPath) await fsp.unlink(backupPath).catch(() => undefined);
      }
    }
    return { path: finalPath, backupPath: finalBackup, moovBytes: moov.length };
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
}

/** Undo an in-place repair using its backup file. */
export async function undoInPlace(backupPath: string): Promise<string> {
  const b = JSON.parse(await fsp.readFile(backupPath, 'utf8')) as BackupFile;
  if (b.tool !== 'video-rescue' || b.version !== 1) throw new Error('Это не файл отката Video Rescue');
  const st = await fsp.stat(b.patchedPath);
  if (st.size !== b.origSize + b.appendedBytes && st.size !== b.origSize) {
    throw new Error('Размер файла изменился после починки — откат небезопасен');
  }
  const region = Buffer.from(b.regionBase64, 'base64');
  const fh = await fsp.open(b.patchedPath, 'r+');
  try {
    await fh.write(region, 0, region.length, b.regionStart);
    await fh.truncate(b.origSize);
    await fsyncFile(fh);
  } finally {
    await fh.close();
  }
  if (b.patchedPath !== b.originalPath) await fsp.rename(b.patchedPath, b.originalPath);
  await fsp.unlink(backupPath).catch(() => undefined);
  return b.originalPath;
}

