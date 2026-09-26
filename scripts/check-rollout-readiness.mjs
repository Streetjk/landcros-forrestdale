// Offline rollout gate. Reads a caller-supplied JSON snapshot and performs no network or writes.
import fs from 'node:fs';
import diagnostics from './deployment-diagnostics.cjs';

const { evaluateRolloutReadiness } = diagnostics;
const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: node scripts/check-rollout-readiness.mjs <snapshot.json>');

const raw = fs.readFileSync(inputPath, 'utf8');
const snapshot = JSON.parse(raw);
const result = evaluateRolloutReadiness(snapshot);

console.log(JSON.stringify({
  targetSha: result.normalized.targetSha,
  nodeSha: result.normalized.nodeSha,
  staticSha: result.normalized.staticSha,
  databaseProjectId: result.normalized.databaseProjectId,
  published: snapshot.published === true,
  readyForNodeDeploy: result.readyForNodeDeploy,
  codeQualified: result.codeQualified,
  migrationsReady: result.migrationsReady,
  blockers: result.blockers,
  warnings: result.warnings,
  requiredOrder: result.requiredOrder,
}, null, 2));

process.exitCode = result.readyForNodeDeploy ? 0 : 2;
