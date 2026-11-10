// GPS route maps (gps_track.py, /api/tracks, /api/logs/<id>/track). One file for both pages, in its own scope:
//  library: ① 목록 | 지도 (every drive the filters show, one colour each), ② the route shape on each card (an SVG
//           polyline, no tiles) that opens 주행 지도: the drive full screen, its map above (or beside) a sheet of its
//           segment rows;
//  replay:  ③ 주행 상황 | 지도 (the drive, travelled part solid, a car marker following playback, tap to seek) and
//           ④ the small map in the video's top-right corner, under the speed and the wheel
//           (겹쳐 보기 설정 › 지도).
// Leaflet (vendor/, BSD-2) and its stylesheet load only when a map is first shown. Tiles: CARTO raster (as Home
// Assistant's map), light or dark with the app's theme; the attribution stays visible.
(()=>{
 const library=!!document.getElementById('panel-logs'),replay=!!document.getElementById('roadView');
 if(!library&&!replay)return;
 const TILES={light:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',dark:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  'light-nolabels':'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png','dark-nolabels':'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'};
 const ATTRIBUTION='© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';
 const PALETTE=['mint','blue','amber','violet','rose','cyan','lime','coral','indigo','yellow','red','slate'];
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const theme=()=>window.RoadViewerTheme?.theme?.()==='light'?'light':'dark';
 const css=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
 const tagColor=i=>css('--tag-'+PALETTE[i%PALETTE.length])||'#3DCB92';
 // The stylesheet this page was served with names the asset folder and its version.
 const styleLink=document.head.querySelector('link[href*="style.css"]'),assetBase=styleLink?new URL('./',styleLink.href):new URL(replay?'../../assets/':'assets/',location.href),version=styleLink?new URL(styleLink.href).search:'';
 let leaflet=null;
 function loadLeaflet(){
  if(window.L?.map)return Promise.resolve(window.L);
  if(leaflet)return leaflet;
  const add=(tag,attrs)=>new Promise((resolve,reject)=>{const el=document.createElement(tag);Object.assign(el,attrs);el.onload=resolve;el.onerror=()=>reject(Error('지도를 불러오지 못했습니다.'));document.head.append(el)});
  leaflet=Promise.all([document.head.querySelector('#rvLeafletCss')?Promise.resolve():add('link',{id:'rvLeafletCss',rel:'stylesheet',href:new URL('vendor/leaflet.css'+version,assetBase).href}),
   add('script',{id:'rvLeafletJs',src:new URL('vendor/leaflet.js'+version,assetBase).href})]).then(()=>window.L).catch(e=>{leaflet=null;throw e});
  return leaflet;
 }
 // A map with this app's look: no Leaflet prefix, the CARTO tiles of the current theme, zoom buttons only where asked.
 const maps=new Set();
 // tone: a function giving 'light' or 'dark' to override the app theme; labels: a function, false for the tiles
 // without place names (both: the small map's own choices).
 function createMap(L,container,{zoom=true,interactive=true,attribution=ATTRIBUTION,tone=null,labels=null}={}){
  const map=L.map(container,{zoomControl:false,attributionControl:true,dragging:interactive,touchZoom:interactive,scrollWheelZoom:interactive,doubleClickZoom:interactive,boxZoom:interactive,keyboard:interactive,tap:interactive,zoomSnap:.25,fadeAnimation:!reduced(),zoomAnimation:!reduced(),markerZoomAnimation:!reduced()});
  map.attributionControl.setPrefix(false);
  const tiles=()=>tone?.()||theme(),tileKey=()=>tiles()+(labels&&!labels()?'-nolabels':''),layer=L.tileLayer(TILES[tileKey()],{subdomains:'abcd',maxZoom:19,attribution,detectRetina:true,crossOrigin:true}).addTo(map);
  if(zoom)L.control.zoom({position:'topright',zoomInTitle:'확대',zoomOutTitle:'축소'}).addTo(map);
  container.classList.add('rv-map');container.dataset.tiles=tiles();container.dataset.tileKey=tileKey();map.rvLayer=layer;map.rvTiles=tiles;map.rvTileKey=tileKey;maps.add(map);
  new ResizeObserver(()=>{if(container.isConnected)map.invalidateSize({animate:false})}).observe(container);
  return map;
 }
 window.addEventListener('rv:themechange',()=>{for(const map of maps){const box=map.getContainer();if(!box.isConnected){maps.delete(map);continue}applyTiles(map)}redrawColours()});
 function applyTiles(map){const box=map.getContainer(),key=map.rvTileKey();box.dataset.tiles=map.rvTiles();if(box.dataset.tileKey===key)return;map.rvLayer.setUrl(TILES[key]);box.dataset.tileKey=key}
 let redrawColours=()=>{};
 const latlngs=points=>points.map(p=>[p[1],p[2]]);
 const kmText=m=>Number.isFinite(m)?(m>=1000?(m/1000).toFixed(m>=100000?0:1)+' km':Math.round(m)+' m'):'—';
 // An SVG polyline of a route's shape, fitted to w×h with a margin and the latitude's scale (no tiles).
 function shapeSvg(coords,w=64,h=48,pad=5){
  const mid=coords.reduce((s,c)=>s+c[0],0)/coords.length,k=Math.cos(mid*Math.PI/180);
  const xs=coords.map(c=>c[1]*k),ys=coords.map(c=>-c[0]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min((w-2*pad)/Math.max(maxX-minX,1e-9),(h-2*pad)/Math.max(maxY-minY,1e-9)),ox=(w-(maxX-minX)*scale)/2,oy=(h-(maxY-minY)*scale)/2;
  const pts=xs.map((x,i)=>`${((x-minX)*scale+ox).toFixed(1)},${((ys[i]-minY)*scale+oy).toFixed(1)}`);
  const [sx,sy]=pts[0].split(','),[ex,ey]=pts.at(-1).split(',');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle class="shape-start" cx="${sx}" cy="${sy}" r="2.6"/><circle class="shape-end" cx="${ex}" cy="${ey}" r="2.6"/></svg>`;
 }

 if(library){
  // ---- ① 전체 주행 경로, ② the card's route shape and 주행 지도.
  let tracks=null,trackTag=null,trackText=null,trackSignature=null,trackRequest=null,mode='list',overview=null,overviewLines=new Map(),selected=null;
  const switcher=document.getElementById('logView'),panel=document.getElementById('logMap'),canvas=panel.querySelector('.log-map-canvas'),card=document.getElementById('logMapCard'),empty=panel.querySelector('.log-map-empty');
  const routeOf=new Map();  // log id -> route of /api/tracks
  const groupRoute=group=>{for(const log of group.logs){const route=routeOf.get(log.id);if(route)return route}return null};
  async function fetchTracks(){
   trackRequest?.abort();const request=trackRequest=new AbortController();
   try{
    const response=await fetch('api/tracks',{cache:'no-store',signal:request.signal,headers:trackTag?{'If-None-Match':trackTag}:{}});
    let text;if(response.status===304&&trackText)text=trackText;else{if(!response.ok)return;text=await response.text();trackTag=response.headers.get('ETag');trackText=text}
    tracks=JSON.parse(text).routes||[];routeOf.clear();for(const route of tracks)for(const id of route.ids)routeOf.set(id,route);
    syncCards();if(mode==='map')drawOverview(false);
   }catch{}
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
  // ② The shape button on each card with GPS: tap opens the drive's map (주행 지도).
  function syncCards(){
   for(const group of logGroups.values()){
    const route=groupRoute(group),summary=group.element.querySelector(':scope>summary');
    if(!route||route.points.length<2){group.shape?.remove();group.shape=null;continue}
    if(!group.shape){
     const button=document.createElement('button');button.type='button';button.className='route-shape';button.dataset.noRipple='';
     button.setAttribute('aria-label','주행 지도 열기');button.setAttribute('aria-haspopup','dialog');button.title='주행 지도';
     button.onclick=event=>{event.preventDefault();event.stopPropagation();openDrive(group,{opener:button})};
     group.shape=button;
    }
    if(group.shape.parentNode!==summary)group.thumb.after(group.shape);
    const key=route.points.length+':'+route.points[0]+':'+route.points.at(-1);
    if(group.shape.dataset.key!==key){group.shape.dataset.key=key;group.shape.innerHTML=shapeSvg(route.points)}
   }
   if(restoreDrive)restoreDrive();
  }
  const routeFacts=group=>{
   const route=groupRoute(group),date=logDate(group.firstLog),duration=group.logs.reduce((sum,log)=>sum+(Number.isFinite(log.duration)?log.duration:0),0);
   return {title:date?`${localeDate(date)} ${clockText(date)}`:group.route.title,facts:[kmText(route?.distance_m),duration?durationText(duration):null,`${group.logs.length}개 구간`].filter(Boolean).join(' · ')};
  };
  // ---- 주행 지도: one drive full screen. The map stays on top (phones) or on the left (wide screens); the drive's
  // segment rows, as in the list, scroll on their own in a sheet below it (or beside it). A row tap marks its segment
  // on the map and fits the map to it; a tap on the map marks the row and scrolls the sheet to it. It is a history
  // entry (#drive-map): the system back, the header's back button and Escape close it.
  const drive=document.getElementById('driveMap'),driveBody=drive.querySelector('.drive-map-body'),driveCanvas=drive.querySelector('.drive-map-canvas'),sheet=drive.querySelector('.drive-map-sheet'),handle=drive.querySelector('.drive-map-handle'),sheetList=drive.querySelector('.drive-map-list');
  const DRIVE_HASH='#drive-map',SNAPS=[.36,.54,.7],wide=matchMedia('(min-width:1024px),(min-width:600px) and (orientation:landscape)');
  let driveGroup=null,driveMap=null,driveLayer=null,driveLines=new Map(),driveRows=new Map(),driveMarked=null,driveTicket=0,snap=1,driveOpener=null,restoreDrive=null,escapeTaken=false;
  function openDrive(group,{segment=null,push=true,opener=null}={}){
   const same=drive.open&&driveGroup===group;driveGroup=group;
   if(!same){
    driveMarked=segment;driveRows.clear();sheetList.replaceChildren();syncDrive();sheetList.scrollTop=0;
    if(!drive.open){driveOpener=opener||document.activeElement;drive.showModal();document.body.style.overflow='hidden';setSnap(1)}
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
   if(!driveMap){driveMap=createMap(L,driveCanvas);driveLayer=L.layerGroup().addTo(driveMap);driveMap.on('click',()=>markDrive(null,{fit:true}))}
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
  function fitDrive(animate=!reduced()){
   if(!driveMap||!window.L)return;const line=driveMarked&&driveLines.get(driveMarked);
   const bounds=line?line.getBounds():[...driveLines.values()].reduce((b,l)=>b.extend(l.getBounds()),window.L.latLngBounds([]));
   if(bounds.isValid())driveMap.fitBounds(bounds,{padding:[28,28],maxZoom:line?16:17,animate});
  }
  function paintDrive(){
   for(const [id,line] of driveLines){const on=!driveMarked||id===driveMarked;line.setStyle({opacity:on?.95:.3,weight:id===driveMarked?7:5});if(id===driveMarked)line.bringToFront()}
   for(const [id,cached] of driveRows)cached.row.classList.toggle('is-map-marked',id===driveMarked);
  }
  function markDrive(id,{fit=false,scroll=false,animate=!reduced()}={}){
   driveMarked=id;paintDrive();if(fit)fitDrive(animate);
   const row=id&&driveRows.get(id)?.row;
   if(scroll&&row){
    const box=row.getBoundingClientRect(),list=sheetList.getBoundingClientRect();
    if(box.top<list.top||box.bottom>list.bottom)sheetList.scrollTo({top:sheetList.scrollTop+box.top-list.top-Math.max(0,(list.height-box.height)/2),behavior:reduced()?'auto':'smooth'});
   }
  }
  // A tap on a row (outside its play button, ⋯ menu and other controls) marks its segment instead of playing it.
  sheetList.addEventListener('click',event=>{
   const row=event.target.closest('.log-row'),control=row&&event.target.closest('a,button,summary,details,input,label');
   if(!row||control&&row.contains(control))return;
   event.stopPropagation();sheetList.querySelectorAll('.recording-more[open]').forEach(more=>{more.open=false});
   markDrive(row.dataset.id,{fit:true});
  });
  // The sheet's handle: drag between the snap heights (a tap or the arrow keys step through them).
  let refit=0;
  function setSnap(i){
   snap=Math.max(0,Math.min(SNAPS.length-1,i));driveBody.style.setProperty('--sheet-h',SNAPS[snap]*100+'%');
   handle.setAttribute('aria-valuenow',String(Math.round(SNAPS[snap]*100)));
   clearTimeout(refit);if(driveMap)refit=setTimeout(()=>{if(drive.open){driveMap.invalidateSize({animate:false});fitDrive(false)}},reduced()?0:300);
  }
  handle.addEventListener('pointerdown',event=>{
   if(wide.matches||event.button>0)return;
   event.preventDefault();try{handle.setPointerCapture(event.pointerId)}catch{}
   const startY=event.clientY,startH=sheet.getBoundingClientRect().height,total=driveBody.clientHeight;let moved=false;
   driveBody.classList.add('is-dragging');
   const move=e=>{const dy=e.clientY-startY;if(Math.abs(dy)>4)moved=true;driveBody.style.setProperty('--sheet-h',Math.max(SNAPS[0]*total,Math.min(SNAPS.at(-1)*total,startH-dy))+'px')};
   const end=()=>{
    handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
    driveBody.classList.remove('is-dragging');
    if(!moved){setSnap(snap===SNAPS.length-1?0:snap+1);return}
    const share=sheet.getBoundingClientRect().height/total;let best=0;SNAPS.forEach((value,i)=>{if(Math.abs(value-share)<Math.abs(SNAPS[best]-share))best=i});setSnap(best);
   };
   handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  });
  handle.addEventListener('click',e=>{if(e.detail===0&&!wide.matches)setSnap(snap===SNAPS.length-1?0:snap+1)});
  handle.addEventListener('keydown',e=>{const step={ArrowUp:1,ArrowDown:-1}[e.key];if(step&&!wide.matches){e.preventDefault();setSnap(snap+step)}});
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
  function setMode(next){
   mode=next;for(const button of switcher.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.view===mode));
   document.getElementById('list').hidden=mode==='map';panel.hidden=mode!=='map';
   if(mode==='map'){document.getElementById('empty').hidden=true;drawOverview(true)}else{card.hidden=true;selected=null;applyFilters()}
   try{sessionStorage.setItem('roadviewer-log-view',mode)}catch{}
  }
  switcher.addEventListener('click',e=>{const button=e.target.closest('button[data-view]');if(button&&button.dataset.view!==mode)setMode(button.dataset.view)});
  const visibleGroups=()=>[...logGroups.values()].filter(group=>!group.element.hidden&&group.element.closest('.log-day')&&!group.element.closest('.log-day').hidden);
  let overviewFit=true;
  async function drawOverview(fit){
   if(fit)overviewFit=true;
   if(!tracks){empty.hidden=true;return}
   let L;try{L=await loadLeaflet()}catch(e){error(e.message);return}
   if(mode!=='map')return;
   if(!overview){overview=createMap(L,canvas);overview.on('click',()=>select(null))}
   const shown=visibleGroups().map(group=>({group,route:groupRoute(group)})).filter(item=>item.route&&item.route.points.length>1);
   const keys=new Set(shown.map(item=>item.route.key));
   for(const [key,line] of overviewLines)if(!keys.has(key)){line.remove();overviewLines.delete(key)}
   const bounds=L.latLngBounds([]);
   shown.forEach(({group,route},i)=>{
    let line=overviewLines.get(route.key);
    if(!line){line=L.polyline(route.points,{weight:4,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(overview);line.on('click',e=>{L.DomEvent.stopPropagation(e);select(line.rvGroup)});overviewLines.set(route.key,line)}
    else if(line.rvPoints!==route.points)line.setLatLngs(route.points);
    line.rvPoints=route.points;line.rvGroup=group;line.rvRoute=route;line.rvIndex=i;bounds.extend(route.points);
   });
   if(selected&&!shown.some(item=>item.group===selected))select(null);else paintOverview();
   empty.hidden=!!shown.length;
   if(overviewFit&&bounds.isValid()){overviewFit=false;overview.invalidateSize({animate:false});overview.fitBounds(bounds,{padding:[28,28],animate:false,maxZoom:15})}
  }
  function paintOverview(){
   for(const line of overviewLines.values()){
    const on=!selected||line.rvGroup===selected;line.setStyle({color:tagColor(line.rvIndex),opacity:on?.92:.22,weight:line.rvGroup===selected?6:4});
    if(line.rvGroup===selected)line.bringToFront();
   }
  }
  redrawColours=()=>{if(overview)paintOverview();const colour=css('--accent');for(const line of driveLines.values())line.setStyle({color:colour})};
  function select(group){
   selected=group;paintOverview();card.hidden=!group;if(!group){card.querySelector('.map-card-play')?.remove();return}
   const route=groupRoute(group),date=logDate(group.firstLog),duration=group.logs.reduce((sum,log)=>sum+(Number.isFinite(log.duration)?log.duration:0),0);
   card.querySelector('.map-card-title').textContent=date?`${localeDate(date)} ${clockText(date)}`:group.route.title;
   card.querySelector('.map-card-facts').textContent=[kmText(route?.distance_m),duration?durationText(duration):null,`${group.logs.length}개 구간`].filter(Boolean).join(' · ');
   // 재생 exists only while a drive is shown (the list counts its .replay links).
   card.querySelector('.map-card-play')?.remove();const ready=firstReady(group);
   if(ready){const play=document.createElement('a');play.className='replay map-card-play';play.dataset.glow='';play.href=`view/${ready.id}/`;play.innerHTML=PLAY_ICON;play.append('재생');card.querySelector('.map-card-actions').prepend(play)}
   card.dataset.color=PALETTE[(overviewLines.get(route?.key)?.rvIndex||0)%PALETTE.length];
  }
  card.querySelector('.map-card-list').onclick=()=>{
   const group=selected;setMode('list');if(!group)return;
   requestAnimationFrame(()=>{group.element.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});group.element.classList.remove('is-located');void group.element.offsetWidth;group.element.classList.add('is-located')});
  };
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
  // 글자 없는 지도: the small map's tiles without place names (CARTO *_nolabels); saved with the other display
  // preferences (app.js, .overlay-settings-body inputs).
  const miniPlain=document.getElementById('videoMiniMapPlain');
  miniPlain.addEventListener('change',()=>{for(const map of maps)if(map.getContainer().closest('#videoMap'))applyTiles(map)});
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
  // Position at replay time t: between this segment's 1 Hz points; bearing from the receiver or the path itself.
  function position(time){
   const points=route[current].points;let i=0;
   while(i<points.length-1&&points[i+1][0]<=time)i++;
   const a=points[i],b=points[Math.min(i+1,points.length-1)],span=b[0]-a[0],k=span>0?Math.max(0,Math.min(1,(time-a[0])/span)):0;
   const lat=a[1]+(b[1]-a[1])*k,lon=a[2]+(b[2]-a[2])*k;
   let bearing=a[4];
   if(bearing===null||bearing===undefined){const [from,to]=b!==a?[a,b]:[points[Math.max(0,i-1)],a];bearing=Math.atan2((to[2]-from[2])*Math.cos(lat*Math.PI/180),to[1]-from[1])*180/Math.PI}
   return {latlng:[lat,lon],bearing:Number.isFinite(bearing)?bearing:0,index:i,k};
  }
  const carIcon=L=>L.divIcon({className:'map-car',html:'<span class="map-car-body"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3 19 20 12 16 5 20Z"/></svg></span>',iconSize:[28,28],iconAnchor:[14,14]});
  // The drive's lines: travelled solid, the rest faded. Only the large map seeks on a tap (interactive).
  function layers(L,map,interactive=true){
   const done=css('--accent')||'#3DCB92',rest=css('--muted')||'#9AA0A9',lines={before:[],after:[]};
   route.forEach((segment,i)=>{
    if(i===current)return;
    const line=L.polyline(latlngs(segment.points),{color:i<current?done:rest,weight:5,opacity:i<current?.95:.45,lineCap:'round',lineJoin:'round',interactive}).addTo(map);
    if(interactive)line.on('click',e=>seekTo(e.latlng));(i<current?lines.before:lines.after).push(line);
   });
   lines.ahead=L.polyline([],{color:rest,weight:5,opacity:.45,lineCap:'round',interactive,className:'map-current'}).addTo(map);
   lines.behind=L.polyline([],{color:done,weight:6,opacity:.95,lineCap:'round',lineJoin:'round',interactive,className:'map-current'}).addTo(map);
   if(interactive)for(const line of [lines.ahead,lines.behind])line.on('click',e=>seekTo(e.latlng));
   lines.car=L.marker([0,0],{icon:carIcon(L),interactive:false,keyboard:false}).addTo(map);
   return lines;
  }
  async function ensureBig(){
   if(big||!route)return;
   const L=await loadLeaflet().catch(e=>{showError(e.message);return null});if(!L||big)return;
   const map=createMap(L,view.querySelector('.route-map-canvas'));big={map,lines:layers(L,map)};
   const bounds=L.latLngBounds(route.flatMap(segment=>latlngs(segment.points)));
   map.fitBounds(bounds,{padding:[24,24],animate:false,maxZoom:17});
   map.on('dragstart',()=>setFollow(false));lastKey='';update(true);
  }
  async function ensureSmall(){
   if(small||!route)return;
   const L=await loadLeaflet().catch(()=>null);if(!L||small)return;
   const map=createMap(L,mini.querySelector('.video-map-canvas'),{zoom:false,interactive:false,tone:()=>miniTone==='auto'?null:miniTone,labels:()=>!miniPlain.checked,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'});
   small={map,lines:layers(L,map,false),pad:null};fitSmall();
   // Refit when the map or the speed and wheel over it change size (the speed appears once the replay has data).
   {const watch=new ResizeObserver(()=>{if(small&&!mini.hidden&&!resizing)fitSmall()});watch.observe(mini);watch.observe(hud)}
  }
  // The small map fits the current segment's whole track; the speed and wheel are drawn over its top-right, so the
  // fit keeps the route below them. Afterwards it pans only when the car gets near an edge.
  function fitSmall(){
   if(!small||mini.hidden)return;
   const box=mini.getBoundingClientRect(),speed=hud.getBoundingClientRect();let top=10;
   if(speed.width&&speed.bottom>box.top&&speed.left<box.right&&speed.right>box.left)top=Math.max(top,Math.min(box.height*.6,speed.bottom-box.top+6));
   small.pad={top,side:10};small.map.invalidateSize({animate:false});
   const bounds=window.L.latLngBounds(latlngs(route[current].points));
   if(bounds.isValid())small.map.fitBounds(bounds,{paddingTopLeft:[10,top],paddingBottomRight:[10,10],maxZoom:17,animate:false});
   lastKey='';update(true);
  }
  function keepInView(latlng){
   const map=small.map,size=map.getSize(),point=map.latLngToContainerPoint(latlng),pad=small.pad||{top:10,side:10},edge=6;
   const left=pad.side+edge,right=size.x-pad.side-edge,top=pad.top+edge,bottom=size.y-pad.side-edge;
   const dx=point.x<left?point.x-left:point.x>right?point.x-right:0,dy=point.y<top?point.y-top:point.y>bottom?point.y-bottom:0;
   if(dx||dy)map.panBy([dx,dy],{animate:false});
  }
  function setFollow(on){following=on;follow.setAttribute('aria-pressed',String(on));follow.classList.toggle('is-off',!on);if(on)update(true)}
  follow.onclick=()=>setFollow(!following);
  function draw(target,pos,moved){
   const {lines,map}=target,points=route[current].points,now=pos.latlng;
   lines.behind.setLatLngs([...latlngs(points.slice(0,pos.index+1)),now]);
   lines.ahead.setLatLngs([now,...latlngs(points.slice(pos.index+1))]);
   lines.car.setLatLng(now);const body=lines.car.getElement()?.querySelector('.map-car-body');if(body)body.style.transform=`rotate(${pos.bearing}deg)`;
   if(moved&&target===small)keepInView(now);else if(moved&&following)map.panTo(now,{animate:false});
  }
  function update(force=false){
   if(!route||current<0||typeof t==='undefined')return;
   const pos=position(t),key=pos.index+':'+pos.k.toFixed(3);
   if(!force&&key===lastKey)return;lastKey=key;
   if(big&&mode==='map')draw(big,pos,true);
   if(small&&!mini.hidden)draw(small,pos,true);
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
  function measureSmall(){
   if(mini.hidden)return;
   const speed=hud.getBoundingClientRect();stage.style.setProperty('--vmap-min-w',Math.ceil(speed.width)+'px');
   const box=stage.getBoundingClientRect(),top=parseFloat(getComputedStyle(mini).top)||12;
   const rows=[...stage.querySelectorAll('.video-tools,.video-fullscreen')].map(e=>e.getBoundingClientRect()).filter(b=>b.width&&b.height);
   const room=Math.min(box.height-2*top,...rows.map(b=>b.top-8-box.top-top));
   mini.style.setProperty('--vmap-room',Math.floor(room)+'px');mini.classList.toggle('no-room',room<speed.height+28);
  }
  miniToggle.addEventListener('change',syncMini);
  // Enlarged, the map fills the picture as a plain rectangle; the segment title, speed and wheel and the fullscreen
  // button float over it as they float over the video, and the quality and overlay controls step aside (stage
  // .video-map-large) so the messages take their place at the bottom edge.
  function measureLarge(){
   const box=stage.getBoundingClientRect(),style=getComputedStyle(mini),top=parseFloat(style.top)||12,right=parseFloat(style.right)||12;
   mini.style.setProperty('--vmap-large-w',Math.max(0,box.width-2*right)+'px');mini.style.setProperty('--vmap-large-h',Math.max(0,box.height-2*top)+'px');
  }
  new ResizeObserver(()=>{measureSmall();if(mini.classList.contains('is-large'))measureLarge()}).observe(stage);
  function setLarge(large,instant=false){
   if(large)measureLarge();
   mini.classList.toggle('is-large',large);stage.classList.toggle('video-map-large',large);mini.setAttribute('aria-pressed',String(large));mini.setAttribute('aria-label',large?'작은 지도 · 눌러서 작게 보기':'작은 지도 · 눌러서 크게 보기');
   clearTimeout(resizing);
   resizing=setTimeout(()=>{resizing=0;fitSmall()},instant||reduced()?0:280);
  }
  const resize=()=>setLarge(!mini.classList.contains('is-large'));
  mini.addEventListener('click',e=>{if(e.target.closest('a'))return;resize()});
  mini.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();resize()}});
  redrawColours=()=>{for(const target of [big,small]){if(!target)continue;const done=css('--accent'),rest=css('--muted');target.lines.before.forEach(l=>l.setStyle({color:done}));target.lines.after.forEach(l=>l.setStyle({color:rest}));target.lines.behind.setStyle({color:done});target.lines.ahead.setStyle({color:rest})}};
 }
})();
