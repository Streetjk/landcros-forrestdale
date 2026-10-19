// Small pure helper: only the scene creator (or a platform admin) may
// update a managed scene. Legacy ownerless scenes retain editor access.
function canManageScene(scene, session, isPlatformAdmin = false) {
  if (!scene || typeof scene !== 'object') return false;
  const profileId = typeof session === 'string' ? session : session?.profileId;
  if (!profileId) return false;
  if (isPlatformAdmin) return true;
  const createdBy = scene.createdBy !== undefined ? scene.createdBy : scene.created_by;
  return createdBy == null || createdBy === profileId;
}
module.exports = { canManageScene };
