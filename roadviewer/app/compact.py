"""Smaller replay files: drop values the browser can rebuild, round float32 noise, store gzip.

The browser expands the compact form again (see expandReplayData in app.js), so older
uncompressed data.json files and compact ones are read the same way.
"""
import gzip, json, os, sys
from pathlib import Path

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

def compact_data(data, progress=None):
    """In place and idempotent, so migrating an already compact file is harmless."""
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
    if progress:progress(100)
    if infos: data['cameraInfos'] = infos
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
    with open(temp, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=3, mtime=0) as out:
        if progress:
            for start in range(0,len(body),256*1024):
                block=body[start:start+256*1024];out.write(block)
                progress('compress',100*(start+len(block))/len(body))
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
        if not source.is_file(): continue
        value = json.loads(source.read_bytes())
        target = prepared / (name + '.gz.migrating')
        write_gzip_json(target, transform(value) if transform else value, **({'ensure_ascii': False} if transform else {}))
        written.append(target.name)
    return written

if __name__ == '__main__':
    # Run per log in a child process so the server never holds a whole replay in memory.
    print(json.dumps(migrate(sys.argv[1])))
