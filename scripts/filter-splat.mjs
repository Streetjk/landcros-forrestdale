import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RECORD_SIZE = 32;
const ALPHA_OFFSET = 27;

function validateInputBuffer(input) {
  if (!input || !(input instanceof Uint8Array || Buffer.isBuffer(input))) {
    throw new Error('Input must be a Buffer or Uint8Array.');
  }
  if (input.length === 0) {
    throw new Error('Input length must be nonzero.');
  }
  if (input.length % RECORD_SIZE !== 0) {
    throw new Error(`Input byte length (${input.length}) must be divisible by ${RECORD_SIZE}.`);
  }
}

function validateMinAlpha(minAlpha) {
  if (typeof minAlpha !== 'number' || !Number.isInteger(minAlpha) || minAlpha < 0 || minAlpha > 255) {
    throw new Error('minAlpha must be an integer between 0 and 255.');
  }
}

export function filterSplatBuffer(input, minAlpha) {
  validateInputBuffer(input);
  validateMinAlpha(minAlpha);

  const inputRecords = input.length / RECORD_SIZE;
  let survivingCount = 0;
  for (let i = 0; i < inputRecords; i++) {
    if (input[i * RECORD_SIZE + ALPHA_OFFSET] >= minAlpha) {
      survivingCount++;
    }
  }

  const outputBytes = survivingCount * RECORD_SIZE;
  const output = Buffer.alloc(outputBytes);
  let destOffset = 0;

  for (let i = 0; i < inputRecords; i++) {
    const srcOffset = i * RECORD_SIZE;
    if (input[srcOffset + ALPHA_OFFSET] >= minAlpha) {
      output.set(input.subarray(srcOffset, srcOffset + RECORD_SIZE), destOffset);
      destOffset += RECORD_SIZE;
    }
  }

  const removedRecords = inputRecords - survivingCount;
  return {
    buffer: output,
    inputRecords,
    outputRecords: survivingCount,
    inputBytes: input.length,
    outputBytes,
    removedRecords,
    minAlpha
  };
}

export function alphaHistogram(input) {
  validateInputBuffer(input);
  const counts = new Uint32Array(256);
  const totalRecords = input.length / RECORD_SIZE;
  for (let i = 0; i < totalRecords; i++) {
    counts[input[i * RECORD_SIZE + ALPHA_OFFSET]]++;
  }
  return counts;
}

function computeSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseCliArgs(args) {
  const positional = [];
  let minAlpha = null;
  let metadataPath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--min-alpha') {
      i++;
      if (i >= args.length) throw new Error('Missing value for --min-alpha');
      const val = Number(args[i]);
      if (!Number.isInteger(val) || val < 0 || val > 255) {
        throw new Error('Invalid --min-alpha value (must be integer 0..255)');
      }
      minAlpha = val;
    } else if (arg === '--metadata') {
      i++;
      if (i >= args.length) throw new Error('Missing value for --metadata');
      metadataPath = args[i];
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    throw new Error('Usage: node scripts/filter-splat.mjs <input.splat> <output.splat> --min-alpha <0..255> [--metadata <output.json>]');
  }
  if (minAlpha === null) {
    throw new Error('Missing required argument: --min-alpha');
  }

  return {
    inputPath: positional[0],
    outputPath: positional[1],
    minAlpha,
    metadataPath
  };
}

function rejectExistingDirectory(targetPath, label) {
  try {
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) throw new Error(`${label} path must not be a directory.`);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

function fileIdentity(filePath) {
  try {
    const st = fs.statSync(filePath); // follows symlinks; catches hardlink aliases via dev+ino
    return `${st.dev}:${st.ino}`;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function pathsAlias(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  const ia = fileIdentity(ra);
  const ib = fileIdentity(rb);
  return ia !== null && ib !== null && ia === ib;
}

function tempSibling(targetPath, kind) {
  const dir = path.dirname(targetPath);
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(dir, `.${path.basename(targetPath)}.${kind}.${process.pid}.${suffix}`);
}

// Best-effort multi-file transaction for local tooling: all temp files are
// fully written before any target is replaced. Existing targets are moved to
// sibling backups and restored if a later rename fails. No filesystem can
// make two independent path renames literally atomic as one operation, but
// this prevents ordinary write/rename failures from leaving a partial pair.
function writeAtomicFiles(entries) {
  const prepared = [];
  const committed = [];
  try {
    for (const { targetPath, buffer } of entries) {
      const resolved = path.resolve(targetPath);
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = tempSibling(resolved, 'tmp');
      fs.writeFileSync(tempPath, buffer);
      prepared.push({ targetPath: resolved, tempPath, backupPath: null, hadTarget: fs.existsSync(resolved) });
    }

    for (const item of prepared) {
      if (item.hadTarget) {
        item.backupPath = tempSibling(item.targetPath, 'bak');
        fs.renameSync(item.targetPath, item.backupPath);
      }
      try {
        fs.renameSync(item.tempPath, item.targetPath);
        committed.push(item);
      } catch (err) {
        if (item.backupPath && fs.existsSync(item.backupPath)) {
          fs.renameSync(item.backupPath, item.targetPath);
          item.backupPath = null;
        }
        throw err;
      }
    }

    for (const item of prepared) {
      if (item.backupPath && fs.existsSync(item.backupPath)) fs.unlinkSync(item.backupPath);
      item.backupPath = null;
    }
  } catch (err) {
    for (const item of committed.reverse()) {
      try { if (fs.existsSync(item.targetPath)) fs.unlinkSync(item.targetPath); } catch {}
      try {
        if (item.backupPath && fs.existsSync(item.backupPath)) {
          fs.renameSync(item.backupPath, item.targetPath);
          item.backupPath = null;
        }
      } catch {}
    }
    for (const item of prepared) {
      try { if (fs.existsSync(item.tempPath)) fs.unlinkSync(item.tempPath); } catch {}
      try {
        if (item.backupPath && fs.existsSync(item.backupPath) && !fs.existsSync(item.targetPath)) {
          fs.renameSync(item.backupPath, item.targetPath);
          item.backupPath = null;
        }
      } catch {}
      try { if (item.backupPath && fs.existsSync(item.backupPath)) fs.unlinkSync(item.backupPath); } catch {}
    }
    throw err;
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const { inputPath, outputPath, minAlpha, metadataPath } = parseCliArgs(argv);

  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  const resolvedMeta = metadataPath ? path.resolve(metadataPath) : null;

  if (!fs.existsSync(resolvedInput)) throw new Error(`Input file does not exist: ${inputPath}`);
  rejectExistingDirectory(resolvedOutput, 'Output');
  if (resolvedMeta) rejectExistingDirectory(resolvedMeta, 'Metadata');
  if (pathsAlias(resolvedInput, resolvedOutput)) {
    throw new Error('Input and output paths refer to the same file.');
  }
  if (resolvedMeta) {
    if (pathsAlias(resolvedInput, resolvedMeta)) throw new Error('Metadata path must not refer to the input file.');
    if (pathsAlias(resolvedOutput, resolvedMeta)) throw new Error('Metadata path must not refer to the output file.');
  }

  const inputBuffer = fs.readFileSync(resolvedInput);
  const result = filterSplatBuffer(inputBuffer, minAlpha);
  const writes = [{ targetPath: resolvedOutput, buffer: result.buffer }];

  if (resolvedMeta) {
    const sourceSha256 = computeSha256(inputBuffer);
    const outputSha256 = computeSha256(result.buffer);
    const removedPercent = Number(((result.removedRecords / result.inputRecords) * 100).toFixed(2));
    const metadata = {
      formatVersion: 1,
      sourceFile: path.basename(resolvedInput),
      sourceSha256,
      outputSha256,
      minAlpha,
      inputRecords: result.inputRecords,
      outputRecords: result.outputRecords,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      removedRecords: result.removedRecords,
      removedPercent
    };
    writes.push({ targetPath: resolvedMeta, buffer: Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8') });
  }

  writeAtomicFiles(writes);
}

let isDirectExecution = false;
if (process.argv[1]) {
  try {
    isDirectExecution = fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    isDirectExecution = fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}
if (isDirectExecution) {
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}
