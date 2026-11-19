// Find and rank healthy files that can serve as the untrunc reference.
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { Analysis, ReferenceCandidate, SonyClipMeta } from '../shared/types';
import { describeMovie, loadMovie } from './mp4';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.mts', '.lrv', '.insv', '.360']);

function splitName(name: string): { prefix: string; num: number | null } {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return { prefix: base.toLowerCase(), num: null };
  return { prefix: (m[1] + '#' + m[3]).toLowerCase(), num: Number(m[2]) };
}

/** Sony writes C1234M01.XML next to C1234.MP4 */
async function readSonyXml(videoPath: string): Promise<SonyClipMeta | undefined> {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return undefined;
  }
  const xml = files.find((f) => f.toUpperCase() === `${base.toUpperCase()}M01.XML`);
  if (!xml) return undefined;
  try {
    const s = await fsp.readFile(path.join(dir, xml), 'utf8');
    const attr = (tag: string, name: string) => s.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`))?.[1];
    return {
      model: attr('Device', 'modelName'),
      videoCodec: attr('VideoFrame', 'videoCodec'),
      fps: attr('VideoFrame', 'captureFps'),
      audioCodec: attr('AudioRecPort', 'audioCodec'),
      audioChannels: Number(attr('AudioFormat', 'numOfChannel')) || undefined,
    };
  } catch {
    return undefined;
  }
}

export async function describeReference(refPath: string, broken?: Analysis): Promise<ReferenceCandidate | null> {
  const movie = await loadMovie(refPath);
  if (!movie) return null;
  const st = await fsp.stat(refPath);
  const mdat = movie.atoms.find((a) => a.type === 'mdat');
  const dataStart = mdat ? mdat.start + mdat.headerSize : 0;
  const preMdatAtoms = mdat ? movie.atoms.filter((a) => a.start < mdat.start) : [];
  const c: ReferenceCandidate = {
    path: refPath,
    name: path.basename(refPath),
    size: st.size,
    mtimeMs: st.mtimeMs,
    score: 0,
    reasons: [],
    ftypBrand: movie.ftypBrand,
    movie: movie.summary,
    dataStart,
    preMdatAtoms,
    summary: describeMovie(movie.summary),
    sony: await readSonyXml(refPath),
  };
  if (broken) scoreReference(c, broken);
  return c;
}

function scoreReference(c: ReferenceCandidate, b: Analysis): void {
  const add = (pts: number, why: string) => {
    c.score += pts;
    if (why) c.reasons.push(why);
  };
  if (b.ftypBrand && c.ftypBrand === b.ftypBrand) add(40, `тот же тип файла (${b.ftypBrand})`);
  const hasRtmd = c.movie.tracks.some((t) => t.codec === 'rtmd');
  if (b.sonyRtmdAt !== undefined && hasRtmd) add(40, 'снят камерой Sony (есть дорожка rtmd)');
  if (b.kind === 'garbage-header' && b.sonyRtmdAt !== undefined && c.dataStart === b.sonyRtmdAt)
    add(30, 'данные начинаются с того же байта, что и в сломанном');

  const bn = splitName(b.name);
  const cn = splitName(c.name);
  if (bn.prefix === cn.prefix && bn.num !== null && cn.num !== null) {
    const d = Math.abs(bn.num - cn.num);
    add(Math.max(0, 25 - d), d === 1 ? 'соседний клип по номеру' : 'та же серия имён файлов');
  }
  const ext = (n: string) => path.extname(n).toLowerCase();
  if (ext(b.name) === ext(c.name) || ext(b.name) === '.rsv') add(5, '');

  const stem = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase();
  if (stem(c.name) === stem(b.name) || /_fixed/i.test(c.name)) add(-30, 'это восстановленная копия — лучше взять исходный клип');
  if (c.movie.durationSec >= 20) add(10, '');
  else if (c.movie.durationSec < 3) add(-20, 'очень короткий — эталон лучше длиннее 20 секунд');
  if (!c.movie.tracks.some((t) => t.handler === 'vide')) add(-50, 'нет видеодорожки');
}

/** Healthy videos in the same folder (and next to it), best first. */
export async function findReferences(broken: Analysis, extraDirs: string[] = []): Promise<ReferenceCandidate[]> {
  const dirs = [path.dirname(broken.path), ...extraDirs];
  const seen = new Set<string>();
  const out: ReferenceCandidate[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.') || !VIDEO_EXT.has(path.extname(n).toLowerCase())) continue;
      const p = path.join(dir, n);
      if (p === broken.path || seen.has(p)) continue;
      seen.add(p);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const c = await describeReference(p, broken);
      if (c) out.push(c);
      if (out.length >= 60) break;
    }
  }
  out.sort((x, y) => y.score - x.score || y.movie.durationSec - x.movie.durationSec);
  return out;
}
