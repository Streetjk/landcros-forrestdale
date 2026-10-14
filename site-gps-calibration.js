// SiteNav GPS ↔ 3D map conversion. Calibration is per-site and provisional:
// its fit residual is NOT a promise of phone GNSS accuracy.
const METRES_PER_DEG_LAT = 111320;

export function validGpsCalibration(c) {
  if (!c || c.version !== 1 || c.status !== 'provisional' || !c.origin ||
      !Number.isFinite(c.origin.latitude) || !Number.isFinite(c.origin.longitude) ||
      !c.sceneFromMetres) return false;
  const x = c.sceneFromMetres.x, z = c.sceneFromMetres.z;
  if (!Array.isArray(x) || !Array.isArray(z) || x.length !== 3 || z.length !== 3 ||
      ![...x, ...z].every(Number.isFinite)) return false;
  return Math.abs(x[0] * z[1] - x[1] * z[0]) > 1e-9;
}

export function gpsToScene(latitude, longitude, calibration) {
  if (!validGpsCalibration(calibration) ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const e = (longitude - calibration.origin.longitude) *
    METRES_PER_DEG_LAT * Math.cos(calibration.origin.latitude * Math.PI / 180);
  const n = (latitude - calibration.origin.latitude) * METRES_PER_DEG_LAT;
  const x = calibration.sceneFromMetres.x, z = calibration.sceneFromMetres.z;
  return {
    x: x[0] * e + x[1] * n + x[2],
    y: 0,
    z: z[0] * e + z[1] * n + z[2],
  };
}

export function sceneToGps(sceneX, sceneZ, calibration) {
  if (!validGpsCalibration(calibration) ||
      !Number.isFinite(sceneX) || !Number.isFinite(sceneZ)) return null;
  const x = calibration.sceneFromMetres.x, z = calibration.sceneFromMetres.z;
  const det = x[0] * z[1] - x[1] * z[0];
  const ax = sceneX - x[2], az = sceneZ - z[2];
  const east = (ax * z[1] - az * x[1]) / det;
  const north = (az * x[0] - ax * z[0]) / det;
  return [
    calibration.origin.latitude + north / METRES_PER_DEG_LAT,
    calibration.origin.longitude + east /
      (METRES_PER_DEG_LAT * Math.cos(calibration.origin.latitude * Math.PI / 180)),
  ];
}

export async function loadSiteGpsCalibration(fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') return null;
  try {
    const response = await fetchFn('./assets/gps-calibration.json');
    if (!response?.ok) return null;
    const value = await response.json();
    return validGpsCalibration(value) ? value : null;
  } catch {
    return null; // Other SiteNav sites may not have a GPS calibration.
  }
}
