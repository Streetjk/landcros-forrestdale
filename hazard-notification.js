'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function selectNotificationAttachments(photos, { maxTotalBytes, currentBytes = 0 } = {}) {
  const selected = [];
  const skipped = [];
  let totalBytes = currentBytes;
  for (const photo of photos || []) {
    const bytes = Number(photo?.original_bytes ?? photo?.originalBytes ?? 0);
    if (totalBytes + bytes > maxTotalBytes) {
      skipped.push(photo);
      continue;
    }
    selected.push(photo);
    totalBytes += bytes;
  }
  return { selected, skipped, totalBytes };
}

function buildNotificationContent({
  scene, objects = [], photos = [], message, shareUrl, skippedCount = 0,
  retentionDays, allowedDomain,
}) {
  const lines = objects.map((object, index) => {
    const title = object.props?.title || `Hazard ${index + 1}`;
    const description = object.props?.description || '';
    const photoCount = photos.filter((photo) => photo.object_id === object.id).length;
    return { title, description, photoCount };
  });
  const isHazard = scene.kind === 'hazard';
  const subject = isHazard ? `Hazard report: ${scene.name}` : `Map shared with you: ${scene.name}`;
  const text = [
    isHazard
      ? `Hazard report "${scene.name}" (${objects.length} pin${objects.length === 1 ? '' : 's'}).`
      : `"${scene.name}" has been escalated to you.`,
    message ? `\n${message}\n` : '',
    ...lines.map((line) => `• ${line.title}${line.photoCount ? ` (${line.photoCount} photo${line.photoCount === 1 ? '' : 's'})` : ''}\n  ${line.description}`),
    '', `Open the map (sign-in required): ${shareUrl}`,
    skippedCount ? `\n${skippedCount} photo(s) exceeded the email size limit and are only viewable on the map.` : '',
    `\nPhotos are kept for ${retentionDays} days.`,
  ].join('\n');
  const html = `
    <div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:600px">
      <h2 style="margin:0 0 8px;font-size:18px">${isHazard ? 'Hazard report' : 'Map shared with you'}: ${escapeHtml(scene.name)}</h2>
      ${message ? `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>` : ''}
      <ol style="padding-left:20px">${lines.map((line) => `<li style="margin-bottom:8px"><strong>${escapeHtml(line.title)}</strong>${line.photoCount ? ` <span style="color:#666">(${line.photoCount} photo${line.photoCount === 1 ? '' : 's'})</span>` : ''}<br><span style="white-space:pre-wrap">${escapeHtml(line.description)}</span></li>`).join('')}</ol>
      <p><a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#B45309;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open on the map</a><br><span style="color:#666;font-size:13px">${isHazard ? `Sign-in with your @${allowedDomain} email is required.` : `Sign in with your @${allowedDomain} email to add it to your list and update its status.`}</span></p>
      ${skippedCount ? `<p style="color:#666;font-size:13px">${skippedCount} photo(s) exceeded the email size limit and are only viewable on the map.</p>` : ''}
      <p style="color:#666;font-size:13px">Original photos are attached. Photos are kept for ${retentionDays} days.</p>
    </div>`;
  return { subject, text, html, lines };
}

module.exports = { buildNotificationContent, selectNotificationAttachments };
