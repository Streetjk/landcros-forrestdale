import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scenePhotoItems} from '../scene-label-pin.js';

const read=relative=>readFileSync(new URL('../'+relative,import.meta.url),'utf8');

test('photo-list UI retains legacy single photo and orders new signed images',()=>{
  const legacy={photoPath:'legacy-blob',photoUrl:'https://example.test/legacy'};
  assert.deepEqual(scenePhotoItems(legacy),[{path:'legacy-blob',url:legacy.photoUrl}]);
  const photos=[{path:'legacy',url:'https://example.test/first'},
    {path:'new',url:'https://example.test/second'}];
  assert.deepEqual(scenePhotoItems({photoItems:photos,photoUrl:legacy.photoUrl}),photos);
  assert.deepEqual(scenePhotoItems({photoItems:[...photos,{path:'bad',url:'javascript:alert(1)'}]}),photos);
});

test('scene personal groups are stored without deleting scene rows',()=>{
  const ddl=read('supabase/migrations/0020_scene_groups.sql');
  assert.match(ddl,/create table if not exists public\.scene_groups/);
  assert.match(ddl,/create table if not exists public\.scene_group_assignments/);
  assert.match(ddl,/on delete cascade/);
  assert.doesNotMatch(ddl,/delete\s+from\s+scenes/i);
  assert.match(ddl,/alter table public\.scene_groups enable row level security/);
  assert.match(ddl,/revoke all on public\.scene_groups, public\.scene_group_assignments/);
  assert.match(ddl,/grant select,insert,update,delete/);
});

test('new gallery signed fields cannot be written through generic object API',()=>{
  const db=read('scene-db.js');
  assert.match(db,/delete props\.photoItems/);
  assert.match(db,/delete props\.photoPaths/);
  assert.match(db,/delete props\.photoThumbPaths/);
  assert.match(db,/scene_objects\.props->'photoPaths'/);
  assert.match(db,/scene_objects\.props->'photoThumbPaths'/);
  assert.match(db,/and scene_objects\.scene_id = excluded\.scene_id/);
});

test('viewer gallery preserves old image across selection changes',()=>{
  const view=read('scene-photo-gallery-view.js');
  assert.match(view,/const main=frame\.querySelector\('img\[id\]'\)/);
  assert.match(view,/if\(main\)frame\.appendChild\(main\)/);
  assert.match(view,/main\.crossOrigin='anonymous'/);
});
