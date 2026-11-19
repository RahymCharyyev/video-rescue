import type {
  Analysis, AnalyzeResponse, ProbeResult, ProgressEvent, ReferenceCandidate, RepairPlan, RepairResult, UndoResult,
} from '../shared/types';

// Mirrors src/preload/preload.ts
interface Api {
  env(): Promise<{ untrunc: string; untruncFound: boolean; platform: string; version: string }>;
  pathForFile(f: File): string;
  pickFile(title: string): Promise<string | null>;
  pickSave(defaultPath: string): Promise<string | null>;
  analyze(p: string): Promise<AnalyzeResponse>;
  describeReference(p: string, broken: Analysis): Promise<ReferenceCandidate | null>;
  freeSpace(dir: string): Promise<number | null>;
  detectOffset(ref: string, broken: Analysis): Promise<{ best?: ProbeResult; tried: ProbeResult[] }>;
  repair(plan: RepairPlan): Promise<RepairResult>;
  cancel(): Promise<void>;
  undo(backupPath: string): Promise<UndoResult>;
  reveal(p: string): Promise<void>;
  openPath(p: string): Promise<string>;
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onLog(cb: (l: string) => void): () => void;
  onOpenFile(cb: (p: string) => void): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
