"""Smaller replay files: drop values the browser can rebuild, round float32 noise, store gzip.

The browser expands the compact form again (see expandReplayData in app.js), so older
uncompressed data.json files and compact ones are read the same way.
"""
import gzip, json, math, os, sys
from pathlib import Path

# Replay data format. 2: the top-down lanes/edges/position of a frame with overlay geometry are left out (the browser
# takes them from the geometry's first two coordinates), and the geometry's lane/edge points drop their distance,
# which is the model's fixed grid (data['laneX']) in every frame. Recorded in summary.json as replay_v, so the
# migration finds older files without opening them.
REPLAY_V = 2
GZIP_LEVEL = 9  # Replay files are written once and read many times: the strongest gzip costs only at conversion.
FLAT_KEYS = (('lanes', True), ('edges', True), ('position', False))  # (frame key, a list of lines?)
FLAT_TOLERANCE = 2e-3  # The frame keeps three decimals, the geometry four (double rounding moves a value by 1e-3).

# Displayed with at most three decimals. Probabilities and thresholds (lp, es, p, modelProb) stay exact.
def r4(value): return round(value, 4) if isinstance(value, float) else value

def round_points(points): return [[r4(p[0]), r4(p[1])] if p else p for p in points] if points else points

def round_coordinates(value, digits):
    # Only coordinate arrays: never change confidence values or detection thresholds.
    if isinstance(value, (list, tuple)): return [round_coordinates(item, digits) for item in value]
    return round(value, digits) if isinstance(value, float) else value


def compact_target(target, fields=('x', 'yRel', 'vRel')):
    for key in fields:
        if key in target: target[key] = r4(target[key])
    target.pop('y', None)  # Always -yRel; the browser restores it.

def flat_line(points):
    # As decoder.points: [x, y] of the finite points, three decimals.
    return [[round(p[0], 3), round(p[1], 3)] for p in points
            if len(p) >= 2 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p[:2])]

def same_line(a, b):
    return isinstance(a, list) and len(a) == len(b) and all(
        isinstance(p, list) and len(p) == 2 and abs(p[0] - q[0]) <= FLAT_TOLERANCE and abs(p[1] - q[1]) <= FLAT_TOLERANCE for p, q in zip(a, b))

def drop_flat(frame, geometry):
    # Leaves out what equals the geometry's x/y; a frame without the key gets null so it stays without it.
    for key, lines in FLAT_KEYS:
        source = geometry.get(key)
        if source is None: continue
        if key not in frame: frame[key] = None; continue
        value = frame[key]
        if lines:
            if isinstance(value, list) and len(value) == len(source) and all(same_line(v, flat_line(g)) for v, g in zip(value, source)): del frame[key]
        elif same_line(value, flat_line(source)): del frame[key]

def drop_grid(geometry, grid):
    # A lane/edge line on the model's distance grid keeps [y, z] per point; any other line stays [x, y, z].
    for key in ('lanes', 'edges'):
        lines = geometry.get(key)
        if not isinstance(lines, list): continue
        geometry[key] = [[p[1:] for p in line] if isinstance(line, list) and len(line) == len(grid) and all(
            isinstance(p, (list, tuple)) and len(p) == 3 and p[0] == x for p, x in zip(line, grid)) else line for line in lines]

def lane_grid(frames):
    for frame in frames:
        geometry = (frame.get('overlay') or {}).get('geometry') or {}
        for line in (geometry.get('lanes') or []) + (geometry.get('edges') or []):
            if isinstance(line, list) and line and all(isinstance(p, (list, tuple)) and len(p) == 3 for p in line): return [p[0] for p in line]
    return None

def compact_data(data, progress=None):
    """In place and idempotent, so migrating an already compact file is harmless."""
    v2 = data.get('replayV') != REPLAY_V
    infos, index = data.get('cameraInfos') or [], {}
    for i, info in enumerate(infos): index[json.dumps(info, sort_keys=True)] = i
    frames=data.get('frames', [])
    for i,frame in enumerate(frames):
        if progress and i%32==0:progress(100*i/max(len(frames),1))
        info = frame.get('cameraInfo')
        if isinstance(info, dict):
            # Calibration changes a few times per drive; the full object was repeated in every frame.
            key = json.dumps(info, sort_keys=True)
            if key not in index: index[key] = len(infos); infos.append(info)
            frame['cameraInfo'] = index[key]
        for target in frame.get('liveTracks') or []:
            target.pop('index', None)  # Unused: markers address liveTracks by list position.
            compact_target(target)
        for target in frame.get('radarTargets') or []: compact_target(target)
        for lead in frame.get('leads') or []:
            for key in ('x', 'y', 'speedKph'):
                if key in lead: lead[key] = r4(lead[key])
        if frame.get('selected'):
            for key in ('x', 'y', 'vRel'):
                if key in frame['selected']: frame['selected'][key] = r4(frame['selected'][key])
        overlay = frame.get('overlay')
        if overlay and 'geometry' in overlay:
            overlay['geometry'] = {key:round_coordinates(value, 6 if key == 'basis' else 4) for key,value in overlay['geometry'].items()}
            if v2: drop_flat(frame, overlay['geometry'])
            continue
        if overlay:
            # Normalised image coordinates: 1e-4 is about 0.2 px on the 1928 px sensor.
            for key in ('lanes', 'edges'): overlay[key] = [round_points(line) for line in overlay.get(key, [])]
            overlay['path'] = round_points(overlay.get('path'))
            for key in ('laneBands', 'edgeBands', 'targetLine'):
                if key in overlay: overlay[key] = round_coordinates(overlay[key], 4)
            # Homogeneous projections are divided by depth; keep six decimals for
            # near-plane points and adjustable path width / wall height vectors.
            for key in ('blindspotPaths', 'pathProjection', 'pathSides', 'targetSections', 'heightDirection'):
                if key in overlay: overlay[key] = round_coordinates(overlay[key], 6)
            overlay.pop('laneDepths', None)  # No renderer consumes this duplicate depth array.
            for marker in overlay.get('markers', []):
                if 'box' in marker: marker['box'] = round_coordinates(marker['box'], 6)
                if marker.get('projection'):
                    # The point is projection[0:2] / projection[2]; the browser recomputes it.
                    marker.pop('point', None)
                    # Five decimals: near targets have small depths, which magnify rounding in the division.
                    marker['projection'] = [round(value, 5) if isinstance(value, float) else value for value in marker['projection']]
    if v2:
        grid = data.get('laneX') or lane_grid(frames)
        if grid:
            data['laneX'] = grid
            for frame in frames:
                geometry = (frame.get('overlay') or {}).get('geometry')
                if geometry: drop_grid(geometry, grid)
        data['replayV'] = REPLAY_V
    if progress:progress(100)
    if infos: data['cameraInfos'] = infos
    return data

def expand_frames(data):
    """Python counterpart of the browser's expandReplayData for the format-2 parts (tools reading data.json.gz)."""
    if data.get('replayV') != REPLAY_V: return data
    grid = data.get('laneX') or []
    for frame in data.get('frames') or []:
        geometry = (frame.get('overlay') or {}).get('geometry')
        if not geometry: continue
        for key in ('lanes', 'edges'):
            geometry[key] = [[[x, *p] for x, p in zip(grid, line)] if line and len(line[0]) == 2 else line for line in geometry.get(key) or []]
        for key, lines in FLAT_KEYS:
            if key not in frame and geometry.get(key) is not None:
                frame[key] = [flat_line(line) for line in geometry[key]] if lines else flat_line(geometry[key])
            elif frame.get(key, 0) is None: del frame[key]
    return data

def write_gzip_json(path, value, *, progress=None, **options):
    """Atomic: readers see the old file or the complete new one, never a partial write."""
    path = Path(path); temp = path.with_name(path.name + '.tmp')
    def encode(item):return json.dumps(item, separators=(',', ':'), allow_nan=False, **options).encode()
    if progress:progress('encode',0)
    # Encode replay frames in C-backed batches, avoiding Python's per-token iterencode overhead.
    frames=value.get('frames') if isinstance(value,dict) else None
    if progress and isinstance(frames,list) and frames and all(isinstance(k,str) for k in value) and set(options)<={'ensure_ascii'}:
        parts=[b'{'];done=0;total=len(frames)+len(value)-1
        for i,(key,item) in enumerate(value.items()):
            if i:parts.append(b',')
            parts.extend((encode(key),b':'))
            if key=='frames':
                parts.append(b'[')
                for start in range(0,len(frames),64):
                    if start:parts.append(b',')
                    block=frames[start:start+64];parts.append(encode(block)[1:-1]);done+=len(block)
                    progress('encode',100*done/total)
                parts.append(b']')
            else:parts.append(encode(item));done+=1
            progress('encode',100*done/total)
        parts.append(b'}');body=b''.join(parts);del parts
    else:body=encode(value)
    if progress:progress('encode',100)
    if progress:progress('compress',0)
    # mtime=0 keeps identical content byte-identical, so ETags only change with the data.
    with open(temp, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=GZIP_LEVEL, mtime=0) as out:
        if progress:
            for start in range(0,len(body),256*1024):
                block=body[start:start+256*1024];out.write(block)
                progress('compress',min(99,100*(start+len(block))/len(body)))
        else:out.write(body)
    temp.replace(path)
    if progress:progress('compress',100)

def migrate(prepared):
    """Write compact gzip copies of a finished conversion as *.gz.migrating files.

    The server renames them into place and removes the plain files only after checking, under its
    lock, that no conversion replaced this prepared/ directory meanwhile.
    """
    prepared = Path(prepared); written = []
    for name, transform in (('data.json', compact_data), ('telemetry.json', None)):
        source = prepared / name
        if not source.is_file():
            # A gzip replay in an older format (see REPLAY_V) is rewritten in the current one; telemetry stays.
            source = prepared / (name + '.gz')
            if not transform or not source.is_file(): continue
            value = json.loads(gzip.decompress(source.read_bytes()))
            if value.get('replayV') == REPLAY_V: continue
        else: value = json.loads(source.read_bytes())
        target = prepared / (name + '.gz.migrating')
        write_gzip_json(target, transform(value) if transform else value, **({'ensure_ascii': False} if transform else {}))
        written.append(target.name)
    return written

if __name__ == '__main__':
    # Run per log in a child process so the server never holds a whole replay in memory.
    print(json.dumps(migrate(sys.argv[1])))
