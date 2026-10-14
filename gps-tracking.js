// Pure client-side GPS helpers. The geolocation watch is controlled by
// viewer3d.js; this module never makes an HTTP request.
import { gpsToScene } from './site-gps-calibration.js';

export const GPS_MIN_UPDATE_MS = 3000;

// Geolocation watchPosition is push-based. We accept at most one map redraw
// every three seconds (except a substantially better initial accuracy).
export function shouldRenderGpsFix(now, previousAt, accuracy, previousAccuracy) {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(previousAt) || previousAt < 0) return true;
  if (now - previousAt >= GPS_MIN_UPDATE_MS) return true;
  return Number.isFinite(accuracy) && Number.isFinite(previousAccuracy) &&
    accuracy < previousAccuracy * 0.6;
}

export function gpsSceneAccuracyRadius(accuracyMetres, calibration) {
  const metresPerUnit = Number(calibration?.fit?.approxMetresPerSceneUnit) || 12.5;
  const metres = Number(accuracyMetres);
  const safe = Number.isFinite(metres) && metres > 0 ? metres : 30;
  return Math.min(6, Math.max(0.16, safe / metresPerUnit));
}

// Optional true heading cone. The scene model is rotated relative to true
// north, so convert N/E direction through the same calibration as positions.
export function gpsSceneHeading(latitude, longitude, heading, calibration) {
  if (!Number.isFinite(heading) || heading < 0 || heading > 360) return null;
  const center = gpsToScene(latitude, longitude, calibration);
  const north = gpsToScene(latitude + 0.00001, longitude, calibration);
  const east = gpsToScene(latitude, longitude + 0.00001, calibration);
  if (!center || !north || !east) return null;
  const radians = heading * Math.PI / 180;
  const x = Math.cos(radians) * (north.x - center.x) +
    Math.sin(radians) * (east.x - center.x);
  const z = Math.cos(radians) * (north.z - center.z) +
    Math.sin(radians) * (east.z - center.z);
  const length = Math.hypot(x, z);
  if (length < 1e-8) return null;
  return { x: x / length, z: z / length };
}

export function gpsWithinSite(position, calibration) {
  const points = calibration?.references;
  if (!position || !Array.isArray(points) || points.length < 3) return false;
  const slack = 4; // scene units: allow for real phone GPS uncertainty
  return position.x >= Math.min(...points.map(p => p.sceneX)) - slack &&
    position.x <= Math.max(...points.map(p => p.sceneX)) + slack &&
    position.z >= Math.min(...points.map(p => p.sceneZ)) - slack &&
    position.z <= Math.max(...points.map(p => p.sceneZ)) + slack;
}
