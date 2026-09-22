import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function importHelper(relPath) {
  const filePath = path.resolve(projectRoot, relPath);
  const code = fs.readFileSync(filePath, 'utf-8');
  const base64 = Buffer.from(code).toString('base64');
  return import(`data:text/javascript;base64,${base64}`);
}

const { buildPinUrl, clearPinUrl, buildMyPinShareUrl, buildMyPinPhotoUrl } = await importHelper('./guide-url.js');
const {
  sanitizePhone,
  sanitizeImageUrl,
  validateBuildingDetails,
} = await importHelper('./location-details.js');

test('guide-url: buildPinUrl preserves pathname, query scene/s/d, and hash while setting id', () => {
  const current = 'https://example.com/site/?scene=alpha&s=code1&d=eyJmb28iOiJiYXIifQ==#cam-top';
  const out = buildPinUrl(current, 'pin-101');
  const parsed = new URL(out);
  assert.equal(parsed.pathname, '/site/');
  assert.equal(parsed.searchParams.get('scene'), 'alpha');
  assert.equal(parsed.searchParams.get('s'), 'code1');
  assert.equal(parsed.searchParams.get('d'), 'eyJmb28iOiJiYXIifQ==');
  assert.equal(parsed.searchParams.get('id'), 'pin-101');
  assert.equal(parsed.hash, '#cam-top');
});

test('guide-url: buildPinUrl safely percent-encodes pin IDs with special characters', () => {
  const current = 'https://example.com/viewer3d.html?scene=east#map';
  const out = buildPinUrl(current, 'Gate 1 / Loading Zone #2 & 3');
  const parsed = new URL(out);
  assert.equal(parsed.searchParams.get('id'), 'Gate 1 / Loading Zone #2 & 3');
  assert.equal(parsed.searchParams.get('scene'), 'east');
  assert.equal(parsed.hash, '#map');
});

test('guide-url: buildPinUrl works with relative paths and replaces existing id', () => {
  const current = '/index.html?scene=west&id=old-pin#spot';
  const out = buildPinUrl(current, 'new-pin');
  assert.equal(out, '/index.html?scene=west&id=new-pin#spot');
});

test('guide-url: clearPinUrl removes only id and preserves scene/s/d/hash', () => {
  const current = 'https://example.com/viewer3d.html?scene=beta&s=abc&d=xyz&id=pin-42#nav';
  const out = clearPinUrl(current);
  assert.equal(out, 'https://example.com/viewer3d.html?scene=beta&s=abc&d=xyz#nav');
});

test('guide-url: clearPinUrl removes query string cleanly when id was only param', () => {
  const current = 'https://example.com/map?id=only-one#overview';
  const out = clearPinUrl(current);
  assert.equal(out, 'https://example.com/map#overview');
});

test('guide-url: account My Pin links keep bearer in fragment and media URLs are token-free', () => {
  const token = 'A'.repeat(43);
  const point = '00000000-0000-4000-8000-000000000003';
  const out = new URL(buildMyPinShareUrl('https://example.com', token, point));
  assert.equal(out.origin, 'https://example.com');
  assert.equal(out.pathname, '/viewer3d.html');
  assert.equal(out.searchParams.get('id'), point);
  assert.equal(out.searchParams.has('myPin'), false);
  assert.equal(out.searchParams.has('scene'), false);
  assert.equal(out.searchParams.has('s'), false);
  assert.equal(out.searchParams.has('d'), false);
  assert.equal(out.hash, `#myPin=${token}`);

  const photo = buildMyPinPhotoUrl('point/id', 'photo id');
  assert.equal(photo, '/api/my-pins/points/point%2Fid/photos/photo%20id');
  assert.equal(photo.includes(token), false);
  assert.equal(photo.includes('original'), false);
});

test('guide-url: account My Pin links reject malformed token or point id', () => {
  const point = '00000000-0000-4000-8000-000000000003';
  assert.throws(() => buildMyPinShareUrl('https://example.com', 'short', point));
  assert.throws(() => buildMyPinShareUrl('https://example.com', 'A'.repeat(43), 'not-a-uuid'));
});

test('location-details: sanitizePhone accepts valid phone numbers and formats tel URI', () => {
  const au = sanitizePhone('+61 8 9123 4567');
  assert.deepEqual(au, {
    display: '+61 8 9123 4567',
    href: 'tel:+61891234567',
  });

  const local = sanitizePhone('(08) 9345-6789');
  assert.deepEqual(local, {
    display: '(08) 9345-6789',
    href: 'tel:0893456789',
  });
});

test('location-details: sanitizePhone rejects malicious injections, letters, and control chars', () => {
  assert.equal(sanitizePhone('javascript:alert(1)'), null);
  assert.equal(sanitizePhone('12345<script>'), null);
  assert.equal(sanitizePhone('+61 8 9123\n4567'), null);
  assert.equal(sanitizePhone('+61 8 9123\0 4567'), null);
  assert.equal(sanitizePhone('phone 12345'), null);
  assert.equal(sanitizePhone('12'), null);
  assert.equal(sanitizePhone(''), null);
  assert.equal(sanitizePhone(null), null);
});

test('location-details: sanitizeImageUrl allows valid HTTPS and same-origin relative raster URLs', () => {
  assert.equal(
    sanitizeImageUrl('https://cdn.example.com/photos/bld-1.webp'),
    'https://cdn.example.com/photos/bld-1.webp'
  );
  assert.equal(
    sanitizeImageUrl('https://cdn.example.com/photos/bld-1.jpg?width=600'),
    'https://cdn.example.com/photos/bld-1.jpg?width=600'
  );
  assert.equal(sanitizeImageUrl('./assets/buildings/hq.png'), './assets/buildings/hq.png');
  assert.equal(sanitizeImageUrl('/photos/bld-a.jpeg'), '/photos/bld-a.jpeg');
});

test('location-details: sanitizeImageUrl rejects dangerous schemes, protocol-relative, and non-raster files', () => {
  assert.equal(sanitizeImageUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), null);
  assert.equal(sanitizeImageUrl('blob:https://example.com/uuid'), null);
  assert.equal(sanitizeImageUrl('//evil.com/fake.jpg'), null);
  assert.equal(sanitizeImageUrl('http://insecure.example.com/pic.jpg'), null);
  assert.equal(sanitizeImageUrl('https://cdn.example.com/doc.pdf'), null);
  assert.equal(sanitizeImageUrl('https://cdn.example.com/vector.svg'), null);
  assert.equal(sanitizeImageUrl('https://cdn.example.com/run.html'), null);
  assert.equal(sanitizeImageUrl('https://cdn.example.com/pic.jpg\r\n'), null);
  assert.equal(sanitizeImageUrl(''), null);
  assert.equal(sanitizeImageUrl(null), null);
});

test('location-details: validateBuildingDetails handles missing, complete, and sanitized metadata', () => {
  const empty = validateBuildingDetails(null);
  assert.deepEqual(empty, {
    description: null,
    visitorInfo: null,
    phone: null,
    image: null,
    imageAlt: null,
  });

  const valid = validateBuildingDetails({
    description: 'Main workshop and parts store.',
    visitorInfo: 'Sign in at reception before entering the workshop.',
    phone: '+61 8 9456 1234',
    image: 'https://cdn.example.com/buildings/workshop.webp',
    imageAlt: 'Workshop building front',
  });
  assert.equal(valid.description, 'Main workshop and parts store.');
  assert.equal(valid.visitorInfo, 'Sign in at reception before entering the workshop.');
  assert.equal(valid.phone.href, 'tel:+61894561234');
  assert.equal(valid.image, 'https://cdn.example.com/buildings/workshop.webp');
  assert.equal(valid.imageAlt, 'Workshop building front');

  const fallbackAlt = validateBuildingDetails({
    image: '/photos/bld-2.png',
  });
  assert.equal(fallbackAlt.imageAlt, 'Building photo');

  const filtered = validateBuildingDetails({
    description: 'Safe text',
    phone: 'javascript:evil()',
    image: 'http://insecure.com/bad.svg',
  });
  assert.equal(filtered.description, 'Safe text');
  assert.equal(filtered.phone, null);
  assert.equal(filtered.image, null);
  assert.equal(filtered.imageAlt, null);
});


test('location-details: visitorInfo is trimmed plain text and rejects non-strings', () => {
  assert.equal(validateBuildingDetails({ visitorInfo: '  Report to reception.  ' }).visitorInfo, 'Report to reception.');
  assert.equal(validateBuildingDetails({ visitorInfo: '<b>Use Gate 1</b>' }).visitorInfo, '<b>Use Gate 1</b>');
  assert.equal(validateBuildingDetails({ visitorInfo: '   ' }).visitorInfo, null);
  assert.equal(validateBuildingDetails({ visitorInfo: ['not', 'text'] }).visitorInfo, null);
  assert.equal(validateBuildingDetails({ visitorInfo: 123 }).visitorInfo, null);
});

test('raw controls and backslashes never become image or phone URLs', () => {
  for (const value of ['\n12345', '12345\r', '123\u000045']) assert.equal(sanitizePhone(value), null);
  for (const value of ['\n/photo.png', '/photo.png\r', '/\\evil.test/a.png', '\\\\evil.test/a.png', './images\\a.png']) assert.equal(sanitizeImageUrl(value), null);
});
test('credential-bearing image URLs are rejected', () => {
  for (const value of ['https://user:pass@example.test/a.png', 'https://user@example.test/a.png', 'https://:pass@example.test/a.png']) assert.equal(sanitizeImageUrl(value), null);
});
test('guide query data survives add-clear roundtrip including unicode and plus', () => {
  const before = new URL('https://example.test/?scene=abc&s=def&d=a%2Bb%3D%3D&extra=%E6%97%A5%E6%9C%AC#anchor');
  const after = new URL(clearPinUrl(buildPinUrl(before.href, '東京 / gate')));
  assert.deepEqual([...after.searchParams], [...before.searchParams]);
  assert.equal(after.hash, before.hash);
});

test('legacy embedded payload stays with its original pin only', () => {
  const original = 'https://example.test/?id=one&d=payload#map';
  assert.equal(new URL(buildPinUrl(original, 'one')).searchParams.get('d'), 'payload');
  const other = new URL(buildPinUrl(original, 'two'));
  assert.equal(other.searchParams.get('id'), 'two');
  assert.equal(other.searchParams.has('d'), false);
  assert.equal(other.hash, '#map');
});
