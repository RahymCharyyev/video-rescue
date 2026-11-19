// Run the bundled untrunc binary and turn its console output into progress events.
import { spawn } from 'child_process';
import type { Phase, ProgressEvent } from '../shared/types';

export interface UntruncOptions {
  bin: string;
  reference: string;
  broken: string;
  /** -dst */
  dst?: string;
  /** -range A:B (bytes of the broken file holding sample data) */
  range?: [number, number];
  skipUnknown?: boolean;
  stretchVideo?: boolean;
  dontWrite?: boolean;
  /** Patched untrunc: write ftyp+moov only (env UNTRUNC_MOOV_ONLY) */
  moovOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  onLog?: (line: string) => void;
}

export interface UntruncResult {
  code: number | null;
  aborted: boolean;
  found: Record<string, number>;
  packets: number;
  durationsMs: Record<string, number>;
  prematureEndPercent?: number;
  errors: string[];
  warnings: string[];
  log: string;
}

export function buildArgs(o: UntruncOptions): string[] {
  const args = ['-n'];
  if (o.skipUnknown) args.push('-s');
  if (o.stretchVideo) args.push('-sv');
  if (o.dontWrite) args.push('-dw');
  if (o.range) args.push('-range', `${o.range[0]}:${o.range[1]}`);
  if (o.dst) args.push('-dst', o.dst);
  args.push(o.reference, o.broken);
  return args;
}

/** Parse "Info: Found 146031626 packets ( avc1: 151802 avc1-keyframes: 3163 twos: 145728000 rtmd: 151824 )" */
export function parseFound(line: string): { packets: number; found: Record<string, number> } | null {
  const m = line.match(/Found (\d+) packets\s*\((.*)\)/);
  if (!m) return null;
  const found: Record<string, number> = {};
  for (const p of m[2].matchAll(/([\w-]+):\s*(\d+)/g)) found[p[1]] = Number(p[2]);
  return { packets: Number(m[1]), found };
}

export function runUntrunc(o: UntruncOptions): Promise<UntruncResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (o.moovOnly) env.UNTRUNC_MOOV_ONLY = '1';
    else delete env.UNTRUNC_MOOV_ONLY;
    const child = spawn(o.bin, buildArgs(o), { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const res: UntruncResult = {
      code: null, aborted: false, found: {}, packets: 0, durationsMs: {}, errors: [], warnings: [], log: '',
    };
    let phase: Phase = 'stats';
    let lastPct = -1;
    let partial = '';
    const logLines: string[] = [];

    const emit = (pct: number) => {
      const p = Math.max(0, Math.min(100, pct));
      if (Math.floor(p) !== lastPct) {
        lastPct = Math.floor(p);
        o.onProgress?.({ phase, percent: p });
      }
    };
    const setPhase = (p: Phase, msg?: string) => {
      phase = p;
      lastPct = -1;
      o.onProgress?.({ phase, percent: 0, message: msg });
    };

    const handleLine = (raw: string) => {
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!line) return;
      const pctOnly = line.match(/^(?:\d+->\d+:\s*)?(\d+(?:\.\d+)?)%$/);
      if (pctOnly) {
        emit(Number(pctOnly[1]));
        return;
      }
      logLines.push(line);
      o.onLog?.(line);
      if (/reading mdat from truncated file/.test(line)) setPhase('scan', 'Поиск кадров и звука');
      if (/Info: saving/.test(line)) setPhase('write', 'Запись файла');
      const f = parseFound(line);
      if (f) {
        res.packets = f.packets;
        res.found = f.found;
      }
      const d = line.match(/Duration of ([\w-]+):.*\((\d+) ms\)/);
      if (d) res.durationsMs[d[1]] = Number(d[2]);
      const pe = line.match(/premature end \(~?(\d+(?:\.\d+)?)%\)/);
      if (pe) res.prematureEndPercent = Number(pe[1]);
      if (/^Error:/.test(line)) res.errors.push(line.replace(/^Error:\s*/, ''));
      if (/^Warning:/.test(line)) res.warnings.push(line.replace(/^Warning:\s*/, ''));
    };

    const onData = (chunk: Buffer) => {
      partial += chunk.toString('utf8');
      const parts = partial.split(/[\r\n]+/);
      partial = parts.pop() ?? '';
      for (const p of parts) {
        // progress may come as "0%  14.6%  27.1%" on one line
        if (/^(\s*(\d+->\d+:\s*)?\d+(\.\d+)?%\s*)+$/.test(p)) {
          const all = [...p.matchAll(/(\d+(?:\.\d+)?)%/g)];
          if (all.length) emit(Number(all[all.length - 1][1]));
          continue;
        }
        handleLine(p);
      }
      // a trailing progress fragment without newline
      const tail = partial.match(/(\d+(?:\.\d+)?)%\s*$/);
      if (tail) emit(Number(tail[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const onAbort = () => {
      res.aborted = true;
      child.kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      o.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Не удалось запустить untrunc (${o.bin}): ${e.message}`));
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (partial) handleLine(partial);
      res.code = code;
      res.log = logLines.join('\n');
      resolve(res);
    });
  });
}
