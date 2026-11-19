export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 1 : 2)} ГБ`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${n} Б`;
}

export function duration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return p.slice(i + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

export function sep(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function defaultCopyOutput(broken: string): string {
  const ext = extname(broken);
  const base = broken.slice(0, broken.length - ext.length);
  return `${base}_fixed${/^\.mov$/i.test(ext) ? ext : '.mp4'}`;
}
