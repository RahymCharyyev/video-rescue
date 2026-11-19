// Types shared by the engine, the Electron main process and the renderer.

export type BrokenKind =
  /** File has a moov atom — probably not broken (or broken in a way untrunc may still fix). */
  | 'has-moov'
  /** Valid MP4 structure with an mdat, but no moov (classic truncated recording). */
  | 'no-moov'
  /** Header region is garbage (e.g. Sony .RSV after power loss). Data offset must be detected. */
  | 'garbage-header'
  | 'empty';

export interface AtomInfo {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  /** true if the atom claims to extend past the end of the file */
  truncated?: boolean;
}

export interface OffsetCandidate {
  offset: number;
  source: 'mdat-atom' | 'sony-rtmd' | 'reference-layout' | 'manual';
}

export interface Analysis {
  path: string;
  name: string;
  size: number;
  kind: BrokenKind;
  atoms: AtomInfo[];
  ftypBrand?: string;
  /** Sony real-time metadata header found at this offset (XAVC / RSV). */
  sonyRtmdAt?: number;
  /** Where the mdat atom header starts, when a valid one exists. */
  mdat?: AtomInfo;
  /** Possible offsets where sample data begins, best first. */
  offsetCandidates: OffsetCandidate[];
  /** Portion of the file that is all zeros at the end (preallocated, never written). */
  zeroTailBytes: number;
  notes: string[];
}

export interface TrackSummary {
  handler: string;
  codec: string;
  width?: number;
  height?: number;
  timescale: number;
  durationSec: number;
  sampleCount: number;
  fps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
}

export interface MovieSummary {
  durationSec: number;
  tracks: TrackSummary[];
  /** Largest chunk offset referenced by the moov — tells how far into the file data is used. */
  maxChunkOffset: number;
}

export interface ReferenceCandidate {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  score: number;
  reasons: string[];
  ftypBrand?: string;
  movie: MovieSummary;
  /** Offset where its sample data starts (mdat content start). */
  dataStart: number;
  /** Atoms before mdat (ftyp, uuid, free...), used to rebuild a missing header. */
  preMdatAtoms: AtomInfo[];
  /** Human-friendly one-liner: "H.264 1920×1080 50 fps · PCM 2 ch 48 kHz" */
  summary: string;
  /** Sony XML sidecar fields if found */
  sony?: SonyClipMeta;
}

export interface SonyClipMeta {
  model?: string;
  videoCodec?: string;
  fps?: string;
  audioCodec?: string;
  audioChannels?: number;
}

export interface ProbeResult {
  offset: number;
  ok: boolean;
  packets: number;
  /** "premature end" position reported by untrunc, % of the probed window */
  stoppedAtPercent?: number;
  message?: string;
}

export type RepairMode = 'copy' | 'inplace';

export interface RepairPlan {
  broken: string;
  reference: string;
  mode: RepairMode;
  /** Data offset in the broken file. Required for garbage-header files. */
  dataOffset?: number;
  /** Copy mode: output file path. Default: <dir>/<name>_fixed.mp4 */
  output?: string;
  /** Copy mode: allow replacing an existing output (the user confirmed it in a save dialog) */
  overwrite?: boolean;
  /** untrunc -s (copy mode only: it removes bytes, so offsets can't map in place) */
  skipUnknown?: boolean;
  /** untrunc -sv */
  stretchVideo?: boolean;
  /** In-place: rename .RSV (or other) to .MP4 afterwards */
  renameToMp4?: boolean;
}

export type Phase = 'prepare' | 'stats' | 'scan' | 'write' | 'patch' | 'verify' | 'done';

export interface ProgressEvent {
  phase: Phase;
  percent: number; // 0..100 within the phase
  message?: string;
}

export interface RepairResult {
  ok: boolean;
  mode: RepairMode;
  outputPath?: string;
  backupPath?: string;
  movie?: MovieSummary;
  /** Fraction of the broken file's bytes that ended up referenced (0..1) */
  recoveredFraction?: number;
  untruncFound?: Record<string, number>;
  prematureEndPercent?: number;
  error?: string;
  log: string;
}

export interface UndoResult {
  ok: boolean;
  restoredPath?: string;
  error?: string;
}

export interface AnalyzeResponse {
  analysis: Analysis;
  references: ReferenceCandidate[];
  freeBytes: number | null;
}
