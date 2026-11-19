import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  Analysis, AnalyzeResponse, ProbeResult, ProgressEvent, ReferenceCandidate, RepairPlan, RepairResult, UndoResult,
} from '../shared/types';

const api = {
  env: (): Promise<{ untrunc: string; untruncFound: boolean; platform: string; version: string }> => ipcRenderer.invoke('env'),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  pickFile: (title: string): Promise<string | null> => ipcRenderer.invoke('pick-file', title),
  pickSave: (defaultPath: string): Promise<string | null> => ipcRenderer.invoke('pick-save', defaultPath),
  analyze: (p: string): Promise<AnalyzeResponse> => ipcRenderer.invoke('analyze', p),
  describeReference: (p: string, broken: Analysis): Promise<ReferenceCandidate | null> =>
    ipcRenderer.invoke('describe-reference', p, broken),
  freeSpace: (dir: string): Promise<number | null> => ipcRenderer.invoke('free-space', dir),
  detectOffset: (ref: string, broken: Analysis): Promise<{ best?: ProbeResult; tried: ProbeResult[] }> =>
    ipcRenderer.invoke('detect-offset', ref, broken),
  repair: (plan: RepairPlan): Promise<RepairResult> => ipcRenderer.invoke('repair', plan),
  cancel: (): Promise<void> => ipcRenderer.invoke('cancel'),
  undo: (backupPath: string): Promise<UndoResult> => ipcRenderer.invoke('undo', backupPath),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('reveal', p),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('open-path', p),
  onProgress: (cb: (e: ProgressEvent) => void) => {
    const h = (_: unknown, e: ProgressEvent) => cb(e);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.removeListener('progress', h);
  },
  onOpenFile: (cb: (p: string) => void) => {
    const h = (_: unknown, p: string) => cb(p);
    ipcRenderer.on('open-file', h);
    return () => ipcRenderer.removeListener('open-file', h);
  },
  onLog: (cb: (l: string) => void) => {
    const h = (_: unknown, l: string) => cb(l);
    ipcRenderer.on('log', h);
    return () => ipcRenderer.removeListener('log', h);
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld('api', api);
