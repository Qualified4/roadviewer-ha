// GPS route maps (gps_track.py, /api/tracks, /api/logs/<id>/track). One file for both pages, in its own scope:
//  library: ① 목록 | 지도 (every drive the filters show, one colour each), ② the route on each card (an SVG, no
//           tiles) that opens 주행 지도: the drive full screen, its map above (or beside) a sheet of its
//           segment rows;
//  replay:  ③ 주행 상황 | 지도 (the drive, this log's segment solid, a car marker following playback, tap to seek) and
//           ④ the small map in the video's top-right corner, under the speed and the wheel
//           (겹쳐 보기 설정 › 지도).
// Leaflet (vendor/, BSD-2) draws the routes, markers and controls; the basemap under them is OpenFreeMap's vector
// tiles (OpenStreetMap data, no API key) drawn by MapLibre GL JS (vendor/, BSD-3) through maplibre-gl-leaflet
// (vendor/, ISC). All three and their stylesheets load only when a map is first shown. Style: Liberty (light) or
// Dark with the app's theme; 회색 지도 takes Positron or Dark without the busy layers and 글자 숨기기 hides the names and
// symbols; the attribution stays one tap away (an ⓘ in the corner, compactCredit).
(()=>{
 const library=!!document.getElementById('panel-logs'),replay=!!document.getElementById('roadView');
 if(!library&&!replay)return;
 const STYLES={light:'https://tiles.openfreemap.org/styles/liberty',dark:'https://tiles.openfreemap.org/styles/dark'};
 // Two buttons under the zoom buttons, each kept on this browser and off by default, for every map on the page but the
 // small map over the video (its own two options): 회색 지도, Positron (light) or Dark without 3D buildings, points of
 // interest, road shields, one-way arrows and house numbers; 글자 숨기기, the style's own colours (the yellow main roads
 // stay) without its symbol layers (place and road names, icons, arrows). Both on: the calm style without any text.
 const SIMPLE_STYLES={light:'https://tiles.openfreemap.org/styles/positron',dark:'https://tiles.openfreemap.org/styles/dark'};
 const SIMPLE_KEY='roadviewer-map-simple',BUSY_LAYER=/poi|shield|housenumber|transit|airport|one_?way/i;
 const BARE_KEY='roadviewer-map-nolabels';
 let simple=false,bare=false;try{simple=localStorage.getItem(SIMPLE_KEY)==='1';bare=localStorage.getItem(BARE_KEY)==='1'}catch{}
 const simpleButtons=new Set();
 // 지도 테마 (the same popover): 자동 follows the app's theme, 라이트 and 다크 fix the basemap for every map on the page
 // but the small map over the video (its own 색상 setting); kept on this browser.
 const TONE_KEY='roadviewer-map-tone';let mapTone='auto';try{const saved=localStorage.getItem(TONE_KEY);if(saved==='light'||saved==='dark')mapTone=saved}catch{}
 const link=(href,text)=>`<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
 const ATTRIBUTION=`${link('https://openfreemap.org','OpenFreeMap')} ${link('https://www.openmaptiles.org/','© OpenMapTiles')} Data from ${link('https://www.openstreetmap.org/copyright','OpenStreetMap')}`;
 const SHORT_ATTRIBUTION=`${link('https://openfreemap.org','OpenFreeMap')} ${link('https://www.openmaptiles.org/','© OpenMapTiles')} ${link('https://www.openstreetmap.org/copyright','© OSM')}`;
 const PALETTE=['mint','blue','amber','violet','rose','cyan','lime','coral','indigo','yellow','red','slate'];
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const theme=()=>window.RoadViewerTheme?.theme?.()==='light'?'light':'dark';
 const css=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
 // Drive lines on the all-drives map: the tag colour picker's pastel tones in both themes, each over a thin darker
 // casing so a light pastel still reads on the light basemap.
 const PASTEL={mint:'#65dfb9',blue:'#8cbcff',amber:'#f2c16f',violet:'#c2a1ff',rose:'#f2a4bd',cyan:'#75d9ef',lime:'#b9df78',coral:'#ffad92',indigo:'#9faaff',yellow:'#f5df7a',red:'#ff8c91',slate:'#acbbcc'};
 const tagColor=i=>PASTEL[PALETTE[i%PALETTE.length]];
 const casingColor=()=>theme()==='light'?'rgba(31,41,55,.42)':'rgba(0,0,0,.55)';
 // The stylesheet this page was served with names the asset folder and its version.
 const styleLink=document.head.querySelector('link[href*="style.css"]'),assetBase=styleLink?new URL('./',styleLink.href):new URL(replay?'../../assets/':'assets/',location.href),version=styleLink?new URL(styleLink.href).search:'';
 let leaflet=null;
 function loadLeaflet(){
  if(window.L?.maplibreGL)return Promise.resolve(window.L);
  if(leaflet)return leaflet;
  const add=(tag,attrs)=>new Promise((resolve,reject)=>{const el=document.createElement(tag);Object.assign(el,attrs);el.onload=resolve;el.onerror=()=>reject(Error('지도를 불러오지 못했습니다.'));document.head.append(el)});
  const url=name=>new URL('vendor/'+name+version,assetBase).href,sheet=(id,name)=>document.head.querySelector('#'+id)?Promise.resolve():add('link',{id,rel:'stylesheet',href:url(name)});
  // The binding needs both globals (L, maplibregl), so it comes last.
  leaflet=Promise.all([sheet('rvLeafletCss','leaflet.css'),sheet('rvMaplibreCss','maplibre-gl.css'),
   window.L?.map?null:add('script',{id:'rvLeafletJs',src:url('leaflet.js')}),window.maplibregl?.Map?null:add('script',{id:'rvMaplibreJs',src:url('maplibre-gl.js')})])
   .then(()=>window.L.maplibreGL?null:add('script',{id:'rvMaplibreLeafletJs',src:url('leaflet-maplibre-gl.js')})).then(()=>window.L).catch(e=>{leaflet=null;throw e});
  return leaflet;
 }
 // A map with this app's look: no Leaflet prefix, the OpenFreeMap style of the current theme, zoom buttons only where
 // asked. At most two exist on a page (library: the list's map and 주행 지도; replay: the 지도 tab and the small map);
 // MapLibre draws only when its Leaflet map moves or its style changes, so a hidden one costs no frames.
 const maps=new Set();
 // Asked once; the probe's context is released right away (phones allow only a few).
 let hasWebgl=null;
 const webgl=()=>hasWebgl??=(()=>{try{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2')||canvas.getContext('webgl');gl?.getExtension('WEBGL_lose_context')?.loseContext();return !!gl}catch{return false}})();
 const GL_SIDE=4000;  // the drawn basemap canvas's longest side, in device pixels, for the margins below
 // tone: a function giving 'light' or 'dark' to override the app theme; labels: a function, false to hide the style's
 // place and road names (its symbol layers); grey: a function, true for the grey style (tone, labels, grey: the small
 // map's own choices; other maps follow the page's 회색 지도 and 글자 숨기기 buttons). margin: the share of the map's
 // size drawn beyond each edge, by the basemap (the plugin's padding) and the route lines (the SVG renderer's padding),
 // for the maps that follow the car by scrolling what is drawn (the replay's); the others keep the defaults (0.1).
 // A tap beside a route line counts as a tap on it: the line nearest the tap within a finger's reach (24px; 8px with a
 // mouse). The lines are 4-5px wide, and on a phone a tap had to land exactly on one, or it cleared the selection.
 const nearestLine=(lines,event)=>{
  const reach=event.originalEvent?.pointerType==='mouse'?8:24;let best=null;
  for(const line of lines){if(!line._map)continue;const at=line.closestLayerPoint(event.layerPoint);if(at&&at.distance<=reach&&(!best||at.distance<best.distance))best={distance:at.distance,line}}
  return best?.line||null;
 };
 function createMap(L,container,{zoom=true,interactive=true,attribution=ATTRIBUTION,tone=null,labels=null,grey=null,margin=null}={}){
  const map=L.map(container,{zoomControl:false,attributionControl:true,dragging:interactive,touchZoom:interactive,scrollWheelZoom:interactive,doubleClickZoom:interactive,boxZoom:interactive,keyboard:interactive,tap:interactive,zoomSnap:.25,maxZoom:19,fadeAnimation:!reduced(),zoomAnimation:!reduced(),markerZoomAnimation:!reduced(),...(margin?{renderer:L.svg({padding:margin})}:{})});
  map.rvMargin=margin||0;map.rvMarginMax=margin||0;
  // Leaflet listens on the window and MapLibre keeps a WebGL context and workers: a map left standing when its page
  // goes kept the whole page alive.
  if(typeof onPageDispose==='function')onPageDispose(()=>map.remove());  // not there on a page loaded by itself
  // margin is the most asked for: each side gets as much of it as keeps the drawn canvas within GL_SIDE device pixels on
  // its longer side (MapLibre and phone GPUs stop at 4096; beyond, the map blurs or is cut), never under the default 0.1.
  // A phone's 지도 tab gets the full 0.5; a tablet's or a desktop's large map, or the small map enlarged on a big
  // screen, a share that fits. Set again on every resize (Leaflet's resize runs this before the plugin redraws).
  // map.rvNarrow (the 지도 tab during a hand zoom): the default 0.1, as MapLibre redraws the whole canvas each frame.
  if(margin){
   const fit=()=>{const size=map.getSize(),side=Math.max(size.x,size.y)*Math.min(window.devicePixelRatio||1,2);
    const share=map.rvNarrow?.1:side>0?Math.max(.1,Math.min(margin,(GL_SIDE/side-1)/2)):margin;map.rvMargin=share;
    if(map.options.renderer)map.options.renderer.options.padding=share;if(map.rvGlLayer)map.rvGlLayer.options.padding=share;};
   map.rvFitMargin=fit;map.on('resize',()=>{fit();map.options.renderer?._update?.()});
  }
  // Leaflet 1.9.4 without zoom animation (reduced motion) moves the zoom along with the fingers during a pinch, so when
  // the pinch ends its final view (_resetView) sees no zoom change and fires no zoomend after the zoomstart: the basemap
  // plugin, waiting for it, stayed frozen out of place (and the 지도 tab's narrow margin with it). A move that ends with a
  // zoom still open, no zoom animation and no pinch in progress closes it.
  let zoomOpen=false;
  map.on('zoomstart',()=>{zoomOpen=true}).on('zoomend',()=>{zoomOpen=false})
   .on('moveend',()=>{if(zoomOpen&&!map._animatingZoom&&!map.touchZoom?._zooming)map.fire('zoomend')});
  map.attributionControl.setPrefix(false);
  const tiles=()=>tone?tone()||theme():mapTone==='auto'?theme():mapTone,plain=()=>labels?!labels():bare,isGrey=()=>grey?grey():simple,tileKey=()=>tiles()+(isGrey()?'-grey':'')+(plain()?'-nolabels':'');
  container.classList.add('rv-map');container.dataset.tiles=tiles();container.dataset.tileKey=tileKey();map.rvTiles=tiles;map.rvTileKey=tileKey;map.rvPlain=plain;map.rvGrey=isGrey;map.rvOwn=!!(labels||grey);maps.add(map);
  // The style is set after the map exists (not as an option) so that every load, the first and each theme change,
  // goes through transformStyle: it hides the symbol layers right in the style while 글자 숨기기 is on. Leaflet adds
  // the layer (and MapLibre's map) once the map has a view, so this waits for it. No WebGL (rare): the routes are
  // still drawn, on the plain background.
  map.rvGl=null;map.rvSymbols=[];
  if(webgl()){
   const layer=L.maplibreGL({attributionControl:{customAttribution:attribution},pixelRatio:Math.min(window.devicePixelRatio||1,2),fadeDuration:reduced()?0:300,renderWorldCopies:false,...(margin?{padding:margin}:{})});
   // The plugin redraws on every Leaflet move (throttled); map.rvHold (a hand drag of the 지도 tab while its margin
   // still covers) skips that: what is drawn moves with the map pane, re-centred by the caller.
   layer._throttledUpdate=L.Util.throttle(function(e){if(!map.rvHold?.())this._update(e)},layer.options.updateInterval,layer);
   map.rvGlLayer=layer;layer.once('add',()=>{map.rvGl=layer.getMaplibreMap();map.rvGl.on('styledata',()=>showLabels(map,false));setStyle(map)});
   layer.addTo(map);
  }
  map.rvFitMargin?.();  // the basemap layer exists now: its padding too
  if(zoom){L.control.zoom({position:'topright',zoomInTitle:'확대',zoomOutTitle:'축소'}).addTo(map);simpleControl(L).addTo(map)}
  compactCredit(L,map,container);
  new ResizeObserver(()=>{if(container.isConnected)map.invalidateSize({animate:false})}).observe(container);
  return map;
 }
 // The map credit (OpenFreeMap, OpenMapTiles, OpenStreetMap) folds into an ⓘ button in the bottom-right corner on every
 // map (phones, tablets and the small map over the video alike), as MapLibre's compact attribution does: folded at
 // first, the button shows or hides it.
 function compactCredit(L,map,container){
  const corner=map.attributionControl.getContainer().parentNode,toggle=L.DomUtil.create('button','rv-credit-toggle leaflet-control',corner);
  toggle.type='button';toggle.setAttribute('aria-label','지도 출처');toggle.title='지도 출처';
  toggle.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5h.01" stroke-width="2.6"/></svg>';
  L.DomEvent.disableClickPropagation(toggle);
  let open=false;
  const sync=()=>{container.classList.add('is-credit-compact');container.classList.toggle('is-credit-open',open);toggle.setAttribute('aria-expanded',String(open))};
  toggle.addEventListener('click',e=>{e.preventDefault();open=!open;sync()});
  toggle.addEventListener('keydown',e=>e.stopPropagation());
  sync();
 }
 function simpleControl(L){
  const control=L.control({position:'topright'});
  // One layers button under the zoom buttons opens 지도 표시, a small glass popover like the road view's 레이어 menu,
  // with the two switches; it opens towards the middle of the map and closes on Escape or a tap elsewhere.
  control.onAdd=()=>{
   const wrap=L.DomUtil.create('div','rv-map-simple'),bar=L.DomUtil.create('div','leaflet-bar',wrap),button=L.DomUtil.create('a','rv-map-options-button',bar);
   button.href='#';button.setAttribute('role','button');button.setAttribute('aria-haspopup','true');button.setAttribute('aria-expanded','false');button.title='지도 표시';button.setAttribute('aria-label','지도 표시');
   button.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5" stroke-linecap="round"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5" stroke-linecap="round" opacity=".55"/></svg>';
   const pop=L.DomUtil.create('div','rv-map-options',wrap);pop.hidden=true;pop.setAttribute('role','group');pop.setAttribute('aria-label','지도 표시');
   pop.innerHTML='<p class="rv-map-options-title">지도 표시</p><div class="rv-map-tone"><span>지도 테마</span><div class="view-switch view-switch-3" role="group" aria-label="지도 테마">'
    +[['auto','자동'],['light','라이트'],['dark','다크']].map(([tone,text])=>`<button type="button" data-tone="${tone}" aria-pressed="false">${text}</button>`).join('')+'</div></div>'+[['labels','글자 숨기기','지명·도로 이름·아이콘·화살표를 숨깁니다. 지도 색은 그대로입니다.'],['grey','회색 지도','차분한 회색 지도로 바꾸고 3D 건물·아이콘을 뺍니다.']]
    .map(([kind,title,note])=>`<label><input type="checkbox" data-kind="${kind}"><span><b>${title}</b><small>${note}</small></span></label>`).join('');
   L.DomEvent.disableClickPropagation(wrap);L.DomEvent.disableScrollPropagation(pop);wrap.rvPop=pop;
   // Open, the popover leaves the map for the page (the open dialog, or the body) at a fixed place beside the button:
   // inside the map it was drawn under whatever lies over the map (주행 지도's segment cards on a phone). Closed, it
   // goes back into the control.
   const place=()=>{
    const host=wrap.closest('dialog[open]')||document.body;if(pop.parentNode!==host)host.append(pop);
    const map=wrap.closest('.leaflet-container')?.getBoundingClientRect(),at=button.getBoundingClientRect(),left=!!map&&at.left+at.width/2>map.left+map.width/2;
    pop.classList.toggle('to-left',left);
    const width=pop.offsetWidth,height=pop.offsetHeight;
    pop.style.left=Math.round(Math.max(8,Math.min(window.innerWidth-width-8,left?at.left-8-width:at.right+8)))+'px';
    pop.style.top=Math.round(Math.max(8,Math.min(window.innerHeight-height-8,at.top)))+'px';
   };
   const resized=()=>setOpen(false);
   wrap.rvClose=()=>{setOpen(false);pop.remove()};
   const outside=event=>{if(!wrap.contains(event.target)&&!pop.contains(event.target))setOpen(false)},key=event=>{if(event.key==='Escape'){event.stopPropagation();event.preventDefault();setOpen(false);button.focus()}};  // only the popover, not the drive map under it
   const setOpen=open=>{
    pop.hidden=!open;wrap.classList.toggle('is-open',open);button.setAttribute('aria-expanded',String(open));
    if(open)place();else if(pop.parentNode!==wrap)wrap.append(pop);
    if(open){document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);window.addEventListener('resize',resized)}else{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);window.removeEventListener('resize',resized)}
   };
   L.DomEvent.on(button,'click',event=>{L.DomEvent.preventDefault(event);setOpen(pop.hidden)});
   for(const box of pop.querySelectorAll('input'))box.addEventListener('change',()=>setSimple(box.dataset.kind,box.checked));
   for(const choice of pop.querySelectorAll('button[data-tone]'))choice.addEventListener('click',()=>setMapTone(choice.dataset.tone));
   simpleButtons.add(wrap);showSimple(wrap);return wrap;
  };
  control.onRemove=()=>{control.getContainer()?.rvClose?.();for(const button of simpleButtons)if(!button.isConnected)simpleButtons.delete(button)};
  return control;
 }
 function showSimple(wrap){
  const pop=wrap.rvPop;
  for(const box of pop.querySelectorAll('input[data-kind]'))box.checked=box.dataset.kind==='grey'?simple:bare;
  for(const choice of pop.querySelectorAll('button[data-tone]'))choice.setAttribute('aria-pressed',String(choice.dataset.tone===mapTone));
  wrap.querySelector('.rv-map-options-button').classList.toggle('is-on',simple||bare||mapTone!=='auto');
 }
 // 지도 테마 fixed against the app's theme: the root says so (data-map-contrast: the map's tone), and the glass over
 // the maps turns nearly solid in the app's own theme (style.css). See-through, a dark card over a light map read as a
 // light card with its light text lost: only the map is to change.
 const markContrast=()=>{const root=document.documentElement;if(mapTone!=='auto'&&mapTone!==theme())root.dataset.mapContrast=mapTone;else delete root.dataset.mapContrast};
 markContrast();
 const syncSimple=()=>{
  markContrast();
  for(const button of simpleButtons){if(!button.isConnected){simpleButtons.delete(button);continue}showSimple(button)}
  for(const map of maps){if(!map.getContainer().isConnected){maps.delete(map);continue}if(!map.rvOwn)applyTiles(map)}
 };
 function setMapTone(tone){if(tone===mapTone)return;mapTone=tone;try{localStorage.setItem(TONE_KEY,tone)}catch{}syncSimple()}
 // Only the basemap's style changes: the view, the route lines and any selection stay as they are.
 function setSimple(kind,on){
  if(kind==='grey')simple=on;else bare=on;try{localStorage.setItem(kind==='grey'?SIMPLE_KEY:BARE_KEY,on?'1':'0')}catch{}
  syncSimple();
 }
 function setStyle(map){
  // 회색 지도: the calm style without the busy layers; 글자 숨기기: below, every symbol layer hidden.
  const grey=map.rvGrey(),box=map.getContainer();box.dataset.simple=String(grey);box.dataset.grey=String(grey);
  map.rvGl.setStyle((grey?SIMPLE_STYLES:STYLES)[map.rvTiles()],{diff:false,transformStyle:(previous,next)=>{
   const busy=grey?next.layers.filter(layer=>layer.type==='fill-extrusion'||BUSY_LAYER.test(layer.id)).map(layer=>layer.id):[];
   map.getContainer().dataset.removed=busy.join(' ');
   if(busy.length)next={...next,layers:next.layers.filter(layer=>!busy.includes(layer.id))};
   // The symbol layers the style itself shows: the ones 글자 숨기기 hides and shows again.
   map.rvSymbols=next.layers.filter(layer=>layer.type==='symbol'&&layer.layout?.visibility!=='none').map(layer=>layer.id);
   const plain=map.rvPlain();box.dataset.labels=plain?'hidden':'shown';
   if(!plain)return next;
   const hidden=new Set(map.rvSymbols);
   return {...next,layers:next.layers.map(layer=>hidden.has(layer.id)?{...layer,layout:{...layer.layout,visibility:'none'}}:layer)};
  }});
 }
 // apply: set the symbol layers' visibility (a loaded style); always: data-labels tells what the map shows.
 function showLabels(map,apply=true){
  const gl=map.rvGl,visible=map.rvPlain()?'none':'visible';if(!gl)return;
  if(apply)try{for(const id of map.rvSymbols)if(gl.getLayer(id))gl.setLayoutProperty(id,'visibility',visible)}catch{}  // Still loading: transformStyle applies it.
  const layers=map.rvSymbols.map(id=>gl.getLayer(id)).filter(Boolean);
  if(layers.length)map.getContainer().dataset.labels=layers.some(layer=>layer.getLayoutProperty('visibility')!=='none')?'shown':'hidden';
 }
 window.addEventListener('rv:themechange',()=>{markContrast();for(const map of maps){const box=map.getContainer();if(!box.isConnected){maps.delete(map);continue}applyTiles(map)}redrawColours()});
 // The theme (or the small map's tone) and 회색 지도 load another style; 글자 숨기기 only switches the symbol layers.
 function applyTiles(map){
  const box=map.getContainer(),key=map.rvTileKey(),tiles=map.rvTiles(),styleChanged=box.dataset.tiles!==tiles||box.dataset.grey!==String(map.rvGrey());box.dataset.tiles=tiles;
  if(box.dataset.tileKey===key)return;box.dataset.tileKey=key;
  if(!map.rvGl)return;if(styleChanged)setStyle(map);else showLabels(map);
 }
 let redrawColours=()=>{};
 const latlngs=points=>points.map(p=>[p[1],p[2]]);
 const kmText=m=>Number.isFinite(m)?(m>=1000?(m/1000).toFixed(m>=100000?0:1)+' km':Math.round(m)+' m'):'—';
 // A route's shape as an SVG fitted to w×h (latitude-scaled, aspect kept, pad: the margin's share of each side): a soft
 // halo under a line that fades from the start colour to the accent, a hollow start dot and a filled end dot with a
 // halo; grid adds faint map lines behind it. The colours are theme tokens (library.css --route-*).
 let shapeId=0;
 function shapeSvg(coords,w,h,{grid=false,pad=.18,stroke=2.6}={}){
  const mid=coords.reduce((s,c)=>s+c[0],0)/coords.length,k=Math.cos(mid*Math.PI/180);
  const xs=coords.map(c=>c[1]*k),ys=coords.map(c=>-c[0]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const iw=w*(1-2*pad),ih=h*(1-2*pad),scale=Math.min(iw/Math.max(maxX-minX,1e-9),ih/Math.max(maxY-minY,1e-9)),ox=(w-(maxX-minX)*scale)/2,oy=(h-(maxY-minY)*scale)/2;
  const pts=xs.map((x,i)=>[+((x-minX)*scale+ox).toFixed(1),+((ys[i]-minY)*scale+oy).toFixed(1)]),d=pts.map(p=>p.join(',')).join(' ');
  const [a,b]=[pts[0],pts.at(-1)],id='rvShape'+(++shapeId);let lines='';
  if(grid){for(let i=1;i<4;i++)lines+=`<line x1="${(w*i/4).toFixed(1)}" y1="0" x2="${(w*i/4).toFixed(1)}" y2="${h}"/>`;for(let i=1;i<3;i++)lines+=`<line x1="0" y1="${(h*i/3).toFixed(1)}" x2="${w}" y2="${(h*i/3).toFixed(1)}"/>`;lines=`<g class="shape-grid">${lines}</g>`}
  return `<svg class="route-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${a[0]}" y1="${a[1]}" x2="${b[0]===a[0]&&b[1]===a[1]?b[0]+.1:b[0]}" y2="${b[1]}"><stop offset="0" class="shape-from"/><stop offset="1" class="shape-to"/></linearGradient></defs>${lines}`+
   `<polyline class="shape-halo" points="${d}" stroke-width="${stroke+4}"/><polyline class="shape-line" points="${d}" stroke="url(#${id})" stroke-width="${stroke}"/>`+
   `<circle class="shape-start" cx="${a[0]}" cy="${a[1]}" r="${(stroke*.95).toFixed(2)}" stroke-width="${(stroke*.6).toFixed(2)}"/><circle class="shape-end-halo" cx="${b[0]}" cy="${b[1]}" r="${(stroke*2.2).toFixed(2)}"/><circle class="shape-end" cx="${b[0]}" cy="${b[1]}" r="${(stroke*1.15).toFixed(2)}"/></svg>`;
 }

 if(library){
  // ---- ① 전체 주행 경로, ② the card's route shape and 주행 지도.
  let tracks=null,trackTag=null,trackText=null,trackSignature=null,trackRequest=null,mode='list',overview=null,overviewLines=new Map(),selected=null;
  const switcher=document.getElementById('logView'),panel=document.getElementById('logMap'),canvas=panel.querySelector('.log-map-canvas'),card=document.getElementById('logMapCard'),empty=panel.querySelector('.log-map-empty');
  const routeOf=new Map();  // log id -> route of /api/tracks
  // The glass pills at the bottom of the maps (the selected drive, the marked segment) rise in (library.css
  // rv-map-card-in) and sink out (.is-leaving, rv-map-card-out) before they are hidden; shown again meanwhile, they
  // come straight back. done runs once the pill is hidden (at once without motion).
  // wait (ms): a pill that shows because the cards were just put away rises in only once they have gone (listWait);
  // rising in at once, it crossed the cards that were still sliding out.
  function showPill(pill,on,done=null,wait=0){
   const ticket=pill.rvPill=(pill.rvPill||0)+1,plain=()=>{pill.style.animationDelay='';pill.style.animationFillMode=''};
   if(on){
    if(pill.hidden||pill.classList.contains('is-leaving')){plain();if(wait>0&&!reduced()){pill.style.animationDelay=Math.round(wait)+'ms';pill.style.animationFillMode='backwards'}}
    pill.classList.remove('is-leaving');pill.hidden=false;return;
   }
   const finish=()=>{if(pill.rvPill!==ticket)return;pill.classList.remove('is-leaving');plain();pill.hidden=true;done?.()};
   if(pill.hidden||reduced()||!pill.getClientRects().length){finish();return}
   plain();pill.classList.add('is-leaving');
   pill.addEventListener('animationend',e=>{if(e.target===pill)finish()},{once:true});setTimeout(finish,320);
  }
  // Tells how long the cards of a list still need to leave: called with whether they are shown, it returns the rest of
  // LIST_OUT_MS since that last turned (0 once they are gone, or when nothing changed).
  const LIST_OUT_MS=300;
  function listWait(){let last=null,at=-1e9;return shown=>{if(shown!==last){if(last!==null)at=performance.now();last=shown}return Math.max(0,at+LIST_OUT_MS-performance.now())}}
  // Scrolls a list so that the row sits in its middle (as far as the list can scroll).
  // The browser's scroll anchoring is off meanwhile: it moved the list for a card that had just shrunk above the row,
  // after the target was worked out, and the row ended at the top instead of the middle.
  // `from`: where the list stood before the rows changed. At the end of the list, the row that loses its buttons shortens
  // it for a moment (a layout falls in before the tapped row grows) and the browser pulls the position up in one step;
  // the scroll starts from `from` again so the list glides instead of jumping.
  function centreRow(list,row,from=null){
   list.style.overflowAnchor='none';clearTimeout(list.rvAnchor);list.rvAnchor=setTimeout(()=>{list.style.overflowAnchor=''},700);
   if(from!==null&&!reduced())list.scrollTop=from;
   const ticket=list.rvCentre=(list.rvCentre||0)+1;
   const target=()=>{const box=row.getBoundingClientRect(),area=list.getBoundingClientRect();return list.scrollTop+box.top-area.top-Math.max(0,(area.height-box.height)/2)};
   const go=()=>list.scrollTo({top:target(),behavior:reduced()?'auto':'smooth'});
   go();
   // The rows out of sight hold a placeholder's height (content-visibility), which their drawn height need not match:
   // the rows the scroll brings into view then move the row away from the middle under way (with the anchoring off,
   // nothing makes up for it). Once the list has come to rest the row is centred again, three times at most, unless the
   // list was touched meanwhile or another row was asked for.
   let touched=false,left=3;const touch=()=>{touched=true};
   for(const type of ['pointerdown','wheel','touchstart','keydown'])list.addEventListener(type,touch,{once:true,passive:true});
   const rest=()=>{
    let last=list.scrollTop,still=0;
    const frame=()=>{
     if(list.rvCentre!==ticket||touched||!row.isConnected)return;
     if(Math.abs(list.scrollTop-last)<.5)still++;else{still=0;last=list.scrollTop}
     if(still<8){requestAnimationFrame(frame);return}
     const top=Math.max(0,Math.min(list.scrollHeight-list.clientHeight,target()));
     if(Math.abs(top-list.scrollTop)>=2&&left-->0){go();rest()}
    };
    requestAnimationFrame(frame);
   };
   rest();
  }
  const groupRoute=group=>{for(const log of group.logs){const route=routeOf.get(log.id);if(route)return route}return null};
  // tracksPending: the routes are on their way. wantDrive: a 지도 button pressed meanwhile; its map opens when they arrive.
  let tracksPending=false,wantDrive=null;
  async function fetchTracks(){
   trackRequest?.abort();const request=trackRequest=new AbortController();
   tracksPending=true;syncCards();
   try{
    const response=await fetch('api/tracks',{cache:'no-store',signal:request.signal,headers:trackTag?{'If-None-Match':trackTag}:{}});
    let text;if(response.status===304&&trackText)text=trackText;else{if(!response.ok)return;text=await response.text();trackTag=response.headers.get('ETag');trackText=text}
    tracks=JSON.parse(text).routes||[];routeOf.clear();for(const route of tracks)for(const id of route.ids)routeOf.set(id,route);
    tracksPending=false;syncCards();if(mode==='map')drawOverview(false);
    if(wantDrive){const {group,button}=wantDrive;wantDrive=null;if(button.isConnected&&logGroups.get(group.route.key)===group&&groupRoute(group))openDrive(group,{opener:button})}
   }catch{}
   finally{if(trackRequest===request&&tracksPending){tracksPending=false;wantDrive=null;syncCards()}}
  }
  // After every list: the routes are fetched again only when the logs with GPS (or their conversions) changed.
  function listed(logs){
   const withTrack=logs.filter(log=>log.has_track);switcher.hidden=!withTrack.length&&mode==='list';
   const signature=JSON.stringify(withTrack.map(log=>[log.id,log.conversion_revision??0,log.name]));
   if(signature!==trackSignature){trackSignature=signature;if(withTrack.length)fetchTracks();else{tracks=[];routeOf.clear();syncCards()}}
   else syncCards();
   // The open drive map follows the list; it closes when its drive is gone.
   if(drive.open){if(driveGroup&&logGroups.get(driveGroup.route.key)===driveGroup&&groupRoute(driveGroup))syncDrive();else closeDrive()}
  }
  // ② The route on each card with GPS (library.css shows one per layout): a glass inset in the video thumbnail's corner
  // and the map strip that grows out beside it on hover or focus (mouse screens), or a 지도 button left of 재생 (phones
  // and touch screens). The strip and the button open the drive's map (주행 지도); the inset is only a picture.
  function syncCards(){
   for(const group of logGroups.values()){
    const route=groupRoute(group),summary=group.element.querySelector(':scope>summary');
    // While the routes are still on their way, a card whose logs have GPS already shows its 지도 button (without the
    // route's shape yet): it used to pop in beside 재생 seconds after the card.
    const pending=!route&&tracksPending&&group.logs.some(log=>log.has_track);
    if(!pending&&(!route||route.points.length<2)){for(const part of group.shape||[])part.remove();group.shape=null;continue}
    if(!group.shape){
     const open=(button)=>event=>{event.preventDefault();event.stopPropagation();if(groupRoute(group))openDrive(group,{opener:button});else wantDrive={group,button}};
     const inset=document.createElement('span');inset.className='route-inset';inset.setAttribute('aria-hidden','true');
     const strip=document.createElement('button');strip.type='button';strip.className='route-strip';strip.dataset.noRipple='';
     strip.setAttribute('aria-label','주행 지도 열기');strip.setAttribute('aria-haspopup','dialog');strip.title='주행 지도';strip.onclick=open(strip);
     const map=document.createElement('button');map.type='button';map.className='route-map-button';map.dataset.noRipple='';
     map.setAttribute('aria-label','주행 지도 열기');map.setAttribute('aria-haspopup','dialog');map.innerHTML='<span class="route-glyph"></span><span>지도</span>';map.onclick=open(map);
     group.shape=[inset,strip,map];
    }
    const [inset,strip,map]=group.shape;
    if(pending){if(map.parentNode!==group.actions)group.actions.prepend(map);continue}
    if(inset.parentNode!==group.thumb)group.thumb.append(inset);
    if(strip.parentNode!==summary)group.thumb.after(strip);
    if(map.parentNode!==group.actions)group.actions.prepend(map);
    const key=route.points.length+':'+route.points[0]+':'+route.points.at(-1);
    if(inset.dataset.key!==key){inset.dataset.key=key;const points=route.points;
     inset.innerHTML=shapeSvg(points,46,46,{pad:.2,stroke:2.6});strip.innerHTML=shapeSvg(points,99,99,{grid:true,pad:.16,stroke:3});map.firstChild.innerHTML=shapeSvg(points,34,32,{pad:.2,stroke:2.2})}
   }
   if(restoreDrive)restoreDrive();
  }
  const routeFacts=group=>{
   const route=groupRoute(group),date=logDate(group.firstLog),duration=group.logs.reduce((sum,log)=>sum+(Number.isFinite(log.duration)?log.duration:0),0);
   return {title:date?`${localeDate(date)} ${clockText(date)}`:group.route.title,facts:[kmText(route?.distance_m),duration?durationText(duration):null,`${group.logs.length}개 구간`].filter(Boolean).join(' · ')};
  };
  // The fold button of a list card over a map (wide screens): folds the card away and back, kept on this browser.
  // Marks the cards of a list that are in sight (.is-seen): only those fade and slide when the list is put away or
  // brought back (library.css). Going away, that is what the column shows now; coming back, what it will show at
  // `height` px (the column has no height yet then, but its cards keep their places). Marked without motion
  // (.is-marking): a card marked while the list is away takes its hidden look at once, so it can then slide in.
  function markSeen(column,height=null){
   const area=column.getBoundingClientRect(),end=area.top+(height??area.height);
   column.classList.add('is-marking');
   for(const row of column.children){const box=row.getBoundingClientRect();row.classList.toggle('is-seen',box.bottom>area.top-80&&box.top<end+80)}  // a little beyond: a card just past the edge slides too
   void column.offsetWidth;column.classList.remove('is-marking');void column.offsetWidth;
  }
  function foldable(button,box,key,changed,column){
   let folded=false;try{folded=localStorage.getItem(key)==='1'}catch{}
   const show=()=>{box.classList.toggle('is-folded',folded);button.setAttribute('aria-expanded',String(!folded));const label=folded?'주행 목록 펼치기':'주행 목록 접기';button.setAttribute('aria-label',label);button.title=label};
   show();
   button.addEventListener('click',()=>{markSeen(column);folded=!folded;show();try{localStorage.setItem(key,folded?'1':'0')}catch{}changed()});
   return ()=>folded;
  }
  // ---- 주행 지도: one drive full screen. The map stays on top (phones) or on the left (wide screens); the drive's
  // segment rows, as in the list, scroll on their own in a sheet below it (or beside it). A row tap marks its segment
  // on the map and fits the map to it; a tap on the map marks the row and scrolls the sheet to it. It is a history
  // entry (#drive-map): the system back, the header's back button and Escape close it.
  const drive=document.getElementById('driveMap'),driveBody=drive.querySelector('.drive-map-body'),driveCanvas=drive.querySelector('.drive-map-canvas'),sheet=drive.querySelector('.drive-map-sheet'),handle=drive.querySelector('.drive-map-handle'),sheetList=drive.querySelector('.drive-map-list');
  // The card columns over the maps fade out at an edge with more cards beyond it (none at the top while scrolled to the
  // top, none at the end). Each card near an edge is masked itself, in the column's coordinates: a mask on the column
  // would make it the cards' backdrop root and take away their blur of the map. As on the replay's segment strip
  // (app.js segmentStripFades), each fade widens with the distance scrolled from that end (full after FADE/2 px) instead
  // of switching on at once. The mask reaches SHADOW px past the card on every side and is not clipped to it
  // (mask-clip:no-clip), so a masked card keeps its drop shadow: it fades with the card instead of vanishing.
  const FADE=28,SHADOW=28;
  const MASK_PROPS=[['maskSize',`calc(100% + ${2*SHADOW}px) calc(100% + ${2*SHADOW}px)`],['maskPosition',`${-SHADOW}px ${-SHADOW}px`],['maskRepeat','no-repeat'],['maskOrigin','border-box'],['maskClip','no-clip']];
  function setMask(card,mask){
   if(card.style.maskImage===mask)return;
   for(const [name,value] of MASK_PROPS){const v=mask?value:'';card.style['webkit'+name[0].toUpperCase()+name.slice(1)]=v;card.style[name]=v}
   card.style.webkitMaskImage=mask;card.style.maskImage=mask;
  }
  function fadeEdges(column){
   let frame=0,watched=new Set();
   const paint=()=>{
    frame=0;const top=Math.max(0,column.scrollTop),h=column.clientHeight,end=Math.max(0,column.scrollHeight-h-top),origin=column.getBoundingClientRect().top+column.clientTop;
    const topFade=Math.min(FADE,top*2),endFade=Math.min(FADE,end*2);
    column.classList.toggle('fade-top',top>1);column.classList.toggle('fade-bottom',end>1);
    column.style.setProperty('--fade-top',topFade.toFixed(1)+'px');column.style.setProperty('--fade-bottom',endFade.toFixed(1)+'px');
    const cards=[...column.children],boxes=cards.map(card=>card.getBoundingClientRect()),px=v=>(v+SHADOW).toFixed(1)+'px';
    // Every card's size is watched: a card that grows or shrinks moves the ones below it, and their masks are in their
    // own coordinates. Without this a mask painted for an earlier place stayed (a card in the middle of the list faded
    // out and the ones under it stayed invisible, as if the list had been cut short).
    {const now=new Set(cards);for(const card of watched)if(!now.has(card))sizes.unobserve(card);for(const card of cards)if(!watched.has(card))sizes.observe(card);watched=now}
    cards.forEach((card,i)=>{
     // A card with its ⋯ menu open is not masked: the mask would cut off the menu where it leaves the card.
     const y=boxes[i].top-origin,still=!card.querySelector('.recording-more[open]'),fadeTop=still&&topFade>.5&&y<topFade,fadeBottom=still&&endFade>.5&&y+boxes[i].height>h-endFade;
     setMask(card,fadeTop||fadeBottom?`linear-gradient(to bottom,${fadeTop?`transparent ${px(-y)},#000 ${px(topFade-y)}`:'#000 0'},${fadeBottom?`#000 ${px(h-endFade-y)},transparent ${px(h-y)}`:'#000 100%'})`:'');
    });
   };
   const later=()=>{if(!frame)frame=requestAnimationFrame(paint)},sizes=new ResizeObserver(later);
   column.addEventListener('scroll',later,{passive:true});
   new ResizeObserver(later).observe(column);
   new MutationObserver(later).observe(column,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','open']});
   return later;
  }
  const DRIVE_HASH='#drive-map',SNAPS=[.36,.54,.7],wide=matchMedia('(min-width:1024px),(min-width:600px) and (orientation:landscape)');
  fadeEdges(sheetList);fadeEdges(document.getElementById('logMapRows'));
  let driveGroup=null,driveMap=null,driveLayer=null,driveLines=new Map(),driveRows=new Map(),driveMarked=null,driveTicket=0,driveOpener=null,restoreDrive=null,escapeTaken=false;
  function openDrive(group,{segment=null,push=true,opener=null}={}){
   const same=drive.open&&driveGroup===group;driveGroup=group;
   if(!same){
    driveMarked=segment;driveRows.clear();sheetList.replaceChildren();syncDrive();sheetList.scrollTop=0;
    if(!drive.open){driveOpener=opener||document.activeElement;drive.showModal();document.body.style.overflow='hidden';driveSheet.set(1,{fit:true})}
    if(push){
     const url=new URL(window.location.href);if(!url.hash||url.hash===DRIVE_HASH){url.hash=libraryTab||'logs';history.replaceState(history.state,'',url)}
     url.hash=DRIVE_HASH;history.pushState({...(history.state||{}),rvScroll:scrollY,rvDrive:group.route.key,rvDriveSegment:segment},'',url);
    }
    drawDrive(segment);
   }else if(segment)markDrive(segment,{fit:true,scroll:true});
  }
  // The header and rows follow the list (polling): only changed rows are rebuilt.
  function syncDrive(){
   const group=driveGroup;if(!group)return;
   const {title,facts}=routeFacts(group);document.getElementById('driveMapTitle').textContent=title;document.getElementById('driveMapFacts').textContent=facts;
   handle.querySelector('.drive-map-count').textContent=`${group.logs.length}개 구간`;
   const logs=[...group.logs].sort((a,b)=>(logRoute(a).segment??0)-(logRoute(b).segment??0)),next=new Map();
   const rows=logs.map(log=>{
    const signature=JSON.stringify(log);let cached=driveRows.get(log.id);
    if(!cached||cached.signature!==signature){const row=renderRow(log,null).row;if(cached)row.classList.add('is-update');cached={row,signature}}
    cached.row.classList.toggle('is-map-marked',log.id===driveMarked);next.set(log.id,cached);return cached.row;
   });
   driveRows=next;reconcileLogs(sheetList,rows);
  }
  async function drawDrive(segment){
   const ticket=++driveTicket,group=driveGroup;
   let L,track;
   try{[L,track]=await Promise.all([loadLeaflet(),fetch(`api/logs/${group.firstLog.id}/track`,{cache:'no-cache'}).then(r=>r.ok?r.json():{segments:[]})])}
   catch(e){if(ticket===driveTicket)error(e.message);return}
   if(ticket!==driveTicket||!drive.open)return;
   if(!driveMap){driveMap=createMap(L,driveCanvas);driveLayer=L.layerGroup().addTo(driveMap);driveMap.on('click',event=>{const line=nearestLine(driveLines.values(),event);if(line)markDrive(line.rvId,{scroll:true});else markDrive(null,{fit:true})})}
   driveLayer.clearLayers();driveLines.clear();
   const colour=css('--accent')||'#3DCB92';
   for(const part of track.segments){
    if(!part.points.length)continue;
    const path=latlngs(part.points),line=L.polyline(path,{color:colour,weight:5,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(driveLayer);
    line.bindTooltip(part.segment===null?'구간':'구간 '+part.segment,{sticky:true,direction:'top'});
    line.on('click',e=>{L.DomEvent.stopPropagation(e);markDrive(part.id,{scroll:true})});
    // Segment boundaries: a small ring where each segment starts.
    L.circleMarker(path[0],{radius:4,color:colour,weight:2,fillColor:css('--panel')||'#fff',fillOpacity:1,interactive:false}).addTo(driveLayer);
    line.rvId=part.id;driveLines.set(part.id,line);
   }
   driveMap.invalidateSize({animate:false});
   if(segment&&driveLines.has(segment))markDrive(segment,{fit:true,scroll:true,animate:false});else{driveMarked=null;paintDrive();fitDrive(false)}
  }
  // The zoom and 단순 지도 buttons' column (top right on phones, moved to the left on wide screens): fits keep clear of it.
  function controlsSide(map){
   const area=map.getContainer().getBoundingClientRect(),box=map.getContainer().querySelector('.leaflet-top.leaflet-right')?.getBoundingClientRect();
   if(!box?.width)return {left:0,right:0};
   return box.left>area.left+area.width/2?{left:0,right:Math.max(0,area.right-box.left)}:{left:Math.max(0,box.right-area.left),right:0};
  }
  function fitDrive(animate=!reduced()){
   if(!driveMap||!window.L)return;const line=driveMarked&&driveLines.get(driveMarked);
   const bounds=line?line.getBounds():[...driveLines.values()].reduce((b,l)=>b.extend(l.getBounds()),window.L.latLngBounds([]));
   // The segments' glass floats over the map (a bottom sheet, or a card on the right on wide screens): fit beside it.
   const area=driveCanvas.getBoundingClientRect(),cover=sheet.getBoundingClientRect();
   const right=wide.matches?(driveFolded()?0:Math.max(0,area.right-cover.left)):0,bottom=wide.matches?0:Math.max(0,area.bottom-cover.top);
   const side=controlsSide(driveMap);
   if(bounds.isValid())driveMap.fitBounds(bounds,{paddingTopLeft:[28+side.left,28],paddingBottomRight:[28+Math.max(right,side.right),28+bottom],maxZoom:line?16:17,animate});
  }
  function paintDrive(){
   for(const [id,line] of driveLines){const on=!driveMarked||id===driveMarked;line.setStyle({opacity:on?.95:.3,weight:id===driveMarked?7:5});if(id===driveMarked)line.bringToFront()}
   for(const [id,cached] of driveRows)cached.row.classList.toggle('is-map-marked',id===driveMarked);
  }
  // The marked segment's glass pill at the bottom of the drive map, shown while its card is out of sight: the list folded
  // away (wide screens) or the sheet hidden (phones). 재생 opens that segment; ✕ clears the mark.
  const segmentCard=document.createElement('div');segmentCard.className='log-map-card drive-map-card';segmentCard.setAttribute('role','status');segmentCard.hidden=true;
  segmentCard.innerHTML='<div class="map-card-text"><b class="map-card-title"></b><span class="map-card-facts"></span></div><div class="map-card-actions"><button type="button" class="map-card-close icon-button" aria-label="선택 해제" title="선택 해제"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>';
  driveBody.append(segmentCard);
  segmentCard.querySelector('.map-card-close').onclick=()=>markDrive(null);
  const driveWait=listWait();
  function syncSegmentCard(){
   const log=driveMarked&&driveGroup?.logs.find(l=>l.id===driveMarked);
   let folded=false;try{folded=driveFolded()}catch{}  // Not yet defined while the screen is being set up.
   // Phones: the pill shows while the cards are away; the class (not the snap) also follows a drag in progress.
   const out=wide.matches?folded:driveBody.classList.contains('is-sheet-hidden'),show=!!log&&drive.open&&out;
   showPill(segmentCard,show,null,driveWait(!out));if(!show)return;
   const n=logRoute(log).segment,date=logDate(log),end=date&&Number.isFinite(log.duration)?new Date(date.getTime()+log.duration*1000):null;
   segmentCard.querySelector('.map-card-title').textContent=`구간 ${n??'—'}`+(date?` · ${shortClock(date)}${end?'–'+shortClock(end):''}`:'');
   segmentCard.querySelector('.map-card-facts').textContent=[Number.isFinite(log.duration)?durationText(log.duration):null,log.status==='ready'?'재생 가능':null].filter(Boolean).join(' · ');
   segmentCard.querySelector('.map-card-play')?.remove();
   if(log.status==='ready'){const play=document.createElement('a');play.className='replay map-card-play';play.dataset.glow='';play.href=`view/${log.id}/`;play.innerHTML=PLAY_ICON;play.append('재생');segmentCard.querySelector('.map-card-actions').prepend(play)}
  }
  function markDrive(id,{fit=false,scroll=false,animate=!reduced()}={}){
   driveMarked=id;paintDrive();if(fit)fitDrive(animate);syncSegmentCard();
   const row=id&&driveRows.get(id)?.row;
   if(scroll&&row)centreRow(sheetList,row);
  }
  // A tap on a row (outside its play button, ⋯ menu and other controls) marks its segment instead of playing it.
  sheetList.addEventListener('click',event=>{
   const row=event.target.closest('.log-row'),control=row&&event.target.closest('a,button,summary,details,input,label');
   if(!row||control&&row.contains(control))return;
   event.stopPropagation();sheetList.querySelectorAll('.recording-more[open]').forEach(more=>{more.open=false});
   markDrive(row.dataset.id,{fit:true,scroll:true});
  });
  // A phone bottom sheet over a map (the drive map's segments, the all-drives list): its handle drags it between the snap
  // heights (a tap or the arrow keys step through them). Dragged (or stepped) below the lowest height, the cards slide
  // away down and only the handle stays (snap -1); a tap brings them back. body carries is-sheet-hidden, is-dragging and
  // --sheet-h; changed() runs whenever is-sheet-hidden may have changed (mid-drag too), settled(fit) once the sheet has
  // moved (only while ready()). Wide screens leave the handle alone.
  function bottomSheet(body,sheet,handle,{changed,settled,ready,column}){
   let snap=1,refit=0,dragged=false;
   const handleOnly=()=>Math.ceil(handle.getBoundingClientRect().height+18)+'px';
   // Put away from a shown height, the sheet keeps that height and slides down until only the handle shows
   // (is-sheet-down, library.css: no layout per frame). --sheet-top is where its top edge ends up (the pill rides on it).
   // After a drag that hid the cards the sheet is as short as the finger left it: it shrinks to the handle and rest()
   // then swaps it, unseen, for a full sheet slid down, so the next tap slides it up as well.
   const down=()=>body.classList.contains('is-sheet-down'),top=value=>body.style.setProperty('--sheet-top',value);
   let resting=0;
   function rest(){
    if(!body.classList.contains('is-sheet-hidden')||down()||body.classList.contains('is-dragging'))return;
    body.classList.add('is-settling');body.style.setProperty('--sheet-h',SNAPS[1]*100+'%');body.classList.add('is-sheet-down');void sheet.offsetWidth;body.classList.remove('is-settling');
   }
   function set(i,{fit=false}={}){
    snap=Math.max(-1,Math.min(SNAPS.length-1,i));const hidden=snap<0,was=body.classList.contains('is-sheet-hidden');
    clearTimeout(resting);
    if(!wide.matches&&hidden!==was)markSeen(column,hidden||down()?null:SNAPS[snap]*body.clientHeight);
    body.style.setProperty('--sheet-peek',handleOnly());
    if(!hidden){body.classList.remove('is-sheet-down');body.style.setProperty('--sheet-h',SNAPS[snap]*100+'%')}
    else if(!was)body.classList.add('is-sheet-down');
    else if(!down()){body.style.setProperty('--sheet-h',handleOnly());resting=setTimeout(rest,reduced()?0:320)}
    body.classList.toggle('is-sheet-hidden',hidden);top(hidden?handleOnly():SNAPS[snap]*100+'%');
    handle.setAttribute('aria-valuenow',String(hidden?0:Math.round(SNAPS[snap]*100)));changed();handle.setAttribute('aria-valuetext',hidden?'숨김':Math.round(SNAPS[snap]*100)+'%');
    // Raising or lowering the sheet keeps the map where it is: only a tap on a card moves it. Opening the screen (fit)
    // still fits once the sheet has risen, beside its final height.
    clearTimeout(refit);if(ready())refit=setTimeout(()=>settled(fit),reduced()?0:300);
   }
   handle.addEventListener('pointerdown',event=>{
    if(wide.matches||event.button>0)return;
    event.preventDefault();dragged=false;try{handle.setPointerCapture(event.pointerId)}catch{}
    const startY=event.clientY,startH=down()?parseFloat(handleOnly()):sheet.getBoundingClientRect().height,total=body.clientHeight;let moved=false;
    body.classList.add('is-dragging');
    const floor=parseFloat(handleOnly());
    const move=e=>{const dy=e.clientY-startY;if(Math.abs(dy)>4)moved=true;if(!moved)return;const h=Math.max(floor,Math.min(SNAPS.at(-1)*total,startH-dy));
     clearTimeout(resting);body.classList.remove('is-sheet-down');  // dragged, the sheet follows the finger by its height
     body.style.setProperty('--sheet-h',h+'px');top(h+'px');
     // The cards coming back (or going away) mid-drag: the pill leaves (or returns) right then, not on release.
     const hide=h<SNAPS[0]*total*.6;if(hide!==body.classList.contains('is-sheet-hidden')){markSeen(column,hide?null:SNAPS.at(-1)*total);body.classList.toggle('is-sheet-hidden',hide);changed()}};
    const end=()=>{
     handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
     body.classList.remove('is-dragging');
     if(!moved)return;  // a tap: the click that follows toggles (see below)
     dragged=true;
     const share=sheet.getBoundingClientRect().height/total;if(share<SNAPS[0]*.6){set(-1);return}
     let best=0;SNAPS.forEach((value,i)=>{if(Math.abs(value-share)<Math.abs(SNAPS[best]-share))best=i});set(best);
    };
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
   });
   // A tap (or Enter/Space) folds and unfolds like a disclosure: hidden -> the middle height, shown at any height -> hidden.
   // Dragging still settles on any of the three heights; the arrow keys still step through them.
   // The tap acts on its click, not on the finger's release: toggled on release, the sheet moved away first and the click
   // then landed on the map under the finger, which cleared the selection. The click that ends a drag is ignored.
   function toggle(){set(snap<0?1:-1)}
   handle.addEventListener('click',()=>{if(dragged){dragged=false;return}if(!wide.matches)toggle()});
   handle.addEventListener('keydown',e=>{const step={ArrowUp:1,ArrowDown:-1}[e.key];if(step&&!wide.matches){e.preventDefault();set(snap+step)}});
   return {set};
  }
  const driveSheet=bottomSheet(driveBody,sheet,handle,{column:sheetList,changed:()=>syncSegmentCard(),ready:()=>!!driveMap,
   settled:fit=>{if(drive.open){driveMap.invalidateSize({animate:false});if(fit)fitDrive(false)}}});
  const driveFolded=foldable(driveBody.querySelector('.drive-map-fold'),driveBody,'roadviewer-drive-list-folded',()=>syncSegmentCard(),sheetList);  // Folding keeps the map where it is.
  // Closing goes through history, so the system back, the header's back button and Escape all end the same way.
  function closeDrive(){if(!drive.open)return;if(window.location.hash===DRIVE_HASH&&history.state?.rvDrive)history.back();else finishDrive()}
  // Focus goes back to what opened it right away (not on the later close event, which could take it from a field).
  function finishDrive(){driveTicket++;if(!drive.open)return;const opener=driveOpener;driveOpener=null;drive.close();if(opener?.isConnected)opener.focus({preventScroll:true})}
  document.getElementById('driveMapBack').onclick=closeDrive;
  drive.addEventListener('keydown',e=>{if(e.key==='Escape')escapeTaken=!!(drive.querySelector('.recording-more[open]')||document.querySelector('.tag-popover'))},true);
  drive.addEventListener('cancel',e=>{e.preventDefault();if(!escapeTaken)closeDrive();escapeTaken=false});
  drive.addEventListener('close',()=>{
   document.body.style.overflow='';driveGroup=null;driveMarked=null;
   if(window.location.hash===DRIVE_HASH){const url=new URL(window.location.href);url.hash=libraryTab||'logs';history.replaceState({...history.state,rvDrive:null},'',url)}
   driveOpener=null;
  });
  window.addEventListener('popstate',()=>{
   if(drive.open&&window.location.hash!==DRIVE_HASH)finishDrive();
   else if(!drive.open&&window.location.hash===DRIVE_HASH)restore();
  });
  // Reloaded or come back (from a replay) to #drive-map: the drive opens again once the list knows it.
  function restore(){
   const key=history.state?.rvDrive,group=key&&logGroups.get(key);
   if(group&&groupRoute(group)){restoreDrive=null;selectTab('logs',{hash:false});openDrive(group,{segment:history.state.rvDriveSegment,push:false});return}
   if(tracks||!key){restoreDrive=null;const url=new URL(window.location.href);url.hash=libraryTab||'logs';history.replaceState({...history.state,rvDrive:null},'',url)}
  }
  if(window.location.hash===DRIVE_HASH)restoreDrive=restore;
  // ⋯ › 지도에서 보기: the drive's map with this segment marked.
  function showSegment(id){
   const group=[...logGroups.values()].find(group=>group.logs.some(log=>log.id===id));if(!group)return;
   openDrive(group,{segment:id});
  }
  // ① 목록 | 지도
  // Phones: the map reaches from where it starts (the page scrolled to the top) down to just above the bottom tab bar,
  // whatever sits above it (the Home Assistant app's own header, the search, the filter chips); a fixed allowance left a
  // tall device (a Fold) with a short map and empty space under it.
  // A short screen (a Fold's inner one, 670px tall) left only the 320px minimum under the title, search and chips: there the
  // map is as tall as the screen allows with the filter chips kept above it: scrolled until the chips reach the app bar,
  // it ends just above the tab bar. The page is not scrolled for the user. The chips stay because they filter the map
  // and are where a finger can still scroll the page: a map covering the whole screen takes every drag for itself.
  function fitPanelHeight(){
   if(panel.hidden||wide.matches){panel.style.removeProperty('--map-room');return}
   const tabs=document.querySelector('.lib-tabs'),bar=tabs?.getBoundingClientRect(),bottom=bar&&getComputedStyle(tabs).position==='fixed'&&bar.top>innerHeight/2?bar.top:innerHeight;
   const top=panel.getBoundingClientRect().top+window.scrollY,room=bottom-top-12;
   const chips=document.getElementById('logChips'),appbar=document.querySelector('.lib-appbar');
   const head=appbar&&['sticky','fixed'].includes(getComputedStyle(appbar).position)?appbar.getBoundingClientRect().height:0;
   const lift=room<440&&chips?Math.max(0,Math.round(chips.getBoundingClientRect().top+window.scrollY-head-8)):0;
   panel.style.setProperty('--map-room',Math.round(Math.max(320,room+lift))+'px');
  }
  addEventListener('resize',()=>{if(mode==='map')fitPanelHeight()});
  function setMode(next){
   mode=next;for(const button of switcher.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.view===mode));
   document.getElementById('list').hidden=mode==='map';panel.hidden=mode!=='map';
   if(mode==='map')fitPanelHeight();
   if(mode==='map'){document.getElementById('empty').hidden=true;listSheet.set(1);drawOverview(true)}else{card.rvPill=(card.rvPill||0)+1;card.classList.remove('is-leaving');card.hidden=true;selected=null;applyFilters()}
   try{sessionStorage.setItem('roadviewer-log-view',mode)}catch{}
  }
  switcher.addEventListener('click',e=>{const button=e.target.closest('button[data-view]');if(button&&button.dataset.view!==mode)setMode(button.dataset.view)});
  const visibleGroups=()=>[...logGroups.values()].filter(group=>!group.element.hidden&&group.element.closest('.log-day')&&!group.element.closest('.log-day').hidden);
  let overviewFit=true,hovered=null,rowsKey='';
  const mapList=document.getElementById('logMapList'),mapRows=document.getElementById('logMapRows'),mapRow=new Map();  // route key -> row
  const listFolded=foldable(panel.querySelector('.map-fold'),panel,'roadviewer-map-list-folded',()=>{select(selected,{fit:false})},mapRows);  // Folding keeps the map where it is.
  // Phones: the cards are a bottom sheet like the drive map's (its handle shows the count); moving it keeps the map put.
  const listHandle=mapList.querySelector('.log-map-handle');
  const listSheet=bottomSheet(panel,mapList,listHandle,{column:mapRows,changed:()=>{if(mode==='map')select(selected)},ready:()=>!!overview,
   settled:()=>{if(mode==='map')overview.invalidateSize({animate:false})}});
  // The cards are in sight: the list card unfolded (wide screens) or the sheet up (phones; the class follows a drag too).
  const listShown=()=>wide.matches?!listFolded():!panel.classList.contains('is-sheet-hidden');
  // Fits beside the list card while it is shown (wide screens), above the sheet (phones).
  function overviewPadding(){
   const area=canvas.getBoundingClientRect(),cover=mapList.getBoundingClientRect();
   const right=wide.matches&&listShown()?Math.max(0,area.right-cover.left):0,bottom=wide.matches?0:Math.max(0,area.bottom-cover.top);
   const side=overview?controlsSide(overview):{left:0,right:0};
   return {paddingTopLeft:[28+side.left,28],paddingBottomRight:[28+Math.max(right,side.right),28+bottom]};
  }
  function fitOverview(group,animate=!reduced()){
   const line=overviewLines.get(groupRoute(group)?.key);
   if(line&&overview)overview.fitBounds(line.getBounds(),{...overviewPadding(),maxZoom:16,animate});
  }
  // The rows are plain buttons, rebuilt only when the drives on the map change (content-visibility skips the ones
  // out of view, so hundreds stay cheap).
  function drawRows(shown){
   const key=shown.map(item=>item.route.key).join('|');
   mapList.querySelector('.log-map-list-count').textContent=`${shown.length}개`;listHandle.querySelector('.drive-map-count').textContent=`주행 목록 ${shown.length}개`;
   if(key===rowsKey)return;rowsKey=key;mapRow.clear();
   mapRows.replaceChildren(...shown.map(({group,route},i)=>{
    const row=document.createElement('div'),pick=document.createElement('button'),title=document.createElement('b'),facts=document.createElement('span'),info=routeFacts(group);
    row.className='map-list-row';row.setAttribute('role','listitem');row.dataset.color=PALETTE[i%PALETTE.length];row.rvGroup=group;
    pick.type='button';pick.className='map-list-pick';pick.dataset.noRipple='';title.textContent=info.title;facts.textContent=info.facts;pick.append(title,facts);
    row.append(pick);mapRow.set(route.key,row);return row;
   }));
  }
  mapRows.addEventListener('click',event=>{const row=event.target.closest('.map-list-pick')?.parentElement;if(row)select(row.rvGroup,{fit:true,scroll:true})});
  mapRows.addEventListener('pointerover',event=>{if(event.pointerType!=='mouse')return;const group=event.target.closest('.map-list-row')?.rvGroup||null;if(group!==hovered){hovered=group;paintOverview()}});
  mapRows.addEventListener('pointerleave',()=>{if(hovered){hovered=null;paintOverview()}});
  wide.addEventListener('change',()=>{if(mode==='map')select(selected)});
  wide.addEventListener('change',()=>syncSegmentCard());
  async function drawOverview(fit){
   if(fit)overviewFit=true;
   if(!tracks){empty.hidden=true;return}
   let L;try{L=await loadLeaflet()}catch(e){error(e.message);return}
   if(mode!=='map')return;
   if(!overview){overview=createMap(L,canvas);overview.on('click',event=>{const line=nearestLine(overviewLines.values(),event);if(line)select(line.rvGroup,{scroll:true});else select(null)})}
   const shown=visibleGroups().map(group=>({group,route:groupRoute(group)})).filter(item=>item.route&&item.route.points.length>1);
   const keys=new Set(shown.map(item=>item.route.key));
   for(const [key,line] of overviewLines)if(!keys.has(key)){line.rvCasing?.remove();line.remove();overviewLines.delete(key)}
   const bounds=L.latLngBounds([]);
   shown.forEach(({group,route},i)=>{
    let line=overviewLines.get(route.key);
    if(!line){const casing=L.polyline(route.points,{weight:7,opacity:.5,lineCap:'round',lineJoin:'round',interactive:false}).addTo(overview);line=L.polyline(route.points,{weight:4,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(overview);line.rvCasing=casing;line.on('click',e=>{L.DomEvent.stopPropagation(e);select(line.rvGroup,{scroll:true})});overviewLines.set(route.key,line)}
    else if(line.rvPoints!==route.points){line.setLatLngs(route.points);line.rvCasing?.setLatLngs(route.points)}
    line.rvPoints=route.points;line.rvGroup=group;line.rvRoute=route;line.rvIndex=i;bounds.extend(route.points);
   });
   drawRows(shown);
   if(selected&&!shown.some(item=>item.group===selected))select(null);else select(selected);
   empty.hidden=!!shown.length;
   if(overviewFit&&bounds.isValid()){overviewFit=false;overview.invalidateSize({animate:false});overview.fitBounds(bounds,{...overviewPadding(),animate:false,maxZoom:15})}
  }
  // A hovered row's drive (wide screens) shows over the selected one.
  function paintOverview(){
   const focus=hovered||selected;
   for(const line of overviewLines.values()){
    const on=!focus||line.rvGroup===focus,w=line.rvGroup===focus?6:4;line.setStyle({color:tagColor(line.rvIndex),opacity:on?.95:.22,weight:w});
    line.rvCasing?.setStyle({color:casingColor(),opacity:on?.55:.12,weight:w+3});
    if(line.rvGroup===focus){line.rvCasing?.bringToFront();line.bringToFront()}
   }
  }
  redrawColours=()=>{if(overview)paintOverview();const colour=css('--accent');for(const line of driveLines.values())line.setStyle({color:colour})};
  // The selected drive's actions: in its row while the cards are in sight (the list card, the phone sheet up), else in
  // the bottom card.
  const overviewWait=listWait();
  function select(group,{fit=false,scroll=false}={}){
   const from=mapRows.scrollTop;
   selected=group;paintOverview();
   const wait=overviewWait(listShown()),inline=!!group&&listShown(),row=group&&mapRow.get(groupRoute(group)?.key);
   // A redraw (the list polls) keeps the selected row's buttons, and with them the focus.
   for(const other of mapRows.querySelectorAll('.map-list-row.is-selected,.map-list-row:has(>.map-card-actions)'))if(other!==row||!inline){other.classList.remove('is-selected');other.querySelector(':scope>.map-card-actions')?.remove()}
   showPill(card,!!group&&!inline,()=>{if(card.hidden)card.querySelector('.map-card-play')?.remove()},wait);
   if(fit&&group)fitOverview(group);
   if(row){
    row.classList.add('is-selected');
    if(inline&&!row.querySelector(':scope>.map-card-actions'))row.append(rowActions(group));
    if(scroll)centreRow(mapRows,row,from);
   }
   if(!group||inline){if(card.hidden)card.querySelector('.map-card-play')?.remove();return}  // else once it has sunk out
   const route=groupRoute(group),date=logDate(group.firstLog),duration=group.logs.reduce((sum,log)=>sum+(Number.isFinite(log.duration)?log.duration:0),0);
   card.querySelector('.map-card-title').textContent=date?`${localeDate(date)} ${clockText(date)}`:group.route.title;
   card.querySelector('.map-card-facts').textContent=[kmText(route?.distance_m),duration?durationText(duration):null,`${group.logs.length}개 구간`].filter(Boolean).join(' · ');
   // 재생 exists only while a drive is shown (the list counts its .replay links).
   card.querySelector('.map-card-play')?.remove();const ready=firstReady(group);
   if(ready){const play=document.createElement('a');play.className='replay map-card-play';play.dataset.glow='';play.href=`view/${ready.id}/`;play.innerHTML=PLAY_ICON;play.append('재생');card.querySelector('.map-card-actions').prepend(play)}
   card.dataset.color=PALETTE[(overviewLines.get(route?.key)?.rvIndex||0)%PALETTE.length];
  }
  const playLink=group=>{const ready=firstReady(group);if(!ready)return null;const play=document.createElement('a');play.className='replay map-card-play';play.dataset.glow='';play.href=`view/${ready.id}/`;play.innerHTML=PLAY_ICON;play.append('재생');return play};
  function rowActions(group){
   const box=document.createElement('div'),button=(text,run)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=run;return b};
   box.className='map-card-actions';const play=playLink(group);if(play)box.append(play);
   const driveButton=button('주행 지도',event=>openDrive(group,{opener:event.currentTarget}));driveButton.setAttribute('aria-haspopup','dialog');
   box.append(driveButton,button('목록에서 보기',()=>showInList(group)));return box;
  }
  card.querySelector('.map-card-list').onclick=()=>showInList(selected);
  function showInList(group){
   setMode('list');if(!group)return;
   // Centred, or its top near the top of the screen when the card is taller than the screen (an open drive). The list is
   // drawn again as it comes back and rows above can still change height (thumbnails, route shapes), so the drive is
   // brought back twice more if its top ended up off screen, unless the user has scrolled since.
   const target=group.element;let touched=false;const stop=()=>{touched=true};
   for(const type of ['wheel','touchstart','keydown','pointerdown'])addEventListener(type,stop,{once:true,passive:true,capture:true});
   const block=()=>target.getBoundingClientRect().height>innerHeight*.8?'start':'center';
   const again=()=>{if(touched||!target.isConnected)return;const r=target.getBoundingClientRect();if(r.top<0||r.top>=innerHeight)target.scrollIntoView({block:block()})};
   requestAnimationFrame(()=>{target.scrollIntoView({block:block(),behavior:reduced()?'auto':'smooth'});target.classList.remove('is-located');void target.offsetWidth;target.classList.add('is-located');
    setTimeout(again,reduced()?150:450);setTimeout(()=>{again();for(const type of ['wheel','touchstart','keydown','pointerdown'])removeEventListener(type,stop,{capture:true})},reduced()?600:1000)});
  }
  card.querySelector('.map-card-close').onclick=()=>select(null);
  card.querySelector('.map-card-drive').onclick=event=>{if(selected)openDrive(selected,{opener:event.currentTarget})};
  window.rvMaps={listed,filtered:()=>{if(mode==='map')drawOverview(false)},showSegment,mode:()=>mode};
  {let saved=null;try{saved=sessionStorage.getItem('roadviewer-log-view')}catch{}if(saved==='map')setMode('map')}
 }

 if(replay){
  // ---- ③ 주행 상황 | 지도 and ④ the small map over the video.
  const id=location.pathname.split('/').filter(Boolean).at(-1);
  const mapTab=document.getElementById('mapTab'),view=document.getElementById('routeMapView'),follow=document.getElementById('mapFollow'),mini=document.getElementById('videoMap'),miniToggle=document.getElementById('videoMiniMap');
  // 작은 지도 색상: 자동 (app theme) | 라이트 | 다크, kept on this browser.
  const toneSwitch=document.getElementById('videoMiniMapTone'),TONE_KEY='roadviewer-minimap-tone';
  let miniTone='auto';try{const saved=localStorage.getItem(TONE_KEY);if(['auto','light','dark'].includes(saved))miniTone=saved}catch{}
  const showTone=()=>{for(const b of toneSwitch.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.tone===miniTone))};showTone();
  toneSwitch.addEventListener('click',event=>{const b=event.target.closest('button[data-tone]');if(!b||b.dataset.tone===miniTone)return;miniTone=b.dataset.tone;showTone();try{localStorage.setItem(TONE_KEY,miniTone)}catch{}for(const map of maps)if(map.getContainer().closest('#videoMap'))applyTiles(map)});
  // 글자 없는 지도: the small map without place and road names (the style's symbol layers hidden); saved with the
  // other display preferences (app.js, .overlay-settings-body inputs).
  const miniPlain=document.getElementById('videoMiniMapPlain'),miniGrey=document.getElementById('videoMiniMapGrey');
  for(const box of [miniPlain,miniGrey])box.addEventListener('change',()=>{for(const map of maps)if(map.getContainer().closest('#videoMap'))applyTiles(map)});
  let route=null,current=-1,big=null,small=null,lastKey='',following=true,mode='road';
  // A seek asked from another segment's map: applied once this segment's replay is ready.
  try{
   const seek=JSON.parse(sessionStorage.getItem('rv-map-seek')||'null');
   if(seek?.id===id&&Number.isFinite(seek.t)){
    sessionStorage.removeItem('rv-map-seek');const started=performance.now();
    const wait=setInterval(()=>{if(typeof data!=='undefined'&&data&&!loading){clearInterval(wait);setTime(seek.t)}else if(performance.now()-started>30000)clearInterval(wait)},100);
   }
  }catch{}
  // Asked only for a log the list marks has_track (app.js loadLogNavigation hands it over): no request otherwise.
  let asked=false;
  window.rvMaps={replayLog(log){if(asked||!log?.has_track||log.id!==id)return;asked=true;
  fetch(`../../api/logs/${id}/track`,{cache:'no-cache'}).then(r=>r.ok?r.json():null).then(value=>{
   if(!value?.segments?.length)return;
   route=value.segments.filter(segment=>segment.points.length);current=route.findIndex(segment=>segment.id===id);
   if(current<0)return;  // This segment has no GPS: no map (its drive's other segments are not this replay).
   // The 지도 tab appears once this segment has a track; a saved 지도 tab (telemetry.js fell back to 주행 상황) returns.
   mapTab.hidden=false;let saved=null;try{saved=localStorage.getItem('roadviewer-analysis-tab')}catch{}
   if(saved==='map')window.selectAnalysisTab?.('map',false);syncMini();
  }).catch(()=>{});
  }};
  function setMode(next){
   mode=next;
   if(mode==='map')ensureBig();else render?.();
   syncMini();
  }
  window.addEventListener('rv:analysistab',e=>{const next=e.detail==='map'?'map':'road';if(next!==mode)setMode(next)});
  // Position at replay time t: between this segment's 1 Hz points. A held sample (the receiver repeating its last fix
  // once while the car moves) is passed over, so the car does not stop for a second and then jump twice as far. The
  // heading turns between the two samples' bearings the short way round (each from the receiver, or the path itself
  // where it gave none).
  const same=(p,q)=>!!p&&!!q&&p[1]===q[1]&&p[2]===q[2];
  const held=(points,j)=>j>0&&j<points.length-1&&same(points[j-1],points[j])&&!same(points[j-2],points[j-1])&&!same(points[j],points[j+1])&&!(Number.isFinite(points[j][3])&&points[j][3]<.5);
  function heading(points,j){
   const p=points[j];if(Number.isFinite(p[4]))return p[4];
   const [from,to]=j<points.length-1&&!same(p,points[j+1])?[p,points[j+1]]:[points[Math.max(0,j-1)],p];
   return same(from,to)?null:Math.atan2((to[2]-from[2])*Math.cos(p[1]*Math.PI/180),to[1]-from[1])*180/Math.PI;
  }
  function position(time){
   const points=route[current].points;let i=0;
   while(i<points.length-1&&points[i+1][0]<=time)i++;
   let from=i,to=Math.min(i+1,points.length-1);
   if(held(points,to))to++;else if(held(points,from))from--;
   const a=points[from],b=points[to],span=b[0]-a[0],k=span>0?Math.max(0,Math.min(1,(time-a[0])/span)):0;
   const lat=a[1]+(b[1]-a[1])*k,lon=a[2]+(b[2]-a[2])*k,ha=heading(points,from),hb=heading(points,to);
   const bearing=ha!==null&&hb!==null?ha+(((hb-ha)%360+540)%360-180)*k:ha??hb??0;
   return {latlng:[lat,lon],bearing:Number.isFinite(bearing)?(bearing%360+360)%360:0,index:i,k,from,to};
  }
  const carIcon=L=>L.divIcon({className:'map-car',html:'<span class="map-car-body"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3 19 20 12 16 5 20Z"/></svg></span>',iconSize:[28,28],iconAnchor:[14,14]});
  // The drive's lines: this log's segment solid, the drive's other segments faded. Only the large map seeks on a tap
  // (interactive).
  function layers(L,map,interactive=true){
   const shown=css('--accent')||'#3DCB92',rest=css('--muted')||'#9AA0A9',lines={others:[]};
   route.forEach((segment,i)=>{
    if(i===current)return;
    const line=L.polyline(latlngs(segment.points),{color:rest,weight:5,opacity:.45,lineCap:'round',lineJoin:'round',interactive}).addTo(map);
    if(interactive)line.on('click',e=>seekTo(e.latlng));lines.others.push(line);
   });
   // The current segment, drawn whole once (draw), on top of the others. Kept unclipped and unsimplified, so the drawn
   // points are the samples and never change under the car.
   lines.current=L.polyline([],{noClip:true,smoothFactor:0,lineCap:'round',lineJoin:'round',interactive,color:shown,weight:6,opacity:.95,className:'map-current'}).addTo(map);
   if(interactive)lines.current.on('click',e=>seekTo(e.latlng));
   lines.car=L.marker([0,0],{icon:carIcon(L),interactive:false,keyboard:false}).addTo(map);
   return lines;
  }
  async function ensureBig(){
   if(big||!route)return;
   const L=await loadLeaflet().catch(e=>{showError(e.message);return null});if(!L||big)return;
   const map=createMap(L,view.querySelector('.route-map-canvas'),{margin:BIG_MARGIN});big={map,lines:layers(L,map)};
   const bounds=L.latLngBounds(route.flatMap(segment=>latlngs(segment.points)));
   map.fitBounds(bounds,{padding:[24,24],animate:false,maxZoom:17});
   map.on('dragstart',()=>setFollow(false));watchView(big);lastKey='';update(true);
   map.rvHold=()=>!!big?.held;map.on('dragstart',()=>{big.held=true;big.anchor=dragAnchor(map)}).on('move',()=>dragMove(big)).on('moveend',()=>{if(big.held){big.held=false;recentre(big)}});
   map.on('zoomstart',()=>{if(performance.now()<(big.eager||0))narrow(big)}).on('zoomstart zoom zoomend',()=>{if(map.rvNarrow)narrow(big)});
   // A touch, click, wheel or key on the map first folds the scroll into Leaflet's own view (one pan, the translate
   // back under a pixel), and for a moment after it the map pans by every whole pixel again: a drag, a zoom (buttons,
   // pinch, wheel, keys) and a tap's place (seeking on a line) then work on what is shown.
   const box=map.getContainer();
   // A zoom by hand (two fingers, the wheel, the buttons, +/-, a box zoom; a double tap or click through zoomstart)
   // narrows the margin first, before Leaflet's own handlers.
   for(const type of ['pointerdown','touchstart','mousedown','wheel','keydown','dblclick'])box.addEventListener(type,e=>{if(e.touches)big.touches=e.touches.length;if(zoomInput(e))narrow(big);big.eager=performance.now()+800;settle(big)},{capture:true,passive:true});
   for(const type of ['touchmove','touchend','touchcancel'])box.addEventListener(type,e=>{big.touches=e.touches.length;if(type==='touchmove'&&e.touches.length>=2&&map.rvNarrow)narrow(big)},{capture:true,passive:true});
  }
  // A zoom (buttons, wheel, pinch) is left to Leaflet; following picks up again when it ends, and after a resize.
  // The basemap's sub-pixel alignment also follows Leaflet's own moves (a drag with 따라가기 off, a zoom, a resize).
  function watchView(target){target.map.on('zoomstart',()=>{target.zooming=true}).on('zoomend',()=>{target.zooming=false;lastKey=''}).on('resize',()=>{target.eager=performance.now()+300;lastKey=''}).on('move zoomend resize',()=>alignBasemap(target))}
  async function ensureSmall(){
   if(small||!route)return;
   const L=await loadLeaflet().catch(()=>null);if(!L||small)return;
   const map=createMap(L,mini.querySelector('.video-map-canvas'),{margin:SMALL_MARGIN,zoom:false,interactive:false,tone:()=>miniTone==='auto'?null:miniTone,labels:()=>!miniPlain.checked,grey:()=>miniGrey.checked,attribution:SHORT_ATTRIBUTION});
   small={map,lines:layers(L,map,false)};watchView(small);fitSmall();
   // Refit when the map or the speed and wheel over it change size (the speed appears once the replay has data).
   {const watch=new ResizeObserver(()=>{if(small&&!mini.hidden&&!resizing)fitSmall()});watch.observe(mini);watch.observe(hud)}
  }
  // The small map always follows the car at a fixed street zoom, the car centred across and a little below the middle
  // (60% down: clear of the speed over the top, more road ahead).
  function fitSmall(){
   if(!small||mini.hidden)return;
   small.map.invalidateSize({animate:false});
   const first=route[current].points[0];if(first)small.map.setView([first[1],first[2]],SMALL_ZOOM,{animate:false});
   lastKey='';update(true);
  }
  const SMALL_ZOOM=16,CAR_Y=.6;
  // Following (the small map always, the 지도 tab with 따라가기) scrolls what is already drawn: the basemap and the lines
  // are drawn a margin beyond each edge, and the car's movement is a translate of the map pane (the basemap, the lines
  // and the car move together, sub-pixel, on the compositor), with no pan and no redraw. Only once the car has gone
  // RECENTRE of the margin (either way) is the map panned once by the whole pixels and the basemap re-centred and drawn
  // in the same frame (MapLibre's synchronous redraw), the translate falling back under a pixel: what is shown does not
  // move. At 45 km/h (zoom 16, ~7 px/s) that is one redraw every 5-7 s instead of one per pixel (7-9 a second).
  // The margins, a share of the size per side: memory buys fewer redraws (speed first). Both maps draw a full size
  // beyond each edge, (1+2*1)^2 = 9x the shown area (~1100 px a side for the small map and ~2300 for the 지도 tab on a
  // phone, tens of MB), so following redraws about every 10 s (small map) or 20 s (지도 tab) at 45 km/h. A hand zoom
  // redraws the whole canvas each frame, so the 지도 tab narrows the margin for it (narrow); a hand drag scrolls what is
  // drawn like following (dragMove). createMap lowers the margin where the canvas would pass GL_SIDE (large maps on
  // tablets and desktops).
  const SMALL_MARGIN=1,BIG_MARGIN=1,RECENTRE=.65;
  // eager (and for a moment after an input or a resize): pan by every whole pixel, Leaflet's own view kept on what is shown.
  function followCar(target,latlng,share,eager=performance.now()<(target.eager||0)){
   const {map}=target,pane=map.getPane('mapPane'),size=map.getSize(),reach=eager?0:RECENTRE*map.rvMargin;
   const at=()=>map.project(latlng,map.getZoom())._subtract(map.getPixelOrigin())._add(window.L.DomUtil.getPosition(pane));
   let p=at(),dx=p.x-size.x/2,dy=p.y-size.y*share;target.follow={latlng,share};
   if(Math.abs(dx)>Math.max(.5,reach*size.x)||Math.abs(dy)>Math.max(.5,reach*size.y)){
    map.panBy([Math.round(dx),Math.round(dy)],{animate:false});redrawBasemap(map);p=at();dx=p.x-size.x/2;dy=p.y-size.y*share;
   }
   shiftPane(target,`${(-dx).toFixed(3)}px ${(-dy).toFixed(3)}px`);alignBasemap(target);
  }
  // The basemap exactly under the lines, by a sub-pixel translate of its canvas: the plugin puts the canvas on a whole
  // pixel, though its margin (a share of the size) can end in a half, and centres MapLibre on getCenter(), which until
  // the first pan after a setView or a zoom is the centre asked for, not the one Leaflet drew from (its pixel origin is
  // rounded). With a pan on every pixel neither showed; scrolling for seconds between pans, both would.
  function alignBasemap(target,force=false){
   const {map}=target,box=map.rvGlLayer?.getContainer?.();if(!box||(target.held&&!force))return;  // held: what is drawn moves with the pane
   const size=map.getSize(),zoom=map.getZoom(),p=map.containerPointToLayerPoint([0,0]).subtract(size.multiplyBy(map.rvGlLayer.options.padding));
   const c=map.project(map.getCenter(),zoom).subtract(map.getPixelOrigin()).subtract(map.containerPointToLayerPoint(size.divideBy(2)));
   const value=`${(p.x-Math.round(p.x)+c.x).toFixed(3)}px ${(p.y-Math.round(p.y)+c.y).toFixed(3)}px`;
   if(target.align!==value){target.align=value;box.style.translate=value}
  }
  // Leaflet's view brought to what is shown (the translate back under a pixel).
  function settle(target){if(target.follow&&target.shift&&!target.zooming&&(target===small||following))followCar(target,target.follow.latlng,target.follow.share,true)}
  function shiftPane(target,value){if(target.shift===value)return;target.shift=value;target.map.getPane('mapPane').style.translate=value}
  function redrawBasemap(map,force=false){  // Still loading: MapLibre draws on its own frame.
   const layer=map.rvGlLayer,zooming=layer?._zooming;
   try{if(force&&layer)layer._zooming=false;layer?._update?.();map.rvGl?.redraw?.()}catch{}finally{if(layer)layer._zooming=zooming}
  }
  // A hand zoom on the 지도 tab (pinch, wheel, double tap, +/-, the buttons, a box zoom) redraws the whole basemap canvas
  // every frame, its cost following the canvas's area (a full margin each side: 9x the shown area, ~70 ms a frame on a
  // phone). From the gesture's start until ZOOM_HOLD after its last input (and Leaflet's zoom animation) the margin is
  // the default 0.1, then the full margin again: each a single resize and redraw, the shown area unmoved.
  const ZOOM_HOLD=1000,ZOOM_KEYS=new Set(['+','=','-','_']);
  const zoomInput=e=>e.type==='wheel'||e.type==='dblclick'||(e.type==='touchstart'&&e.touches.length>=2)||(e.type==='keydown'&&ZOOM_KEYS.has(e.key))||
   (e.type==='mousedown'&&e.shiftKey)||(e.type==='pointerdown'&&!!e.target?.closest?.('.leaflet-control-zoom'));
  function narrow(target){
   const {map}=target;clearTimeout(target.widen);target.widen=setTimeout(()=>widen(target),ZOOM_HOLD);
   if(map.rvNarrow||map._animatingZoom)return;map.rvNarrow=true;setMargin(target);
  }
  function widen(target){
   const {map}=target;
   if(target.zooming||map._animatingZoom||target.held||target.touches>=2){target.widen=setTimeout(()=>widen(target),ZOOM_HOLD/4);return}
   if(map.rvNarrow){map.rvNarrow=false;setMargin(target)}
  }
  // The basemap's and the lines' margin set again (createMap's fit), the canvas resized and drawn once around the view.
  function setMargin(target){
   const {map}=target,layer=map.rvGlLayer;map.rvFitMargin?.();
   try{if(layer?._container&&layer._glMap){layer._resizeContainer();layer._glMap.resize()}}catch{}
   recentre(target,true);
  }
  // A hand drag (and its inertia) moves the map pane, and with it what is drawn: the basemap is re-centred (and the
  // lines clipped again) only once the pane has moved RECENTRE of the margin since, and when the map comes to rest.
  function dragAnchor(map){const o=map.rvGlLayer?._offset;return o?window.L.point(-o.x,-o.y):window.L.DomUtil.getPosition(map.getPane('mapPane'))}
  function dragMove(target){
   if(!target.held||target.zooming)return;
   const {map}=target,p=window.L.DomUtil.getPosition(map.getPane('mapPane')),a=target.anchor,size=map.getSize(),reach=RECENTRE*map.rvMargin;
   if(!a||Math.abs(p.x-a.x)>reach*size.x||Math.abs(p.y-a.y)>reach*size.y)recentre(target);
  }
  function recentre(target,force=false){
   const {map}=target;if(target.zooming&&!force)return;
   redrawBasemap(map,force);map.options.renderer?._update?.();
   target.anchor=window.L.DomUtil.getPosition(map.getPane('mapPane'));alignBasemap(target,true);
  }
  function setFollow(on){if(!on&&big)settle(big);following=on;follow.setAttribute('aria-pressed',String(on));follow.classList.toggle('is-off',!on);if(on)update(true);else if(big)shiftPane(big,'')}
  follow.onclick=()=>setFollow(!following);
  function draw(target,pos,force){
   const {lines,map}=target,points=route[current].points,now=pos.latlng;
   // The current segment is drawn once; as the car moves only the marker moves, so the line is never projected,
   // rounded or simplified again under the car.
   if(force||lines.points!==points){lines.points=points;lines.current.setLatLngs(latlngs(points))}
   // The marker sits on Leaflet's whole pixel; its body takes the remaining fraction and the heading.
   lines.car.setLatLng(now);const body=lines.car.getElement()?.querySelector('.map-car-body');
   if(body){const p=map.project(now,map.getZoom()),transform=`translate(${(p.x-Math.round(p.x)).toFixed(3)}px,${(p.y-Math.round(p.y)).toFixed(3)}px) rotate(${pos.bearing.toFixed(2)}deg)`;if(lines.transform!==transform){lines.transform=transform;body.style.transform=transform}}
   if(!target.zooming&&(target===small||following))followCar(target,now,target===small?CAR_Y:.5);
  }
  function update(force=false){
   if(!route||current<0||typeof t==='undefined')return;
   const pos=position(t),key=pos.index+':'+pos.k.toFixed(4),moved=force||key!==lastKey;lastKey=key;
   if(big&&mode==='map'&&moved)draw(big,pos,force);
   if(small&&!mini.hidden&&moved)draw(small,pos,force);
  }
  // Follows playback: one cheap check per frame while a map is shown.
  const loop=()=>{if(route&&current>=0&&hasVideo()!==miniVideo)syncMini();if((big&&mode==='map')||(small&&!mini.hidden))update();requestAnimationFrame(loop)};requestAnimationFrame(loop);
  // Tapping the route seeks there; a point of another segment of the drive opens that segment at that time.
  function seekTo(latlng){
   let best=null,bestD=Infinity;const k=Math.cos(latlng.lat*Math.PI/180);
   route.forEach((segment,s)=>segment.points.forEach(p=>{const d=(p[1]-latlng.lat)**2+((p[2]-latlng.lng)*k)**2;if(d<bestD){bestD=d;best={s,t:p[0]}}}));
   if(!best)return;
   if(best.s===current){if(!loading)setTime(Math.max(0,Math.min(best.t,data?.duration??best.t)))}
   else{try{sessionStorage.setItem('rv-map-seek',JSON.stringify({id:route[best.s].id,t:best.t}))}catch{}goToLog({id:route[best.s].id})}
  }
  // ④ 영상 위 작은 지도: off by default, kept with the other display preferences. It sits in the video's top-right
  // corner under the speed and the wheel (drawn on top of it, unchanged), only in a segment with video (the panel's
  // map covers the others). A tap enlarges it to the picture between the top and bottom control rows, its top-left
  // corner cut around the segment title; another tap shrinks it.
  const stage=document.getElementById('videoStage'),hud=stage.querySelector('.video-hud'),title=stage.querySelector('.video-title');
  const hasVideo=()=>typeof data!=='undefined'&&!!data?.video;
  let miniVideo=null,resizing=0;
  function syncMini(){
   miniVideo=hasVideo();const on=!!route&&current>=0&&miniToggle.checked&&miniVideo&&mode!=='map'; // never two maps: the panel's map wins
   if(!on&&mini.classList.contains('is-large'))setLarge(false,true);
   mini.hidden=!on;stage.classList.toggle('has-video-map',on);
   if(on){measureSmall();if(small)fitSmall();else ensureSmall()}
  }
  // At least as wide as the speed and wheel; on a short picture no lower than the bottom row (none at all when only
  // the speed's height would be left).
  // A phone held upright shows the fullscreen picture turned a quarter (app.js, .is-turned: a CSS rotation), and screen
  // rectangles are then sideways to the picture: measured as they are, the room came out negative and the map was hidden
  // in fullscreen. inStage gives a rectangle in the picture's own frame (x along its width from its left edge), point a
  // pointer position in the same frame.
  const turned=()=>!!stage.closest('.is-turned');
  const inStage=(b,frame=stage.getBoundingClientRect())=>turned()?{left:b.top-frame.top,right:b.bottom-frame.top,top:frame.right-b.right,width:b.height,height:b.width}:{left:b.left-frame.left,right:b.right-frame.left,top:b.top-frame.top,width:b.width,height:b.height};
  const point=e=>turned()?{x:e.clientY,y:-e.clientX}:{x:e.clientX,y:e.clientY};
  function measureSmall(){
   if(mini.hidden)return;
   const frame=stage.getBoundingClientRect(),box=inStage(frame,frame),speed=inStage(hud.getBoundingClientRect(),frame);stage.style.setProperty('--vmap-min-w',Math.ceil(speed.width)+'px');
   const top=parseFloat(getComputedStyle(mini).top)||12;
   const rows=[...stage.querySelectorAll('.video-tools,.video-fullscreen')].map(e=>e.getBoundingClientRect()).filter(b=>b.width&&b.height).map(b=>inStage(b,frame));
   const room=Math.min(box.height-2*top,...rows.map(b=>b.top-8-top));
   mini.style.setProperty('--vmap-room',Math.floor(room)+'px');mini.classList.toggle('no-room',room<speed.height+28);
  }
  miniToggle.addEventListener('change',syncMini);
  // Enlarged, the map fills the picture as a plain rectangle; the segment title, speed and wheel and the fullscreen
  // button float over it as they float over the video, and the quality and overlay controls step aside (stage
  // .video-map-large) so the messages take their place at the bottom edge.
  function measureLarge(){
   const frame=stage.getBoundingClientRect(),box=inStage(frame,frame),style=getComputedStyle(mini),top=parseFloat(style.top)||12,right=parseFloat(style.right)||12;
   mini.style.setProperty('--vmap-large-w',Math.max(0,box.width-2*right)+'px');mini.style.setProperty('--vmap-large-h',Math.max(0,box.height-2*top)+'px');
  }
  new ResizeObserver(()=>{measureSmall();if(mini.classList.contains('is-large'))measureLarge()}).observe(stage);
  function setLarge(large,instant=false){
   if(large)measureLarge();
   const moving=!(instant||reduced());if(moving)holdCanvas(large);else releaseCanvas();
   mini.classList.toggle('is-large',large);stage.classList.toggle('video-map-large',large);mini.setAttribute('aria-pressed',String(large));mini.setAttribute('aria-label',large?'작은 지도 · 눌러서 작게 보기':'작은 지도 · 눌러서 크게 보기');
   clearTimeout(resizing);
   resizing=setTimeout(()=>{resizing=0;releaseCanvas();fitSmall()},moving?280:0);
  }
  // While the map changes size (.26 s), its Leaflet container keeps one size, centred in the moving frame and showing
  // past its own edges: the larger of the two sizes, so the frame is covered throughout. Growing, the map is drawn
  // once at the large size as the motion starts (held at the small size, the frame outgrew what was drawn and its
  // sides stayed empty until the end); shrinking, once at the small size when the motion ends. Following the frame instead, the container changed size every
  // frame and MapLibre redrew the whole canvas each time (up to 4000 px wide on a Fold's inner screen: three redraws of
  // 55-140 ms inside the animation, 11-27 frames in 0.4 s; held, 26-44 frames and nothing over 56 ms, on the device).
  const HELD=['inset','left','top','width','height','transform','overflow'];
  function holdCanvas(growing){
   const box=mini.querySelector('.video-map-canvas');if(!small||mini.hidden||!box||box.style.width)return;  // a reversal keeps the first hold
   const wide=parseFloat(mini.style.getPropertyValue('--vmap-large-w')),tall=parseFloat(mini.style.getPropertyValue('--vmap-large-h')),grow=growing&&wide>0&&tall>0;
   Object.assign(box.style,{inset:'auto',left:'50%',top:'50%',width:(grow?wide:mini.clientWidth)+'px',height:(grow?tall:mini.clientHeight)+'px',transform:'translate(-50%,-50%)',overflow:'visible'});
   if(grow)small.map.invalidateSize({animate:false});
  }
  function releaseCanvas(){const box=mini.querySelector('.video-map-canvas');if(box)for(const key of HELD)box.style.removeProperty(key)}
  // The bottom-left corner resizes the small map (mouse or touch), anchored at its top-right, 4:3: from its least
  // width up to the picture's width or the room above the bottom row. Kept in this browser as a share of the picture's
  // width; a double tap on the corner goes back to the default size. Dragging never toggles 크게 보기.
  const SIZE_KEY='roadviewer-minimap-size',grip=document.createElement('span');grip.className='video-map-grip';grip.setAttribute('aria-hidden','true');mini.append(grip);
  const applySize=f=>{if(f){stage.style.setProperty('--vmap-f',f.toFixed(4));stage.classList.add('vmap-sized')}else{stage.style.removeProperty('--vmap-f');stage.classList.remove('vmap-sized')}};
  try{const f=Number(localStorage.getItem(SIZE_KEY));if(f>0&&f<1)applySize(f)}catch{}
  let sizing=null;
  grip.addEventListener('pointerdown',e=>{
   if(mini.classList.contains('is-large')||e.button>0)return;e.preventDefault();e.stopPropagation();try{grip.setPointerCapture(e.pointerId)}catch{}
   const frame=stage.getBoundingClientRect(),r=inStage(mini.getBoundingClientRect(),frame),box=inStage(frame,frame),room=parseFloat(mini.style.getPropertyValue('--vmap-room'))||box.height,at=point(e);
   const min=Math.max(104,parseFloat(stage.style.getPropertyValue('--vmap-min-w'))||0),max=Math.max(min,Math.min(box.width-2*(box.right-r.right),room/.75));
   sizing={id:e.pointerId,x:at.x,y:at.y,w:r.width,min,max,stageW:box.width,moved:false,f:null};mini.classList.add('is-sizing');
  });
  grip.addEventListener('pointermove',e=>{
   if(!sizing||e.pointerId!==sizing.id)return;const at=point(e),dx=sizing.x-at.x,dy=(at.y-sizing.y)/.75;
   if(!sizing.moved&&Math.hypot(dx,dy)<3)return;sizing.moved=true;e.preventDefault();
   const w=Math.min(sizing.max,Math.max(sizing.min,sizing.w+(Math.abs(dx)>=Math.abs(dy)?dx:dy)));sizing.f=w/sizing.stageW;applySize(sizing.f);
  });
  const endSizing=e=>{if(!sizing||e.pointerId!==sizing.id)return;mini.classList.remove('is-sizing');if(sizing.moved&&sizing.f)try{localStorage.setItem(SIZE_KEY,String(sizing.f))}catch{}sizing=null};
  grip.addEventListener('pointerup',endSizing);grip.addEventListener('pointercancel',endSizing);
  grip.addEventListener('click',e=>e.stopPropagation());
  grip.addEventListener('dblclick',e=>{e.stopPropagation();applySize(0);try{localStorage.removeItem(SIZE_KEY)}catch{}});
  const resize=()=>setLarge(!mini.classList.contains('is-large'));
  mini.addEventListener('click',e=>{if(e.target.closest('a,.rv-credit-toggle'))return;resize()});
  mini.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();resize()}});
  redrawColours=()=>{for(const target of [big,small]){if(!target)continue;const done=css('--accent'),rest=css('--muted');target.lines.others.forEach(l=>l.setStyle({color:rest}));target.lines.current.setStyle({color:done})}};
 }
})();
