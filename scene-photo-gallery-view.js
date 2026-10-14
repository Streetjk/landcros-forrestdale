import { scenePhotoItems } from './scene-label-pin.js';

// Shared responsive photo gallery for public/admin scene pin details.
// DOM API only (no HTML interpolation); all images use anonymous CORS because
// SiteNav's WebGL isolation rejects default cross-origin image requests.
export function renderScenePhotoGallery({
  props={}, title='', frameId='detail-scene-photo-wrap',
  imageId='detail-scene-photo', notesId='detail-notes',
} = {}) {
  let frame=document.getElementById(frameId);
  const notes=document.getElementById(notesId);
  if(!frame) {
    if(!notes)return null;
    frame=document.createElement('div');
    frame.id=frameId;
    notes.insertAdjacentElement('afterend',frame);
  }
  frame.classList.add('scene-photo-gallery-view');
  frame.replaceChildren();
  const photos=scenePhotoItems(props);
  frame.hidden=photos.length===0;
  if(!photos.length)return frame;

  const main=document.createElement('img');
  main.id=imageId;
  main.className='scene-gallery-main';
  main.alt='Photo of '+(title||'scene location');
  main.crossOrigin='anonymous';
  main.referrerPolicy='no-referrer';
  main.loading='eager';
  main.decoding='async';
  main.fetchPriority='high';
  frame.appendChild(main);

  if(photos.length===1) {
    main.src=photos[0].url;
    return frame;
  }
  const bar=document.createElement('div');
  bar.className='scene-gallery-toolbar';
  const prev=document.createElement('button');
  prev.type='button';prev.textContent='‹';
  prev.setAttribute('aria-label','Previous photo');
  const count=document.createElement('span');
  count.setAttribute('aria-live','polite');
  const next=document.createElement('button');
  next.type='button';next.textContent='›';
  next.setAttribute('aria-label','Next photo');
  bar.append(prev,count,next);
  const thumbs=document.createElement('div');
  thumbs.className='scene-gallery-thumbnails';
  thumbs.setAttribute('aria-label','Choose photo');
  frame.append(bar,thumbs);

  let selected=0;
  const buttons=[];
  const show=index=>{
    selected=(index+photos.length)%photos.length;
    main.src=photos[selected].url;
    count.textContent=(selected+1)+' / '+photos.length;
    buttons.forEach((button,i)=>{
      button.setAttribute('aria-pressed',String(selected===i));
      button.classList.toggle('active',selected===i);
    });
  };
  photos.forEach((item,i)=>{
    const button=document.createElement('button');
    button.type='button';
    button.className='scene-gallery-thumb';
    button.setAttribute('aria-label','View photo '+(i+1)+' of '+photos.length);
    const img=document.createElement('img');
    img.alt='';img.crossOrigin='anonymous';img.referrerPolicy='no-referrer';
    img.loading='lazy';img.src=item.url;
    button.appendChild(img);
    button.addEventListener('click',()=>show(i));
    thumbs.appendChild(button);
    buttons.push(button);
  });
  prev.addEventListener('click',()=>show(selected-1));
  next.addEventListener('click',()=>show(selected+1));
  show(0);
  return frame;
}

export function hideScenePhotoGallery(frameId='detail-scene-photo-wrap') {
  const frame=document.getElementById(frameId);
  if(!frame)return;
  frame.hidden=true;
  // Preserve the legacy image element. The single-photo renderer references
  // its stable ID when the visitor switches back from a multi-photo pin.
  const main=frame.querySelector('img[id]');
  main?.removeAttribute('src');
  frame.replaceChildren();
  if(main)frame.appendChild(main);
}
