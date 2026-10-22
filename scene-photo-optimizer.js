// Client-side optimisation keeps original device photos off the network.
// Full images remain detailed enough for pin inspections; the thumbnail is
// a separate, much smaller private Storage object.
export const PHOTO_MAX_SOURCE_BYTES = 15_000_000;
export const PHOTO_MAX_PIXELS = 45_000_000;
export const PHOTO_FULL_TARGET_BYTES = 900_000;
export const PHOTO_THUMB_TARGET_BYTES = 120_000;

function canvasFor(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare photo.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encode(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode photo.')),
      type, quality);
  });
}

async function encodeWithinLimit(bitmap, sides, qualities, limit, preferredType) {
  let type = preferredType;
  for (const side of sides) {
    const canvas = canvasFor(bitmap, side);
    for (const quality of qualities) {
      let blob = await encode(canvas, type, quality);
      // A few browsers silently fall back to PNG for unsupported WebP.
      // JPEG is the compatibility format; never upload an unexpected type.
      if (blob.type !== type && type === 'image/webp') {
        type = 'image/jpeg';
        blob = await encode(canvas, type, quality);
      }
      if (blob.type !== type) throw new Error('This browser cannot encode the photo.');
      if (blob.size <= limit) return blob;
    }
  }
  throw new Error('Photo is still too large after resizing.');
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read optimised photo.'));
    reader.readAsDataURL(blob);
  });
}

export async function optimiseScenePhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      || file.size > PHOTO_MAX_SOURCE_BYTES) {
    throw new Error('Choose a JPEG, PNG or WebP image up to 15 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height ||
        bitmap.width * bitmap.height > PHOTO_MAX_PIXELS) {
      throw new Error('Image dimensions are too large.');
    }
    const full = await encodeWithinLimit(bitmap, [1920, 1600, 1440, 1200, 960, 768],
      [0.85, 0.80, 0.75], PHOTO_FULL_TARGET_BYTES, 'image/webp');
    // Use the same MIME type/extension for both variants. Unsupported WebP
    // browsers fall back to JPEG while keeping the same private gallery API.
    const thumb = await encodeWithinLimit(bitmap, [400, 320, 240],
      [0.80, 0.72], PHOTO_THUMB_TARGET_BYTES, full.type);
    return {
      dataUrl: await blobAsDataUrl(full),
      thumbnailDataUrl: await blobAsDataUrl(thumb),
      fullBytes: full.size,
      thumbnailBytes: thumb.size,
    };
  } finally {
    bitmap.close?.();
  }
}
