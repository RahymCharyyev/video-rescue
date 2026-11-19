import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Analysis, RepairPlan } from '../shared/types';
import { analyze, describeReference, detectDataOffset, freeSpace, repair, undoInPlace } from '../engine/repair';

const PLATFORM_DIR: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' };

function untruncPath(): string {
  const exe = process.platform === 'win32' ? 'untrunc.exe' : 'untrunc';
  const packaged = path.join(process.resourcesPath, 'bin', exe);
  if (app.isPackaged) return packaged;
  return path.join(__dirname, '..', '..', 'resources', 'bin', `${PLATFORM_DIR[process.platform]}-${process.arch}`, exe);
}

let win: BrowserWindow | null = null;
let job: AbortController | null = null;
let pendingOpen: string | null = null;

/** A video passed on the command line or via "Open with" (macOS open-file). */
function queueOpen(p: string | undefined) {
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('open-file', p);
  else pendingOpen = p;
}
const argFile = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && a !== '.');
if (argFile) queueOpen(path.resolve(argFile));
app.on('open-file', (e, p) => {
  e.preventDefault();
  queueOpen(p);
});
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const f = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a));
  if (f) queueOpen(path.resolve(f));
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    title: 'Video Rescue',
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      win?.webContents.send('open-file', pendingOpen);
      pendingOpen = null;
    }
    // Dev-only hook for automated screenshots: VR_SCREENSHOT=out.png [VR_SCREENSHOT_DELAY=ms]
    const shot = !app.isPackaged ? process.env.VR_SCREENSHOT : undefined;
    const script = !app.isPackaged ? process.env.VR_SCRIPT : undefined;
    if (script) setTimeout(() => win?.webContents.executeJavaScript(script), Number(process.env.VR_SCRIPT_DELAY ?? 2000));
    if (shot) {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.VR_SCREENSHOT_DELAY ?? 2500));
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  job?.abort();
  app.quit();
});

const VIDEO_FILTERS = [
  { name: 'Видео', extensions: ['mp4', 'mov', 'm4v', 'rsv', 'MP4', 'MOV', 'RSV', '3gp', 'lrv', 'insv'] },
  { name: 'Все файлы', extensions: ['*'] },
];

ipcMain.handle('env', () => {
  const bin = untruncPath();
  return { untrunc: bin, untruncFound: fs.existsSync(bin), platform: process.platform, version: app.getVersion() };
});

ipcMain.handle('pick-file', async (_e, title: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: VIDEO_FILTERS });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-save', async (_e, defaultPath: string) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath, filters: [{ name: 'MP4', extensions: ['mp4', 'mov'] }] });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('analyze', (_e, p: string) => analyze(p));
ipcMain.handle('describe-reference', (_e, p: string, broken: Analysis) => describeReference(p, broken));
ipcMain.handle('free-space', (_e, dir: string) => freeSpace(dir));

ipcMain.handle('detect-offset', async (_e, ref: string, broken: Analysis) => {
  job = new AbortController();
  try {
    return await detectDataOffset(untruncPath(), ref, broken, job.signal);
  } finally {
    job = null;
  }
});

ipcMain.handle('repair', async (e, plan: RepairPlan) => {
  if (job) throw new Error('Уже идёт восстановление');
  job = new AbortController();
  const send = (ch: string, payload: unknown) => {
    if (!e.sender.isDestroyed()) e.sender.send(ch, payload);
  };
  try {
    return await repair(untruncPath(), plan, (p) => send('progress', p), (l) => send('log', l), job.signal);
  } catch (err) {
    return { ok: false, mode: plan.mode, error: (err as Error).message, log: '' };
  } finally {
    job = null;
  }
});

ipcMain.handle('cancel', () => {
  job?.abort();
});

ipcMain.handle('undo', async (_e, backupPath: string) => {
  try {
    return { ok: true, restoredPath: await undoInPlace(backupPath) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p: string) => shell.openPath(p));
