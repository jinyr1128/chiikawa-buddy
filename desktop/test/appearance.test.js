import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearance, overlayLayout, resizeOverlay } from '../src/appearance.js';
import { sanitizeAppPrefs } from '../src/settings.js';
import { pickAsset, RELEASES_PAGE } from '../src/update-check.js';
test('old settings retain default appearance; invalid persisted scales recover',()=>{
 assert.deepEqual(appearance({}),{characterScale:100,bubbleScale:100,bubblesVisible:true,notificationsVisible:true});
 assert.equal(appearance({characterScale:NaN}).characterScale,100);
 assert.equal(appearance({characterScale:1000}).characterScale,150);
 assert.equal(appearance({bubblesVisible:false}).bubblesVisible,false);
});
test('independent size controls fit screen, keeping bottom centre on resize',()=>{
 for(const characterScale of [50,100,150]) for(const bubbleScale of [50,100,150]) {
  const area={x:-800,y:30,width:800,height:600};
  const l=overlayLayout({characterScale,bubbleScale},area);
  assert.ok(l.width<=area.width && l.height<=area.height);
  assert.ok(Math.abs(l.characterZoom/l.bubbleZoom-characterScale/bubbleScale)<1e-9);
  const b=resizeOverlay({x:-500,y:200,width:420,height:400},{width:l.width,height:l.height},area);
  assert.ok(b.x>=area.x && b.y>=area.y && b.x+b.width<=0 && b.y+b.height<=630);
 }
 assert.deepEqual(resizeOverlay({x:400,y:200,width:420,height:580},{width:210,height:290},{x:0,y:0,width:1920,height:1080}),{x:505,y:490,width:210,height:290});
});
test('settings accepts scales and visibility but rejects malformed values',()=>{
 assert.deepEqual(sanitizeAppPrefs({characterScale:50,bubbleScale:150,bubblesVisible:false}),{characterScale:50,bubbleScale:150,bubblesVisible:false});
 for(const characterScale of [49,151,'100',null,NaN,Infinity]) assert.equal(sanitizeAppPrefs({characterScale}),null);
});
test('public Mac zip release can be discovered by update notification',()=>{
 const url=`${RELEASES_PAGE}/download/v0.5.1/chiikawa-manager-arm64.zip`;
 assert.equal(pickAsset([{name:'chiikawa-manager-arm64.zip',browser_download_url:url}],{platform:'darwin',arch:'arm64'}).url,url);
});

test('bubble and translucent notification visibility are independent',()=>{
 assert.equal(appearance({bubblesVisible:false}).notificationsVisible,true);
 assert.equal(appearance({notificationsVisible:false}).bubblesVisible,true);
 assert.deepEqual(sanitizeAppPrefs({notificationsVisible:false,bubblesVisible:true}),{notificationsVisible:false,bubblesVisible:true});
 assert.equal(sanitizeAppPrefs({notificationsVisible:'false'}),null);
});
