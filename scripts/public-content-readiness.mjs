#!/usr/bin/env node

// Read-only readiness report for the public building-detail contract.
// This script never writes GeoJSON or manufactures production content. Pass a
// separate synthetic fixture with --input when previewing a card/test payload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PUBLIC_BUILDING_DETAIL_FIELDS,
  assessBuildingDetailReadiness,
} from '../location-details.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultInput = path.join(projectRoot, 'sites/landcros/data/buildings.geojson');

function isPosition(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(Number.isFinite);
}

function isLine(value, min = 2) {
  return Array.isArray(value) && value.length >= min && value.every(isPosition);
}

function isValidGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return false;
  switch (geometry.type) {
    case 'Point':
      return isPosition(geometry.coordinates);
    case 'MultiPoint':
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
        && geometry.coordinates.every(isPosition);
    case 'LineString':
      return isLine(geometry.coordinates);
    case 'MultiLineString':
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
        && geometry.coordinates.every(line => isLine(line));
    case 'Polygon':
      // Existing LANDCROS building fixtures use three-position polygon rings
      // because map placement is carried by pos3d. Validate the real repository
      // structure without accepting empty/malformed coordinate objects.
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
        && geometry.coordinates.every(ring => isLine(ring, 3));
    case 'MultiPolygon':
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
        && geometry.coordinates.every(polygon => Array.isArray(polygon) && polygon.length > 0
          && polygon.every(ring => isLine(ring, 3)));
    default:
      return false;
  }
}

export function buildPublicContentReadinessReport(collection, source = null) {
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('PUBLIC_CONTENT_INVALID_FEATURE_COLLECTION');
  }
  const features = collection.features;
  for (const feature of features) {
    const validFeature = feature
      && typeof feature === 'object'
      && !Array.isArray(feature)
      && feature.type === 'Feature'
      && feature.properties
      && typeof feature.properties === 'object'
      && !Array.isArray(feature.properties)
      && isValidGeometry(feature.geometry);
    if (!validFeature) throw new Error('PUBLIC_CONTENT_INVALID_FEATURE');
  }
  const buildings = features.map(assessBuildingDetailReadiness);
  const ready = buildings.filter(building => building.ready).length;
  return {
    source,
    contract: [...PUBLIC_BUILDING_DETAIL_FIELDS],
    featureCount: buildings.length,
    readyCount: ready,
    incompleteCount: buildings.length - ready,
    buildings,
  };
}

function parseArgs(argv) {
  const args = { input: defaultInput, json: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(argv[++i] || '');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log('Usage: node scripts/public-content-readiness.mjs [--input GeoJSON] [--json] [--check]');
  console.log('  --input  Read a production or test-only FeatureCollection; default is LANDCROS GeoJSON.');
  console.log('  --json   Print the exact machine-readable missing/invalid field report.');
  console.log('  --check  Exit 1 when any feature is incomplete.');
}

export function runReadiness(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const collection = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const report = buildPublicContentReadinessReport(collection, path.relative(projectRoot, args.input));
  if (args.json) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`${report.source}: ${report.readyCount}/${report.featureCount} building detail cards ready`);
    for (const building of report.buildings) {
      const label = building.name || building.id || '(unnamed feature)';
      const missing = building.missingFields.length ? `missing=${building.missingFields.join(',')}` : 'missing=none';
      const invalid = building.invalidFields.length ? ` invalid=${building.invalidFields.join(',')}` : '';
      io.log(`- ${label}: ${missing}${invalid}`);
    }
  }
  return args.check && (report.featureCount === 0 || report.incompleteCount > 0) ? 1 : 0;
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  try {
    process.exitCode = runReadiness();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
