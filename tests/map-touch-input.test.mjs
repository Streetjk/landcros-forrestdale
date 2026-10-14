import test from 'node:test';
import assert from 'node:assert/strict';
import {findLabelAtTap,isTouchMapDevice,isWithinTapRect,isVisibleTapTarget} from '../map-touch-input.js';

const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
const makeTarget=(box,{visible=true,connected=true,role='button'}={})=>({
  isConnected:connected,
  box,getBoundingClientRect(){return this.box;},
  closest(){return visible?null:{hidden:true};},
  style:{display:visible?'block':'none',visibility:visible?'visible':'hidden',opacity:'1'},
  getAttribute(key){return key==='role'?role:null},
});
const oldStyle=globalThis.getComputedStyle;
function withCss(run){
  globalThis.getComputedStyle=(el)=>el.style;
  try{return run()}finally{globalThis.getComputedStyle=oldStyle}
}

test('coarse touch pointer detection, including hybrid tablets',()=>{
  assert.equal(isTouchMapDevice({matchMedia:()=>({matches:true})},{maxTouchPoints:0}),true);
  assert.equal(isTouchMapDevice({matchMedia:()=>({matches:false})},{maxTouchPoints:5}),true);
  assert.equal(isTouchMapDevice({matchMedia:()=>({matches:false})},{maxTouchPoints:0}),false);
});

test('tap rects honour projected scale, clipping and finger-friendly margins',()=>{
  assert.equal(isWithinTapRect(50,50,rect(40,40,20,20)),true);
  assert.equal(isWithinTapRect(65,50,rect(40,40,20,20)),false);
  assert.equal(isWithinTapRect(65,50,rect(40,40,20,20),5),true);
  assert.equal(isWithinTapRect(50,50,rect(40,40,0,20)),false);
  assert.equal(isWithinTapRect(NaN,50,rect(40,40,20,20)),false);
});

test('painted labels can be tapped without their actual DOM element intercepting pointer events',()=>withCss(()=>{
  const scene=makeTarget(rect(40,50,60,50));
  const pin=makeTarget(rect(200,60,70,35));
  const building=makeTarget(rect(120,110,90,45));
  const fired=[];
  const entries=[
    {priority:50,elements:[scene],activate:()=>fired.push('scene')},
    {priority:40,elements:[pin],activate:()=>fired.push('pin')},
    {priority:20,elements:[building],activate:()=>fired.push('building')},
  ];
  for(const [point,expect] of [
    [[50,70],'scene'],[[230,75],'pin'],[[160,135],'building'],[[15,15],null]
  ]){
    const t=findLabelAtTap(entries,...point);
    if(expect){assert.ok(t);t.activate();assert.equal(fired.at(-1),expect)}
    else assert.equal(t,null);
  }
}));

test('foreground labels win overlapping bounds; hidden labels cannot intercept taps',()=>withCss(()=>{
  const lower=makeTarget(rect(50,70,200,65));
  const upper=makeTarget(rect(80,80,45,40));
  assert.equal(findLabelAtTap([
    {priority:20,elements:[lower],activate:()=>{}},
    {priority:50,elements:[upper],activate:()=>{}}
  ],92,94).priority,50);
  assert.equal(findLabelAtTap([{priority:50,elements:[makeTarget(rect(10,10,80,80),{visible:false})],activate:()=>{}}],20,20),null);
  assert.equal(isVisibleTapTarget(makeTarget(rect(10,10,80,80),{connected:false})),false);
}));

test('a tap does not select a label or pin outside its real painted rectangle',()=>withCss(()=>{
  const label=makeTarget(rect(100,100,80,30));
  const item={priority:20,elements:[label],activate:()=>{}};
  assert.equal(findLabelAtTap([item],130,132),null);
  assert.equal(findLabelAtTap([item],130,127),item);
}));
