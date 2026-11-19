// Look at a broken file and figure out what kind of damage it has and where
// its sample data probably starts.
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { Analysis, OffsetCandidate } from '../shared/types';
import { fourcc, readAt, readTopAtoms } from './mp4';

const HEAD_SCAN = 4 * 1024 * 1024;

/** Sony real-time metadata packet: 00 1c 01 00 .... f0 01 00 10 (same test untrunc uses). */
export function isSonyRtmd(buf: Buffer, i: number): boolean {
  return (
    i + 12 <= buf.length &&
    buf[i] === 0x00 && buf[i + 1] === 0x1c && buf[i + 2] === 0x01 && buf[i + 3] === 0x00 &&
    buf[i + 8] === 0xf0 && buf[i + 9] === 0x01 && buf[i + 10] === 0x00 && buf[i + 11] === 0x10
  );
}

export function findSonyRtmd(buf: Buffer, from = 0): number {
  for (let i = from; i + 12 <= buf.length; i++) {
    i = buf.indexOf(0x1c, i + 1) - 1;
    if (i < 0) return -1;
    if (isSonyRtmd(buf, i)) return i;
  }
  return -1;
}

/** How many bytes at the end of the file are zero (camera preallocated, never written). */
async function zeroTail(fh: fsp.FileHandle, size: number): Promise<number> {
  const step = 1024 * 1024;
  let zeros = 0;
  let pos = size;
  // check at most 2 GB backwards in 1 MB blocks, stop at the first non-zero block
  for (let n = 0; n < 2048 && pos > 0; n++) {
    const start = Math.max(0, pos - step);
    const b = await readAt(fh, start, pos - start);
    let k = b.length - 1;
    while (k >= 0 && b[k] === 0) k--;
    if (k >= 0) return zeros + (b.length - 1 - k);
    zeros += b.length;
    pos = start;
  }
  return zeros;
}

export async function analyzeBroken(filePath: string): Promise<Analysis> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const a: Analysis = {
      path: filePath,
      name: path.basename(filePath),
      size,
      kind: 'empty',
      atoms: [],
      offsetCandidates: [],
      zeroTailBytes: 0,
      notes: [],
    };
    if (size < 64) {
      a.notes.push('Файл слишком маленький — данных нет.');
      return a;
    }
    a.zeroTailBytes = await zeroTail(fh, size);
    if (a.zeroTailBytes >= size - 64) {
      a.notes.push('Файл целиком состоит из нулей — камера зарезервировала место, но данных нет.');
      return a;
    }

    a.atoms = await readTopAtoms(fh, size);
    const ftyp = a.atoms.find((x) => x.type === 'ftyp');
    if (ftyp) a.ftypBrand = fourcc(await readAt(fh, ftyp.start + 8, 4), 0);
    const head = await readAt(fh, 0, Math.min(size, HEAD_SCAN));

    const cands: OffsetCandidate[] = [];
    const add = (offset: number, source: OffsetCandidate['source']) => {
      if (offset > 0 && offset < size && !cands.some((c) => c.offset === offset)) cands.push({ offset, source });
    };

    const rtmd = findSonyRtmd(head);
    if (rtmd >= 0) a.sonyRtmdAt = rtmd;

    const moov = a.atoms.find((x) => x.type === 'moov');
    const mdat = a.atoms.find((x) => x.type === 'mdat');
    if (mdat) a.mdat = mdat;

    if (moov && !moov.truncated) {
      a.kind = 'has-moov';
      a.notes.push('В файле есть индекс (moov). Возможно, он не сломан — но попробовать можно.');
    } else if (mdat) {
      a.kind = 'no-moov';
      add(mdat.start + mdat.headerSize, 'mdat-atom');
      a.notes.push('Структура MP4 цела, но нет индекса (moov) — типичная оборванная запись.');
    } else {
      a.kind = 'garbage-header';
      // An 'mdat' fourcc somewhere in the head (header partly written)
      for (let i = head.indexOf('mdat', 4, 'latin1'); i >= 4; i = head.indexOf('mdat', i + 1, 'latin1')) {
        const sz = head.readUInt32BE(i - 4);
        add(i + 4 + (sz === 1 ? 8 : 0), 'mdat-atom');
        if (cands.length > 4) break;
      }
      if (rtmd >= 0) add(rtmd, 'sony-rtmd');
      a.notes.push(
        rtmd >= 0
          ? `Заголовок файла не записан (мусор), но с байта ${rtmd} начинаются данные Sony — похоже на .RSV после отключения питания.`
          : 'Заголовок файла не записан или повреждён. Начало данных определим по эталонному файлу.',
      );
    }
    if (a.zeroTailBytes > 1024 * 1024) {
      a.notes.push(`В конце файла ${(a.zeroTailBytes / 1024 ** 3).toFixed(2)} ГБ нулей — эта часть не была записана.`);
    }
    a.offsetCandidates = cands;
    return a;
  } finally {
    await fh.close();
  }
}

/** Add the reference-layout candidate (where the healthy file's data starts) at the right priority. */
export function withReferenceCandidate(a: Analysis, refDataStart: number): OffsetCandidate[] {
  const list = [...a.offsetCandidates];
  if (a.kind === 'garbage-header' && refDataStart > 0 && !list.some((c) => c.offset === refDataStart)) {
    // Same camera usually writes the same header length, so this is the best guess
    // unless we already found a Sony rtmd marker at a different place.
    const pos = list.findIndex((c) => c.source === 'sony-rtmd');
    list.splice(pos >= 0 ? pos + 1 : 0, 0, { offset: refDataStart, source: 'reference-layout' });
  }
  return list;
}
