// QR code generation via qrcodejs CDN.
// Caller must load: https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js

const QR_DEFAULTS = {
  width: 256,
  height: 256,
  colorDark: '#185FA5',
  colorLight: '#ffffff',
  correctLevel: QRCode.CorrectLevel.H,
};

/**
 * generateQR(url, containerId, options) → QRCode instance
 */
export function generateQR(url, containerId, options = {}) {
  const el = document.getElementById(containerId);
  if (!el) throw new Error(`QR container #${containerId} not found`);
  el.innerHTML = '';
  return new QRCode(el, { text: url, ...QR_DEFAULTS, ...options });
}

/**
 * downloadQR(url, filename) → triggers PNG download
 */
export function downloadQR(url, filename = 'sitenav-qr.png') {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(wrap);

  const qr = new QRCode(wrap, { text: url, ...QR_DEFAULTS });

  // qrcodejs renders async; poll for the canvas
  const MAX = 20;
  let attempts = 0;
  const poll = setInterval(() => {
    const canvas = wrap.querySelector('canvas');
    if (canvas || ++attempts > MAX) {
      clearInterval(poll);
      if (canvas) {
        canvas.toBlob(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          a.click();
          URL.revokeObjectURL(a.href);
          wrap.remove();
        }, 'image/png');
      } else {
        wrap.remove();
      }
    }
  }, 100);
}
