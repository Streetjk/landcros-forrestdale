// resource-ownership.js — server-side authorization helpers for resource ownership.
//
// Pure CommonJS helper without DB or auth-config imports: unit-testable in isolation.
// Platform-admin decisions are passed in as a boolean by callers (e.g. server.js).

/**
 * Answers whether a signed-in session may manage a scene.
 *
 * Rules:
 * - Returns true if caller is a platform admin (passed in as boolean or option).
 * - Returns true if scene is legacy ownerless (createdBy is null or undefined).
 * - Returns true if session.profileId matches scene.createdBy.
 * - Scene subscriptions are view/list only and do NOT grant manage/edit rights.
 * - Missing scene or unauthenticated / profile-less session returns false.
 *
 * @param {object} scene - Scene object or metadata ({ createdBy, ... } or { created_by, ... })
 * @param {object|string} session - Signed-in session ({ profileId, ... }) or profileId string
 * @param {boolean|object} [adminOrOptions=false] - boolean isPlatformAdmin or { isPlatformAdmin }
 * @returns {boolean}
 */
function canManageScene(scene, session, adminOrOptions = false) {
  if (!scene || typeof scene !== 'object') return false;

  const isPlatformAdmin = typeof adminOrOptions === 'boolean'
    ? adminOrOptions
    : Boolean(adminOrOptions && adminOrOptions.isPlatformAdmin);

  const profileId = typeof session === 'string' ? session : session?.profileId;

  // A signed-in session (or platform-admin override) is required.
  if (!profileId && !isPlatformAdmin) return false;

  if (isPlatformAdmin) return true;

  const createdBy = scene.createdBy !== undefined ? scene.createdBy : scene.created_by;

  // Legacy ownerless scenes (created_by is null or undefined) are manageable by signed-in editors.
  if (createdBy === null || createdBy === undefined) return true;

  // Owned scenes may only be managed by their creator.
  return profileId === createdBy;
}

module.exports = {
  canManageScene,
};
