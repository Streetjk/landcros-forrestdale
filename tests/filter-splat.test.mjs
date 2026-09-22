import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { filterSplatBuffer, alphaHistogram, runCli } from '../scripts/filter-splat.mjs';

function makeRecord(id, alpha) {
  const record = Buffer.alloc(32);
  record.fill(id & 0xff);
  record[27] = alpha & 0xff;
  return record;
}

function createSyntheticBuffer(records) {
  return Buffer.concat(records.map((r, i) => makeRecord(i + 1, r.alpha)));
}

test('filterSplatBuffer validation', () => {
  assert.throws(() => filterSplatBuffer(null, 10), /Input must be a Buffer or Uint8Array/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(0), 10), /Input length must be nonzero/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(31), 10), /must be divisible by 32/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(33), 10), /must be divisible by 32/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(32), -1), /minAlpha must be an integer between 0 and 255/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(32), 256), /minAlpha must be an integer between 0 and 255/);
  assert.throws(() => filterSplatBuffer(Buffer.alloc(32), 12.5), /minAlpha must be an integer between 0 and 255/);
});

test('alphaHistogram validation and accuracy', () => {
  assert.throws(() => alphaHistogram(Buffer.alloc(0)), /Input length must be nonzero/);
  assert.throws(() => alphaHistogram(Buffer.alloc(33)), /must be divisible by 32/);

  const input = createSyntheticBuffer([
    { alpha: 0 },
    { alpha: 128 },
    { alpha: 128 },
    { alpha: 255 }
  ]);
  const hist = alphaHistogram(input);
  assert.equal(hist.length, 256);
  assert.equal(hist[0], 1);
  assert.equal(hist[128], 2);
  assert.equal(hist[255], 1);
  assert.equal(hist[64], 0);
});

test('filterSplatBuffer preserves exact order and survivor bytes', () => {
  const r1 = makeRecord(0x11, 30);
  const r2 = makeRecord(0x22, 64);
  const r3 = makeRecord(0x33, 100);
  const r4 = makeRecord(0x44, 63);
  const r5 = makeRecord(0x55, 255);
  const input = Buffer.concat([r1, r2, r3, r4, r5]);

  const res = filterSplatBuffer(input, 64);
  assert.equal(res.inputRecords, 5);
  assert.equal(res.outputRecords, 3);
  assert.equal(res.inputBytes, 160);
  assert.equal(res.outputBytes, 96);
  assert.equal(res.removedRecords, 2);
  assert.equal(res.minAlpha, 64);

  const expected = Buffer.concat([r2, r3, r5]);
  assert.deepEqual(res.buffer, expected);
});

test('filterSplatBuffer no survivor case returns empty buffer', () => {
  const input = Buffer.concat([
    makeRecord(1, 10),
    makeRecord(2, 20)
  ]);
  const res = filterSplatBuffer(input, 50);
  assert.equal(res.inputRecords, 2);
  assert.equal(res.outputRecords, 0);
  assert.equal(res.outputBytes, 0);
  assert.equal(res.removedRecords, 2);
  assert.equal(res.buffer.length, 0);
});

test('CLI workflow: deterministic run, metadata, directory creation, atomic write', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-test-'));
  try {
    const inputPath = path.join(tmpDir, 'source.splat');
    const outDir = path.join(tmpDir, 'nested', 'deep');
    const outputPath = path.join(outDir, 'filtered.splat');
    const metaPath = path.join(outDir, 'meta', 'metadata.json');

    const r1 = makeRecord(0xaa, 10);
    const r2 = makeRecord(0xbb, 100);
    const r3 = makeRecord(0xcc, 200);
    const inputBuffer = Buffer.concat([r1, r2, r3]);
    fs.writeFileSync(inputPath, inputBuffer);

    const args = [inputPath, outputPath, '--min-alpha', '100', '--metadata', metaPath];
    runCli(args);

    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.existsSync(metaPath));

    const outBuf1 = fs.readFileSync(outputPath);
    const metaContent1 = fs.readFileSync(metaPath, 'utf8');
    const meta1 = JSON.parse(metaContent1);

    assert.equal(meta1.formatVersion, 1);
    assert.equal(meta1.sourceFile, 'source.splat');
    assert.equal(meta1.minAlpha, 100);
    assert.equal(meta1.inputRecords, 3);
    assert.equal(meta1.outputRecords, 2);
    assert.equal(meta1.removedRecords, 1);
    assert.equal(meta1.removedPercent, 33.33);
    assert.equal(outBuf1.length, 64);
    assert.deepEqual(outBuf1, Buffer.concat([r2, r3]));

    // Verify source is unchanged
    const sourceAfter = fs.readFileSync(inputPath);
    assert.deepEqual(sourceAfter, inputBuffer);

    // Repeated run verification for determinism
    runCli(args);
    const outBuf2 = fs.readFileSync(outputPath);
    const metaContent2 = fs.readFileSync(metaPath, 'utf8');
    assert.deepEqual(outBuf1, outBuf2);
    assert.equal(metaContent1, metaContent2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI rejects same input and output path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-err-'));
  try {
    const target = path.join(tmpDir, 'test.splat');
    fs.writeFileSync(target, Buffer.alloc(32));
    assert.throws(() => {
      runCli([target, path.join(tmpDir, '.', 'test.splat'), '--min-alpha', '10']);
    }, /Input and output paths refer to the same file/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI rejects unknown or invalid args', () => {
  assert.throws(() => runCli(['in.splat', 'out.splat']), /Missing required argument: --min-alpha/);
  assert.throws(() => runCli(['in.splat', 'out.splat', '--min-alpha', '50', '--bogus']), /Unknown option: --bogus/);
  assert.throws(() => runCli(['in.splat', 'out.splat', '--min-alpha', '300']), /Invalid --min-alpha value/);
});

test('CLI handles zero surviving records cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-zero-'));
  try {
    const inputPath = path.join(tmpDir, 'input.splat');
    const outputPath = path.join(tmpDir, 'zero_out.splat');
    const metaPath = path.join(tmpDir, 'zero_meta.json');
    fs.writeFileSync(inputPath, makeRecord(1, 15));

    runCli([inputPath, outputPath, '--min-alpha', '20', '--metadata', metaPath]);

    assert.ok(fs.existsSync(outputPath));
    const outBuf = fs.readFileSync(outputPath);
    assert.equal(outBuf.length, 0);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.inputRecords, 1);
    assert.equal(meta.outputRecords, 0);
    assert.equal(meta.removedRecords, 1);
    assert.equal(meta.removedPercent, 100);
    assert.equal(meta.outputBytes, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('plain Uint8Array input and alpha boundary thresholds are supported', () => {
  const raw = Buffer.concat([makeRecord(1, 0), makeRecord(2, 254), makeRecord(3, 255)]);
  const input = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const all = filterSplatBuffer(input, 0);
  assert.equal(all.outputRecords, 3);
  assert.deepEqual(all.buffer, raw);
  const only255 = filterSplatBuffer(input, 255);
  assert.equal(only255.outputRecords, 1);
  assert.deepEqual(only255.buffer, raw.subarray(64, 96));
});

test('CLI rejects metadata path collisions with input or output', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-meta-collision-'));
  try {
    const input = path.join(tmpDir, 'input.splat');
    const output = path.join(tmpDir, 'output.splat');
    fs.writeFileSync(input, makeRecord(1, 100));
    assert.throws(() => runCli([input, output, '--min-alpha', '10', '--metadata', input]), /Metadata path must not refer to the input file/);
    assert.throws(() => runCli([input, output, '--min-alpha', '10', '--metadata', output]), /Metadata path must not refer to the output file/);
    assert.deepEqual(fs.readFileSync(input), makeRecord(1, 100));
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('CLI rejects existing symlink and hardlink aliases to the input', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-alias-'));
  try {
    const input = path.join(tmpDir, 'input.splat');
    const symlinkOut = path.join(tmpDir, 'symlink.splat');
    const hardlinkOut = path.join(tmpDir, 'hardlink.splat');
    const metaAlias = path.join(tmpDir, 'meta-alias.json');
    const source = makeRecord(7, 200);
    fs.writeFileSync(input, source);
    fs.symlinkSync(input, symlinkOut);
    fs.linkSync(input, hardlinkOut);
    fs.linkSync(input, metaAlias);
    assert.throws(() => runCli([input, symlinkOut, '--min-alpha', '10']), /Input and output paths refer to the same file/);
    assert.throws(() => runCli([input, hardlinkOut, '--min-alpha', '10']), /Input and output paths refer to the same file/);
    assert.throws(() => runCli([input, path.join(tmpDir, 'safe.splat'), '--min-alpha', '10', '--metadata', metaAlias]), /Metadata path must not refer to the input file/);
    assert.deepEqual(fs.readFileSync(input), source);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('preparation failure preserves existing output and leaves no temp or backup files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-prepare-fail-'));
  try {
    const input = path.join(tmpDir, 'input.splat');
    const output = path.join(tmpDir, 'output.splat');
    const blockingParent = path.join(tmpDir, 'not-a-directory');
    const metadata = path.join(blockingParent, 'metadata.json');
    const originalOutput = Buffer.from('existing-output');
    fs.writeFileSync(input, Buffer.concat([makeRecord(1, 10), makeRecord(2, 200)]));
    fs.writeFileSync(output, originalOutput);
    fs.writeFileSync(blockingParent, 'block');
    assert.throws(() => runCli([input, output, '--min-alpha', '100', '--metadata', metadata]));
    assert.deepEqual(fs.readFileSync(output), originalOutput);
    const residue = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp.') || name.includes('.bak.'));
    assert.deepEqual(residue, []);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('CLI direct execution works when script itself is invoked through a symlink', { skip: process.platform === 'win32' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-script-link-'));
  try {
    const realScript = path.resolve('scripts/filter-splat.mjs');
    const linkedScript = path.join(tmpDir, 'filter-splat-link.mjs');
    const input = path.join(tmpDir, 'input.splat');
    const output = path.join(tmpDir, 'output.splat');
    fs.symlinkSync(realScript, linkedScript);
    fs.writeFileSync(input, Buffer.concat([makeRecord(1, 1), makeRecord(2, 200)]));
    const child = spawnSync(process.execPath, [linkedScript, input, output, '--min-alpha', '100'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(fs.readFileSync(output), makeRecord(2, 200));
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});


test('CLI rejects existing directory targets before mutating anything', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-cli-dir-target-'));
  try {
    const input = path.join(tmpDir, 'input.splat');
    const outputDir = path.join(tmpDir, 'output-dir');
    const metadataDir = path.join(tmpDir, 'metadata-dir');
    const safeOutput = path.join(tmpDir, 'safe-output.splat');
    const source = Buffer.concat([makeRecord(1, 10), makeRecord(2, 200)]);
    fs.writeFileSync(input, source);
    fs.mkdirSync(outputDir);
    fs.mkdirSync(metadataDir);
    assert.throws(() => runCli([input, outputDir, '--min-alpha', '100']), /Output path must not be a directory/);
    assert.throws(() => runCli([input, safeOutput, '--min-alpha', '100', '--metadata', metadataDir]), /Metadata path must not be a directory/);
    assert.deepEqual(fs.readFileSync(input), source);
    assert.equal(fs.statSync(outputDir).isDirectory(), true);
    assert.equal(fs.statSync(metadataDir).isDirectory(), true);
    assert.equal(fs.existsSync(safeOutput), false);
    const residue = fs.readdirSync(tmpDir).filter(name => name.includes('.tmp.') || name.includes('.bak.'));
    assert.deepEqual(residue, []);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});
