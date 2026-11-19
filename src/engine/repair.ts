// High-level operations used by the app: analyze, probe the data offset, repair, undo.
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AnalyzeResponse, Analysis, ProbeResult, ProgressEvent, RepairPlan, RepairResult,
} from '../shared/types';
import { analyzeBroken, withReferenceCandidate } from './detect';
import { repairInPlace, undoInPlace } from './inplace';
import { loadMovie } from './mp4';
import { describeReference, findReferences } from './reference';
import { runUntrunc } from './untrunc';

export { undoInPlace, describeReference };

export async function freeSpace(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function analyze(filePath: string): Promise<AnalyzeResponse> {
  const analysis = await analyzeBroken(filePath);
  const references = analysis.kind === 'empty' ? [] : await findReferences(analysis);
  return { analysis, references, freeBytes: await freeSpace(path.dirname(filePath)) };
}

const PROBE_WINDOW = 256 * 1024 * 1024;

/** Ask untrunc whether sample data really starts at `offset` (fast: small window, no output). */
export async function probeOffset(bin: string, reference: string, broken: Analysis, offset: number, signal?: AbortSignal): Promise<ProbeResult> {
  const end = Math.min(broken.size, offset + PROBE_WINDOW);
  const r = await runUntrunc({ bin, reference, broken: broken.path, range: [offset, end], dontWrite: true, signal });
  const video = Object.entries(r.found).filter(([k]) => !k.endsWith('keyframes') && /avc|hvc|hev|mp4v|ap|jpeg|mjp/.test(k));
  const videoPackets = video.reduce((s, [, v]) => s + v, 0);
  const windowIsWhole = end === broken.size;
  const stopped = r.prematureEndPercent;
  // A wrong offset makes untrunc give up almost immediately.
  const ok = videoPackets > 0 && (stopped === undefined || stopped >= (windowIsWhole ? 1 : 50));
  return {
    offset,
    ok,
    packets: r.packets,
    stoppedAtPercent: stopped,
    message: ok ? undefined : r.errors[0] ?? 'кадры не найдены',
  };
}

/** Try the analysis' offset candidates (plus the reference layout) and return the first that works. */
export async function detectDataOffset(bin: string, referencePath: string, broken: Analysis, signal?: AbortSignal): Promise<{ best?: ProbeResult; tried: ProbeResult[] }> {
  const ref = await describeReference(referencePath, broken);
  const cands = withReferenceCandidate(broken, ref?.dataStart ?? 0);
  const tried: ProbeResult[] = [];
  for (const c of cands.slice(0, 6)) {
    const r = await probeOffset(bin, referencePath, broken, c.offset, signal);
    tried.push(r);
    if (r.ok) return { best: r, tried };
  }
  return { tried };
}

function defaultOutput(broken: string): string {
  const ext = path.extname(broken);
  const base = broken.slice(0, broken.length - ext.length);
  const outExt = /^\.(mov)$/i.test(ext) ? ext : '.mp4';
  return `${base}_fixed${outExt}`;
}

export async function repair(
  bin: string,
  plan: RepairPlan,
  onProgress: (e: ProgressEvent) => void,
  onLog: (l: string) => void,
  signal?: AbortSignal,
): Promise<RepairResult> {
  const logs: string[] = [];
  const log = (l: string) => {
    logs.push(l);
    onLog(l);
  };
  const fail = (error: string): RepairResult => ({ ok: false, mode: plan.mode, error, log: logs.join('\n') });

  onProgress({ phase: 'prepare', percent: 0, message: 'Подготовка' });
  const broken = await analyzeBroken(plan.broken);
  if (broken.kind === 'empty') return fail(broken.notes.join(' ') || 'В файле нет данных');

  let dataOffset = plan.dataOffset;
  if (dataOffset === undefined && broken.kind === 'no-moov') dataOffset = broken.offsetCandidates[0]?.offset;
  if (dataOffset === undefined && broken.kind === 'garbage-header') {
    onProgress({ phase: 'prepare', percent: 30, message: 'Ищу начало видеоданных' });
    const d = await detectDataOffset(bin, plan.reference, broken, signal);
    if (!d.best) return fail('Не удалось найти начало видеоданных. Проверьте, что эталон снят той же камерой с теми же настройками.');
    dataOffset = d.best.offset;
    log(`Начало данных: байт ${dataOffset}`);
  }
  // Data ends where the zero tail starts (camera preallocated but never wrote).
  const dataEnd = broken.size - (broken.zeroTailBytes > 1024 * 1024 ? broken.zeroTailBytes : 0);

  if (plan.mode === 'copy') {
    let out = plan.output ?? defaultOutput(plan.broken);
    if (!plan.overwrite) out = await uniquePath(out);
    const free = await freeSpace(path.dirname(out));
    if (free !== null && free < broken.size + 64 * 1024 * 1024) {
      return fail(
        `Недостаточно места: нужно ~${gb(broken.size)} ГБ, свободно ${gb(free)} ГБ. Освободите место, выберите другую папку или используйте режим «На месте».`,
      );
    }
    if (plan.overwrite) await fsp.unlink(out).catch(() => undefined);
    const useRange = broken.kind === 'garbage-header' || plan.dataOffset !== undefined;
    const r = await runUntrunc({
      bin, reference: plan.reference, broken: plan.broken, dst: out,
      range: useRange && dataOffset !== undefined ? [dataOffset, dataEnd] : undefined,
      skipUnknown: plan.skipUnknown, stretchVideo: plan.stretchVideo, signal, onProgress, onLog: log,
    });
    if (r.aborted) return fail('Отменено');
    const exists = await fsp.stat(out).then(() => true, () => false);
    if (!exists) return fail(r.errors[0] ?? `untrunc завершился с кодом ${r.code}`);
    return finish(out, undefined, r.found, r.prematureEndPercent, broken.size, onProgress, plan.mode, logs);
  }

  // In-place
  if (plan.skipUnknown) return fail('Пропуск неизвестных участков (-s) работает только в режиме «Копия».');
  if (dataOffset === undefined) return fail('Для починки на месте нужен файл без индекса или с испорченным заголовком.');
  if (broken.kind === 'has-moov') return fail('В файле уже есть moov — используйте режим «Копия».');
  const free = await freeSpace(path.dirname(plan.broken));
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'videorescue-'));
  const moovFile = path.join(tmpDir, 'moov-only.mp4');
  try {
    const r = await runUntrunc({
      bin, reference: plan.reference, broken: plan.broken, dst: moovFile, range: [dataOffset, dataEnd],
      stretchVideo: plan.stretchVideo, moovOnly: true, signal, onProgress, onLog: log,
    });
    if (r.aborted) return fail('Отменено');
    const st = await fsp.stat(moovFile).catch(() => null);
    if (!st) return fail(r.errors[0] ?? `untrunc завершился с кодом ${r.code}`);
    if (st.size > 256 * 1024 * 1024) return fail('Эта сборка untrunc не поддерживает режим «на месте» (записала весь файл).');
    if (free !== null && free < st.size + 16 * 1024 * 1024) return fail('Недостаточно места даже для индекса');
    onProgress({ phase: 'patch', percent: 0, message: 'Записываю заголовок и индекс' });
    const res = await repairInPlace({
      broken: plan.broken, moovOnlyFile: moovFile, reference: plan.reference, dataOffset,
      mdat: broken.kind === 'no-moov' ? broken.mdat : undefined, atoms: broken.atoms, renameToMp4: plan.renameToMp4,
    });
    log(`Индекс ${(res.moovBytes / 1024).toFixed(0)} КБ дописан в конец файла; копия старого заголовка: ${res.backupPath}`);
    onProgress({ phase: 'patch', percent: 100 });
    return finish(res.path, res.backupPath, r.found, r.prematureEndPercent, broken.size, onProgress, plan.mode, logs);
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function finish(
  out: string, backupPath: string | undefined, found: Record<string, number>, premature: number | undefined,
  brokenSize: number, onProgress: (e: ProgressEvent) => void, mode: RepairPlan['mode'], logs: string[],
): Promise<RepairResult> {
  onProgress({ phase: 'verify', percent: 0, message: 'Проверяю результат' });
  const m = await loadMovie(out);
  onProgress({ phase: 'done', percent: 100 });
  if (!m) return { ok: false, mode, outputPath: out, backupPath, error: 'Результат не читается как MP4', log: logs.join('\n') };
  const hasVideo = m.summary.tracks.some((t) => t.handler === 'vide' && t.sampleCount > 0);
  const recoveredFraction = mode === 'inplace' ? Math.min(1, m.summary.maxChunkOffset / brokenSize) : undefined;
  return {
    ok: hasVideo,
    mode,
    outputPath: out,
    backupPath,
    movie: m.summary,
    recoveredFraction,
    untruncFound: found,
    prematureEndPercent: premature,
    error: hasVideo ? undefined : 'Видеокадры не восстановлены',
    log: logs.join('\n'),
  };
}

async function uniquePath(p: string): Promise<string> {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = i === 1 ? p : `${base}-${i}${ext}`;
    const exists = await fsp.stat(cand).then(() => true, () => false);
    if (!exists) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

function gb(n: number) {
  return (n / 1024 ** 3).toFixed(1);
}
