import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('public scene capability includes only shared pins and contacts derived from shared pins', async () => {
  const source = await readFile(new URL('../scenes-db.js', import.meta.url), 'utf8');
  assert.match(source, /select \* from points where scene_id = \$1 and site_id = \$2 and scope = 'shared' order by created_at/);
  assert.match(source, /unnest\(contact_ids\) from points where scene_id = \$1 and site_id = \$2 and scope = 'shared'/);
});
