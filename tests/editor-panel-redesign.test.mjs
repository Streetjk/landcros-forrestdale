import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor=readFileSync(new URL('../editor.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../scene-editor.js',import.meta.url),'utf8');
const ids=[
'editor-toolbar','scenes-panel','scenes-list','add-scene-btn','add-group-btn',
'new-scene-row','new-scene-confirm-btn','new-scene-cancel-btn',
'new-group-row','new-group-name','new-group-confirm-btn','new-group-cancel-btn',
'scene-share-row','scene-share-copy-btn','add-buttons','add-label-btn',
'add-button-btn','add-widget-btn','property-panel','prop-text','prop-description',
'prop-photo-input','prop-photo-preview','prop-photo-gallery','prop-photo-upload-btn',
'prop-photo-remove-btn','prop-photo-status','prop-action-group',
'prop-widget-group','prop-delete-btn','empty-selection',
'editor-mobile-open','editor-mobile-close','editor-mobile-scrim'
];

test('modern editor preserves all workflow event targets and recovery status',()=>{
 for(const id of ids){
  assert.match(editor,new RegExp('id="'+id+'"'),'Missing UI target '+id);
 }
 assert.match(editor,/Connecting to saved scenes/);
 assert.match(editor,/New scene/);
 assert.match(editor,/Place on map/);
 assert.match(editor,/Pin/);
 assert.match(editor,/Button/);
 assert.match(editor,/Widget/);
 assert.match(js,/startEditorOnce/);
 assert.match(js,/photoField\.insertBefore\(_photoZoom\.container, photoGallery\)/);
});

test('editor continues to keep scene names and group hierarchies in one compact list',()=>{
 assert.match(editor,/#scenes-list\s*\{[^}]*max-height:clamp\(/);
 assert.match(editor,/\.scene-list-item\.active\s*\{/);
 assert.match(editor,/\.scene-group-fold/);
 assert.match(editor,/\.scene-duplicate-btn/);
 assert.match(editor,/#scene-share-row/);
 assert.match(js,/renderSceneGroupSections\(list, _scenes, renderRow\)/);
});

test('redesign is opaque, scoped to editor, responsive and accessible',()=>{
 assert.match(editor,/#editor-toolbar\s*\{[\s\S]*?backdrop-filter:none!important/);
 assert.match(editor,/@media \(min-width:761px\) and \(max-width:1040px\)/);
 assert.match(editor,/@media \(max-width:760px\)/);
 assert.match(editor,/@media \(prefers-reduced-motion:reduce\)/);
 assert.match(editor,/#editor-toolbar :is\(button,input,textarea,select,summary\):focus-visible/);
 assert.match(editor,/aria-live="polite"/);
 assert.match(editor,/aria-controls="editor-toolbar"/);
 assert.match(editor,/aria-label="Add objects to scene"/);
 assert.doesNotMatch(editor,/fetch\(['"]https:\/\//);
});
