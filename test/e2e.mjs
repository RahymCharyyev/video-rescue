// End-to-end test of the repair engine on synthetic broken files.
// Needs: ffmpeg/ffprobe in PATH, an untrunc binary (patched) in resources/bin/<os>-<arch>/ or $UNTRUNC_BIN.
// Run: npm test
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { analyze, repair, detectDataOffset, undoInPlace } = require(path.join(root, 'dist/engine/repair.js'));

const plat = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const bin = process.env.UNTRUNC_BIN ?? path.join(root, 'resources/bin', `${plat}-${process.arch}`, process.platform === 'win32' ? 'untrunc.exe' : 'untrunc');
if (!fs.existsSync(bin)) throw new Error(`untrunc not found at ${bin}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-e2e-'));
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const duration = (p) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).trim());
const decodes = (p) => {
  const err = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return err.trim() === '';
};
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};
const noop = () => {};

function makeClip(file, seconds) {
  sh('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', file]);
}

const ref = path.join(dir, 'CLIP0001.mp4');
const src = path.join(dir, 'source.mp4');
makeClip(ref, 20);
makeClip(src, 60);
const srcBuf = fs.readFileSync(src);

// --- Case A: truncated recording (moov never written) ---------------------
const truncated = path.join(dir, 'CLIP0002.mp4');
fs.writeFileSync(truncated, srcBuf.subarray(0, Math.floor(srcBuf.length * 0.7)));
const truncSha = sha(truncated);
{
  const { analysis, references } = await analyze(truncated);
  check('A: detected as no-moov', analysis.kind === 'no-moov', analysis.kind);
  check('A: reference auto-picked', references[0]?.path === ref, references[0]?.name);

  const out = path.join(dir, 'A_copy.mp4');
  const r = await repair(bin, { broken: truncated, reference: ref, mode: 'copy', output: out }, noop, noop);
  check('A copy: ok', r.ok, r.error);
  check('A copy: decodes cleanly', r.ok && decodes(out));
  const d = r.ok ? duration(out) : 0;
  check('A copy: duration ~40 s', d > 38 && d < 43, `${d}s`);
  check('A copy: original untouched', sha(truncated) === truncSha);

  const work = path.join(dir, 'A_inplace.mp4');
  fs.copyFileSync(truncated, work);
  const r2 = await repair(bin, { broken: work, reference: ref, mode: 'inplace' }, noop, noop);
  check('A in-place: ok', r2.ok, r2.error);
  check('A in-place: decodes cleanly', r2.ok && decodes(r2.outputPath));
  const d2 = r2.ok ? duration(r2.outputPath) : 0;
  check('A in-place: same duration as copy mode', Math.abs(d2 - d) < 0.1, `${d2}s vs ${d}s`);
  check('A in-place: grew by < 1 MB', fs.statSync(work).size - fs.statSync(truncated).size < 1024 * 1024);
  const restored = await undoInPlace(r2.backupPath);
  check('A undo: byte-identical to the broken file', sha(restored) === truncSha);
}

// --- Case B: garbage header (like Sony .RSV after power loss) ---------------
const rsv = path.join(dir, 'CLIP0003.RSV');
{
  const buf = Buffer.from(srcBuf.subarray(0, Math.floor(srcBuf.length * 0.8)));
  // find where mdat content starts in this ffmpeg layout and trash everything before it
  const mdatPos = buf.indexOf('mdat', 0, 'latin1');
  const dataStart = mdatPos + 4;
  buf.fill(0xaa, 0, dataStart);
  fs.writeFileSync(rsv, buf);
  const rsvSha = sha(rsv);

  const { analysis, references } = await analyze(rsv);
  check('B: detected as garbage-header', analysis.kind === 'garbage-header', analysis.kind);
  const det = await detectDataOffset(bin, references[0].path, analysis);
  check('B: data offset detected', det.best?.offset === dataStart, `${det.best?.offset} (expected ${dataStart})`);

  const out = path.join(dir, 'B_copy.mp4');
  const r = await repair(bin, { broken: rsv, reference: ref, mode: 'copy', output: out }, noop, noop);
  check('B copy: ok', r.ok, r.error);
  check('B copy: decodes cleanly', r.ok && decodes(out));
  const d = r.ok ? duration(out) : 0;
  check('B copy: duration ~48 s', d > 46 && d < 50, `${d}s`);

  const work = path.join(dir, 'CLIP0004.RSV');
  fs.copyFileSync(rsv, work);
  const progress = [];
  const r2 = await repair(bin, { broken: work, reference: ref, mode: 'inplace', renameToMp4: true }, (e) => progress.push(e), noop);
  check('B in-place: ok', r2.ok, r2.error);
  check('B in-place: renamed to .MP4', r2.outputPath?.endsWith('CLIP0004.MP4'), r2.outputPath);
  check('B in-place: decodes cleanly', r2.ok && decodes(r2.outputPath));
  const d2 = r2.ok ? duration(r2.outputPath) : 0;
  check('B in-place: same duration as copy mode', Math.abs(d2 - d) < 0.1, `${d2}s vs ${d}s`);
  check('B: progress events emitted', progress.some((p) => p.phase === 'scan') && progress.at(-1)?.phase === 'done');
  const restored = await undoInPlace(r2.backupPath);
  check('B undo: name and bytes restored', restored === work && sha(work) === rsvSha);
}

// --- Case C: nothing recoverable -------------------------------------------
{
  const zeros = path.join(dir, 'CLIP0005.MP4');
  fs.writeFileSync(zeros, Buffer.alloc(4 * 1024 * 1024));
  const { analysis } = await analyze(zeros);
  check('C: all-zero file reported as empty', analysis.kind === 'empty', analysis.kind);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
