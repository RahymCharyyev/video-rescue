import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalyzeResponse, Phase, ProgressEvent, ReferenceCandidate, RepairMode, RepairResult,
} from '../shared/types';
import { basename, bytes, defaultCopyOutput, dirname, duration, extname } from './format';

type Env = Awaited<ReturnType<typeof window.api.env>>;
type OffsetState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok'; offset: number; packets: number }
  | { status: 'fail'; message: string };

const KIND_LABEL: Record<string, { text: string; tone: 'warn' | 'bad' | 'ok' }> = {
  'no-moov': { text: 'Нет индекса (moov)', tone: 'warn' },
  'garbage-header': { text: 'Испорчен заголовок', tone: 'warn' },
  'has-moov': { text: 'Индекс на месте', tone: 'ok' },
  empty: { text: 'Данных нет', tone: 'bad' },
};

const PHASES: Record<RepairMode, { phase: Phase; label: string; weight: number }[]> = {
  copy: [
    { phase: 'prepare', label: 'Подготовка', weight: 2 },
    { phase: 'stats', label: 'Изучаю эталон', weight: 8 },
    { phase: 'scan', label: 'Ищу кадры и звук', weight: 30 },
    { phase: 'write', label: 'Записываю новый файл', weight: 58 },
    { phase: 'verify', label: 'Проверка', weight: 2 },
  ],
  inplace: [
    { phase: 'prepare', label: 'Подготовка', weight: 2 },
    { phase: 'stats', label: 'Изучаю эталон', weight: 15 },
    { phase: 'scan', label: 'Ищу кадры и звук', weight: 75 },
    { phase: 'write', label: 'Строю индекс', weight: 3 },
    { phase: 'patch', label: 'Записываю заголовок и индекс', weight: 3 },
    { phase: 'verify', label: 'Проверка', weight: 2 },
  ],
};

function overall(mode: RepairMode, p: ProgressEvent | null): number {
  if (!p) return 0;
  if (p.phase === 'done') return 100;
  const list = PHASES[mode];
  const total = list.reduce((s, x) => s + x.weight, 0);
  let acc = 0;
  for (const x of list) {
    if (x.phase === p.phase) return Math.min(100, ((acc + (x.weight * p.percent) / 100) / total) * 100);
    acc += x.weight;
  }
  return 0;
}

export default function App() {
  const [env, setEnv] = useState<Env | null>(null);
  const [brokenPath, setBrokenPath] = useState<string | null>(null);
  const [resp, setResp] = useState<AnalyzeResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [refs, setRefs] = useState<ReferenceCandidate[]>([]);
  const [refPath, setRefPath] = useState<string | null>(null);
  const [offset, setOffset] = useState<OffsetState>({ status: 'idle' });
  const [manualOffset, setManualOffset] = useState('');
  const [mode, setMode] = useState<RepairMode>('copy');
  const [output, setOutput] = useState<string>('');
  const [overwrite, setOverwrite] = useState(false);
  const [outFree, setOutFree] = useState<number | null>(null);
  const [renameToMp4, setRenameToMp4] = useState(true);
  const [skipUnknown, setSkipUnknown] = useState(false);
  const [stretchVideo, setStretchVideo] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const startedAt = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    window.api.env().then(setEnv);
    const offP = window.api.onProgress(setProgress);
    const offL = window.api.onLog((l) => setLogs((x) => (x.length > 2000 ? [...x.slice(-1500), l] : [...x, l])));
    return () => {
      offP();
      offL();
    };
  }, []);

  const runningRef = useRef(false);
  runningRef.current = running;
  useEffect(
    () =>
      window.api.onOpenFile((p) => {
        if (!runningRef.current) openBrokenRef.current?.(p);
      }),
    [],
  );

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const analysis = resp?.analysis;
  const selectedRef = refs.find((r) => r.path === refPath) ?? null;
  const needsOffset = analysis?.kind === 'garbage-header';

  const reset = () => {
    setBrokenPath(null);
    setResp(null);
    setRefs([]);
    setRefPath(null);
    setOffset({ status: 'idle' });
    setManualOffset('');
    setResult(null);
    setUndoMsg(null);
    setProgress(null);
    setLogs([]);
    setAnalyzeError(null);
  };

  const openBroken = useCallback(async (p: string) => {
    reset();
    setBrokenPath(p);
    setAnalyzing(true);
    try {
      const r = await window.api.analyze(p);
      setResp(r);
      setRefs(r.references);
      setRefPath(r.references[0]?.path ?? null);
      setOutput(defaultCopyOutput(p));
      setOverwrite(false);
      const enough = r.freeBytes === null || r.freeBytes > r.analysis.size + 64 * 1024 * 1024;
      const inplaceOk = r.analysis.kind === 'no-moov' || r.analysis.kind === 'garbage-header';
      setMode(!enough && inplaceOk ? 'inplace' : 'copy');
      setRenameToMp4(!/^\.(mp4|mov|m4v)$/i.test(extname(p)));
    } catch (e) {
      setAnalyzeError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }, []);
  const openBrokenRef = useRef(openBroken);
  openBrokenRef.current = openBroken;

  // Find where sample data starts once a reference is chosen (garbage-header files only)
  useEffect(() => {
    if (!analysis || !refPath || analysis.kind !== 'garbage-header') return;
    let cancelled = false;
    setOffset({ status: 'probing' });
    window.api.detectOffset(refPath, analysis).then(
      (d) => {
        if (cancelled) return;
        if (d.best) setOffset({ status: 'ok', offset: d.best.offset, packets: d.best.packets });
        else setOffset({ status: 'fail', message: d.tried[0]?.message ?? 'кадры не найдены' });
      },
      (e) => !cancelled && setOffset({ status: 'fail', message: (e as Error).message }),
    );
    return () => {
      cancelled = true;
    };
  }, [analysis, refPath]);

  useEffect(() => {
    if (mode !== 'copy' || !output) return;
    window.api.freeSpace(dirname(output)).then(setOutFree);
  }, [mode, output]);

  const pickBroken = async () => {
    const p = await window.api.pickFile('Выберите сломанное видео');
    if (p) openBroken(p);
  };

  const pickReference = async () => {
    if (!analysis) return;
    const p = await window.api.pickFile('Выберите целое видео с той же камеры');
    if (!p) return;
    const c = await window.api.describeReference(p, analysis);
    if (!c) {
      alertBox('В этом файле нет индекса (moov) — эталоном может быть только целое видео.');
      return;
    }
    setRefs((r) => [c, ...r.filter((x) => x.path !== c.path)]);
    setRefPath(c.path);
  };

  const [notice, setNotice] = useState<string | null>(null);
  const alertBox = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 6000);
  };

  const manualOffsetNum = manualOffset.trim() ? Number(manualOffset.trim()) : undefined;
  const effectiveOffset =
    manualOffsetNum !== undefined && Number.isFinite(manualOffsetNum)
      ? manualOffsetNum
      : offset.status === 'ok'
        ? offset.offset
        : undefined;

  const inplaceAllowed = analysis?.kind === 'no-moov' || analysis?.kind === 'garbage-header';
  const copyNeed = (analysis?.size ?? 0) + 64 * 1024 * 1024;
  const copyEnough = outFree === null || outFree >= copyNeed;

  const blockers = useMemo(() => {
    const b: string[] = [];
    if (!env?.untruncFound) b.push('Не найден движок untrunc — пересоберите приложение (см. README).');
    if (!analysis || analysis.kind === 'empty') b.push('Выберите сломанный файл с данными.');
    if (!refPath) b.push('Нужен эталон: целое видео с той же камеры и с теми же настройками.');
    if (needsOffset && effectiveOffset === undefined) b.push('Не найдено начало видеоданных.');
    if (mode === 'copy' && !copyEnough) b.push('Не хватает места для копии — выберите другую папку или режим «На месте».');
    if (mode === 'inplace' && !inplaceAllowed) b.push('Этот файл можно чинить только в режиме «Копия».');
    return b;
  }, [env, analysis, refPath, needsOffset, effectiveOffset, mode, copyEnough, inplaceAllowed]);

  const start = async () => {
    if (!brokenPath || !refPath || blockers.length) return;
    setRunning(true);
    setResult(null);
    setUndoMsg(null);
    setLogs([]);
    setProgress({ phase: 'prepare', percent: 0 });
    startedAt.current = Date.now();
    const r = await window.api.repair({
      broken: brokenPath,
      reference: refPath,
      mode,
      dataOffset: needsOffset || manualOffsetNum !== undefined ? effectiveOffset : undefined,
      output: mode === 'copy' ? output : undefined,
      overwrite: mode === 'copy' && overwrite,
      skipUnknown: mode === 'copy' && skipUnknown,
      stretchVideo,
      renameToMp4: mode === 'inplace' && renameToMp4,
    });
    setResult(r);
    setRunning(false);
  };

  const undo = async () => {
    if (!result?.backupPath) return;
    const r = await window.api.undo(result.backupPath);
    if (r.ok) {
      setUndoMsg(`Файл возвращён в исходное состояние: ${basename(r.restoredPath!)}`);
      setResult({ ...result, backupPath: undefined });
    } else setUndoMsg(`Откат не удался: ${r.error}`);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (running) return;
    const f = e.dataTransfer.files[0];
    if (f) openBroken(window.api.pathForFile(f));
  };

  useEffect(() => {
    if (running || result) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [running, result]);

  const elapsed = running ? Math.round((Date.now() - startedAt.current) / 1000) : 0;
  const pct = overall(mode, progress);

  return (
    <div
      className={`app ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!running) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="top">
        <div className="brand">
          <span className="rec" aria-hidden />
          <div>
            <h1>Video Rescue</h1>
            <p>Восстановление записей, оборванных разряженной батареей или вынутой картой</p>
          </div>
        </div>
        {brokenPath && !running && (
          <button className="ghost" onClick={reset}>
            Другой файл
          </button>
        )}
      </header>

      {env && !env.untruncFound && (
        <div className="banner bad">
          Движок восстановления не найден: <code>{env.untrunc}</code>. Соберите untrunc командой <code>npm run untrunc</code>.
        </div>
      )}
      {notice && <div className="banner warn">{notice}</div>}

      {!brokenPath && (
        <button className="drop" onClick={pickBroken}>
          <span className="drop-icon" aria-hidden>
            <svg viewBox="0 0 48 48" width="48" height="48">
              <rect x="5" y="11" width="28" height="26" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
              <path d="M33 20l10-6v20l-10-6z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
              <path d="M14 22l8 6M22 22l-8 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
          <strong>Перетащите сюда сломанное видео</strong>
          <span>или нажмите, чтобы выбрать файл · .RSV, .MP4, .MOV</span>
        </button>
      )}

      {brokenPath && (
        <main className="steps">
          {/* 1. Broken file */}
          <section className="card">
            <div className="card-head">
              <span className="num">1</span>
              <h2>Сломанный файл</h2>
            </div>
            {analyzing && <p className="muted">Изучаю файл…</p>}
            {analyzeError && <p className="err">{analyzeError}</p>}
            {analysis && (
              <>
                <div className="file-row">
                  <div className="file-name" title={analysis.path}>
                    {analysis.name}
                  </div>
                  <span className="size">{bytes(analysis.size)}</span>
                  <span className={`badge ${KIND_LABEL[analysis.kind].tone}`}>{KIND_LABEL[analysis.kind].text}</span>
                </div>
                <ul className="notes">
                  {analysis.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {/* 2. Reference */}
          {analysis && analysis.kind !== 'empty' && (
            <section className="card">
              <div className="card-head">
                <span className="num">2</span>
                <h2>Эталон</h2>
                <button className="ghost small" onClick={pickReference} disabled={running}>
                  Выбрать файл…
                </button>
              </div>
              <p className="muted">
                Целое видео с <b>той же камеры</b> и с <b>теми же настройками</b>: разрешение, частота кадров, кодек, битрейт, звук.
                Если такого нет — снимите 30–60 секунд и выберите его.
              </p>
              {refs.length === 0 && <p className="warn-text">Рядом не нашлось целых видео. Выберите эталон вручную.</p>}
              <div className="refs">
                {refs.slice(0, 6).map((r) => (
                  <label key={r.path} className={`ref ${r.path === refPath ? 'sel' : ''}`}>
                    <input
                      type="radio"
                      name="ref"
                      checked={r.path === refPath}
                      onChange={() => setRefPath(r.path)}
                      disabled={running}
                    />
                    <div className="ref-body">
                      <div className="ref-top">
                        <span className="ref-name">{r.name}</span>
                        <span className="muted">
                          {duration(r.movie.durationSec)} · {bytes(r.size)}
                        </span>
                      </div>
                      <div className="ref-sum">
                        {r.summary}
                        {r.sony?.model ? ` · ${r.sony.model}` : ''}
                      </div>
                      {r.reasons.length > 0 && <div className="ref-why">{r.reasons.join(' · ')}</div>}
                    </div>
                  </label>
                ))}
              </div>

              {needsOffset && refPath && (
                <div className="offset">
                  {offset.status === 'probing' && <span className="muted">Ищу, где начинаются видеоданные…</span>}
                  {offset.status === 'ok' && (
                    <span className="ok-text">
                      ✓ Видеоданные начинаются с байта {offset.offset.toLocaleString('ru-RU')}
                    </span>
                  )}
                  {offset.status === 'fail' && (
                    <span className="err">
                      Не удалось найти начало данных с этим эталоном ({offset.message}). Попробуйте другой эталон — снятый с теми же
                      настройками.
                    </span>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 3. Mode */}
          {analysis && analysis.kind !== 'empty' && (
            <section className="card">
              <div className="card-head">
                <span className="num">3</span>
                <h2>Как сохранить</h2>
              </div>
              <div className="modes">
                <label className={`mode ${mode === 'copy' ? 'sel' : ''}`}>
                  <input type="radio" name="mode" checked={mode === 'copy'} onChange={() => setMode('copy')} disabled={running} />
                  <div>
                    <strong>Новый файл</strong>
                    <span>Исходник не трогается. Нужно ~{bytes(analysis.size)} свободного места.</span>
                    {mode === 'copy' && (
                      <div className="out-row">
                        <code title={output}>{output}</code>
                        <button
                          className="ghost small"
                          disabled={running}
                          onClick={async () => {
                            const p = await window.api.pickSave(output);
                            if (p) {
                              setOutput(p);
                              setOverwrite(true);
                            }
                          }}
                        >
                          Изменить…
                        </button>
                      </div>
                    )}
                    {mode === 'copy' && (
                      <span className={copyEnough ? 'muted' : 'err'}>Свободно в папке: {bytes(outFree)}</span>
                    )}
                  </div>
                </label>
                <label className={`mode ${mode === 'inplace' ? 'sel' : ''} ${inplaceAllowed ? '' : 'disabled'}`}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'inplace'}
                    onChange={() => setMode('inplace')}
                    disabled={running || !inplaceAllowed}
                  />
                  <div>
                    <strong>Починить на месте</strong>
                    <span>
                      Почти не нужно места: в файл записывается заголовок и дописывается индекс (несколько МБ). Сами кадры не
                      меняются, исходные байты сохраняются для отката.
                    </span>
                    {mode === 'inplace' && !/^\.(mp4|mov|m4v)$/i.test(extname(brokenPath)) && (
                      <label className="check">
                        <input type="checkbox" checked={renameToMp4} onChange={(e) => setRenameToMp4(e.target.checked)} />
                        Переименовать в .MP4
                      </label>
                    )}
                  </div>
                </label>
              </div>

              <button className="link" onClick={() => setAdvanced((a) => !a)}>
                {advanced ? '▾' : '▸'} Дополнительно
              </button>
              {advanced && (
                <div className="advanced">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={skipUnknown}
                      disabled={mode !== 'copy'}
                      onChange={(e) => setSkipUnknown(e.target.checked)}
                    />
                    Пропускать нераспознанные участки (<code>-s</code>) — если восстановление обрывается на середине. Только для
                    нового файла.
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={stretchVideo} onChange={(e) => setStretchVideo(e.target.checked)} />
                    Подогнать длительность видео под звук (<code>-sv</code>)
                  </label>
                  <label className="field">
                    Начало данных, байт (если знаете точно):
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder={effectiveOffset !== undefined ? String(effectiveOffset) : 'авто'}
                      value={manualOffset}
                      onChange={(e) => setManualOffset(e.target.value.replace(/[^\d]/g, ''))}
                    />
                  </label>
                </div>
              )}
            </section>
          )}

          {/* Run */}
          {analysis && analysis.kind !== 'empty' && !result && (
            <section className="run">
              {!running ? (
                <>
                  <button className="primary" onClick={start} disabled={blockers.length > 0}>
                    Восстановить
                  </button>
                  {blockers.length > 0 && <p className="muted small">{blockers[0]}</p>}
                </>
              ) : (
                <div className="progress">
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="progress-row">
                    <span>
                      {PHASES[mode].find((x) => x.phase === progress?.phase)?.label ?? progress?.message ?? '…'}
                      {progress && progress.phase !== 'prepare' ? ` · ${Math.floor(progress.percent)}%` : ''}
                    </span>
                    <span className="muted">
                      {Math.floor(pct)}% · {duration(elapsed)}
                    </span>
                    <button className="ghost small" onClick={() => window.api.cancel()}>
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Result */}
          {result && (
            <section className={`card result ${result.ok ? 'good' : 'fail'}`}>
              {result.ok && result.movie ? (
                <>
                  <h2>Готово — {duration(result.movie.durationSec)} видео</h2>
                  <p className="file-name" title={result.outputPath}>
                    {result.outputPath}
                  </p>
                  <ul className="notes">
                    {result.movie.tracks
                      .filter((t) => t.handler === 'vide' || t.handler === 'soun')
                      .map((t, i) => (
                        <li key={i}>
                          {t.handler === 'vide' ? 'Видео' : 'Звук'}: {duration(t.durationSec)}
                          {t.handler === 'vide' && t.width ? `, ${t.width}×${t.height}` : ''}
                        </li>
                      ))}
                    {result.recoveredFraction !== undefined && (
                      <li>Использовано {(result.recoveredFraction * 100).toFixed(1)}% данных файла</li>
                    )}
                    {result.mode === 'inplace' && result.backupPath && (
                      <li>
                        Копия исходного заголовка: <code>{basename(result.backupPath)}</code> — удалите её, когда убедитесь, что видео в
                        порядке.
                      </li>
                    )}
                  </ul>
                  <div className="actions">
                    <button className="primary" onClick={() => window.api.openPath(result.outputPath!)}>
                      Открыть видео
                    </button>
                    <button className="ghost" onClick={() => window.api.reveal(result.outputPath!)}>
                      Показать в папке
                    </button>
                    {result.mode === 'inplace' && result.backupPath && (
                      <button className="ghost" onClick={undo}>
                        Отменить починку
                      </button>
                    )}
                    <button className="ghost" onClick={reset}>
                      Следующий файл
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2>Не получилось</h2>
                  <p className="err">{result.error}</p>
                  <ul className="notes">
                    <li>Проверьте, что эталон снят той же камерой с точно такими же настройками.</li>
                    <li>Снимите новый эталон на 30–60 секунд и попробуйте снова.</li>
                    <li>
                      Если восстановление обрывается на середине — включите «Пропускать нераспознанные участки» в разделе
                      «Дополнительно».
                    </li>
                  </ul>
                  <div className="actions">
                    <button className="primary" onClick={() => setResult(null)}>
                      Попробовать снова
                    </button>
                  </div>
                </>
              )}
              {undoMsg && <p className="muted">{undoMsg}</p>}
            </section>
          )}

          {(running || result) && logs.length > 0 && (
            <section className="log-wrap">
              <button className="link" onClick={() => setShowLog((s) => !s)}>
                {showLog ? '▾' : '▸'} Технический журнал ({logs.length})
              </button>
              {showLog && <pre className="log">{logs.join('\n')}</pre>}
            </section>
          )}
          <div ref={bottomRef} />
        </main>
      )}

      <footer className="foot">
        <span>
          Video Rescue {env?.version} · движок{' '}
          <a href="https://github.com/anthwlock/untrunc" target="_blank" rel="noreferrer">
            untrunc
          </a>{' '}
          (GPL-2.0)
        </span>
      </footer>
    </div>
  );
}
