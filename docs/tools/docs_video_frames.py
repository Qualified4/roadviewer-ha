"""Still pictures for the documentation video shots (docs/tools/docs_video_shots.cjs runs this; not a test).

For every scene in docs/tools/docs_video_scenes.json and every camera it lists, the frame nearest the scene time is decoded
at full size from <logs>/<log>/<camera>.mp4 and remastered:

1. Denoise: OpenCV's multi-frame non-local means over the frame and its neighbours (look.denoise = filter strength h,
   look.denoise_colour for the colour part, default the same).
2. Windshield reflection: the dashboard reflected in the glass stays put in the picture while the road moves. A low
   per-pixel percentile (reflection.q) over many frames of the same segment (reflection.from..to s, every
   reflection.step frames) is the reflection plus the darkest the scene got there. Vehicles must not leak into it (a
   lead car that stays at one place for half a minute would otherwise be taken for part of the reflection), so in every
   frame the box of every tracked vehicle (lead, radar targets, the car's ccnc targets from <log>/data.json, projected
   with that frame's overlay camera geometry) is left out of that pixel's percentile; where too few frames remain
   (reflection.min_frames) no reflection is taken off. The part of the percentile image that stands above a smooth
   lower envelope (grey erosion of reflection.floor px, then blurred) is the reflection layer. Its fine texture is
   fitted to this frame locally (the dashboard's lighting changes) and subtracted in linear light inside
   reflection.area (polygons) with feathered edges. Scenes without "reflection" skip this.
3. Tone: levels (look.black/white percentiles), gamma, local contrast (CLAHE on lightness, look.local),
   saturation, and an unsharp mask on lightness clamped to the 3x3 neighbourhood so edges get no halos (look.sharpen).
4. Erase: inside every listed box (licence plates, readable signs) the object itself is found (pixels that differ from
   the ring around the box, Otsu threshold; the convex hull of each part, slightly grown), so the erased area follows
   the plate or sign instead of the box. That shape is filled by OpenCV inpainting from the pixels around it, softened
   and given the grain of its surroundings. {"box": [...], "unlit": true} marks a lit sign: its glow is included and
   it is filled from the dark surroundings. {"ink": [[x, y], ...]} keeps the plate, sign or card and takes only its
   writing off: inside that polygon (drawn inside the plate's border) the plate's own colour is put back (a closing or
   opening wider than a stroke), so a blank plate, sign or card is left; "writing": "dark" or "light" says which
   (default: guessed).

Writes <out>/<scene>-<camera>.png, the untouched frame as <out>/raw/<scene>-<camera>.png, the estimated reflection
layer (x8) as <out>/reflection/<scene>-<camera>.png and, per box, a 4x crop of the result (left with the erased shape outlined) as
<out>/check/<scene>-<camera>-<n>.png.

Usage: python docs_video_frames.py <scenes.json> <logs folder> <out folder>
Needs: av (PyAV), numpy, opencv-python-headless (an offline docs tool; not used by the app or the tests).
"""
import json
import os
import sys

import av
import cv2
import numpy as np


def decode(path, time, step=1, until=None, start=None):
    """Frames (time, rgb24) of the video: every step-th frame from start to until, or the few around time."""
    frames = []
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = 'AUTO'
        for index, frame in enumerate(container.decode(stream)):
            at = float(frame.pts * stream.time_base)
            if start is not None:
                if at > until:
                    break
                if at >= start and index % step == 0:
                    frames.append((at, frame.to_ndarray(format='rgb24')))
            elif abs(at - time) < .16:
                frames.append((at, frame.to_ndarray(format='rgb24')))
            elif at > time + 1:
                break
    return frames


def write_png(path, pixels):
    cv2.imwrite(path, cv2.cvtColor(np.ascontiguousarray(pixels), cv2.COLOR_RGB2BGR))


def to_linear(image8):
    return (image8.astype(np.float32) / 255) ** 2.2


def to_srgb(linear):
    return np.clip(linear, 0, 1) ** (1 / 2.2)


def region_mask(shape, polygons, feather):
    mask = np.zeros(shape[:2], np.float32)
    cv2.fillPoly(mask, [np.array(p, np.int32) for p in polygons], 1.0)
    return cv2.GaussianBlur(mask, (0, 0), feather)[..., None]


def high_pass(image):
    """The fine texture (dot pattern scale): band between 0.7 and 3 px."""
    grey = image.mean(axis=2)
    return cv2.GaussianBlur(grey, (0, 0), .7) - cv2.GaussianBlur(grey, (0, 0), 3)


def vehicle_boxes(frame, size, margin=10):
    """Image boxes [x0, y0, x1, y1] covering every tracked vehicle of a replay frame (lateral offset: + = right)."""
    geometry = ((frame.get('overlay') or {}).get('geometry') or {})
    basis, height = geometry.get('basis'), geometry.get('height') or 1.22
    if not basis:
        return []
    basis = np.array(basis, np.float64)
    width_px, height_px = size
    spots = []
    if frame.get('selected'):
        spots.append((frame['selected']['x'], frame['selected']['y']))
    spots += [(lead['x'], lead['y']) for lead in frame.get('leads') or [] if lead.get('p', 1) > .5]
    spots += [(t['x'], -t.get('yRel', 0)) for t in frame.get('radarTargets') or []]
    spots += [(t['x'], t.get('y', 0)) for t in frame.get('ccncTargets') or []]
    boxes = []
    for x, y in spots:
        if not (np.isfinite(x) and np.isfinite(y)) or x < 2 or x > 150:
            continue
        corners = []
        for dy in (-1.3, 1.3):
            for z in (height, height - 3.2):  # ground to the roof of a truck
                for dx in (0, 4):  # rear to front: the side of a car next to us
                    q = np.array([x + dx, y + dy, z]) @ basis
                    if q[2] > .1:
                        corners.append((q[0] / q[2] * width_px, q[1] / q[2] * height_px))
        if corners:
            us, vs = zip(*corners)
            boxes.append([int(min(us)) - margin, int(min(vs)) - margin, int(max(us)) + margin, int(max(vs)) + margin])
    return boxes


def masked_percentile(stack, covered, q, min_frames):
    """Per pixel, the q-th percentile of the frames where it is not covered; also where too few frames are left."""
    out = np.empty(stack.shape[1:], np.uint8)
    few = np.empty(stack.shape[1:3], bool)
    for y in range(0, stack.shape[1], 32):  # row bands keep the sort small
        band = stack[:, y:y + 32].copy()
        hidden = covered[:, y:y + 32]
        band[hidden] = 255  # sorts last
        band.sort(axis=0)
        valid = (~hidden).sum(axis=0)
        k = np.round(np.maximum(valid - 1, 0) * q / 100).astype(np.intp)
        out[y:y + 32] = np.take_along_axis(band, k[None, ..., None].repeat(3, -1), 0)[0]
        few[y:y + 32] = valid < min_frames
    return out, few


def remove_reflection(image, path, replay, setting):
    """image: linear frame. Returns the frame without the reflection, the layer taken off and a note."""
    decoded = decode(path, None, setting.get('step', 3), setting['to'], setting['from'])
    height, width = image.shape[:2]
    stack = np.stack([f for _, f in decoded])
    covered = np.zeros(stack.shape[:3], bool)
    if setting.get('mask_vehicles', True) and replay:
        times = np.array([f['t'] for f in replay])
        for n, (at, _) in enumerate(decoded):
            frame = replay[int(np.argmin(np.abs(times - at)))]
            for x0, y0, x1, y1 in vehicle_boxes(frame, (width, height)):
                covered[n, max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = True
    low8, few = masked_percentile(stack, covered, setting.get('q', 5), setting.get('min_frames', 12))
    del stack
    low = to_linear(low8)
    size = setting.get('floor', 41)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    floor = np.minimum(cv2.GaussianBlur(cv2.erode(low, kernel), (0, 0), size / 2), low)
    layer = cv2.GaussianBlur(np.maximum(low - floor, 0), (0, 0), setting.get('smooth', 1.2))
    trusted = cv2.GaussianBlur(cv2.erode((~few).astype(np.float32), np.ones((15, 15), np.uint8)), (0, 0), 6)
    layer *= region_mask(image.shape, setting['area'], setting.get('feather', 12)) * trusted[..., None]
    # The dashboard is lit differently from frame to frame and from place to place (shadows move over it): fit how
    # strong the layer's fine texture is in this frame, locally (weighted least squares, blurred over gain_radius px).
    detail, own = high_pass(layer), high_pass(image)
    radius = setting.get('gain_radius', 40)
    num = cv2.GaussianBlur(detail * own, (0, 0), radius)
    den = cv2.GaussianBlur(detail * detail, (0, 0), radius)
    gain = np.clip(num / np.maximum(den, den.max() * 1e-3), 0, setting.get('max_gain', 4))
    # Take the texture off only where this frame really shows it (local correlation with the layer): where the
    # dashboard is in shadow or the glass shows no reflection, subtracting it would print the pattern in negative.
    match = num / np.sqrt(np.maximum(den * cv2.GaussianBlur(own * own, (0, 0), radius), 1e-12))
    low_r, high_r = setting.get('match', [.15, .4])
    gain *= np.clip((match - low_r) / (high_r - low_r), 0, 1)
    gain = cv2.GaussianBlur(gain, (0, 0), radius / 2)[..., None] * setting.get('strength', 1.0)
    # Only the fine texture takes the local gain (it averages to zero, so it cannot leave dark blots); the smooth
    # part of the layer is taken off at most once.
    smooth = cv2.GaussianBlur(layer, (0, 0), 3)
    taken = np.maximum(smooth * np.minimum(gain, 1) + (layer - smooth) * gain, 0)
    # Never take more than (1 - keep) of a pixel, so dark road under a bright reflection does not turn black.
    taken = np.minimum(taken, cv2.GaussianBlur(image, (0, 0), 2) * (1 - setting.get('keep', .4)))
    inside = region_mask(image.shape, setting['area'], 1)[..., 0] > .5
    shown = layer.mean(axis=2) > 0
    note = (f'reflection from {len(decoded)} frames ({covered.mean() * 100:.0f}% of pixels hidden by vehicles, '
            f'{(few & inside).mean() / max(inside.mean(), 1e-6) * 100:.1f}% of the area left alone), '
            f'gain median {float(np.median(gain[shown])):.2f}, taken off on {(gain[..., 0][shown] > .1).mean() * 100:.0f}%')
    return np.maximum(image - taken, 0), taken, note


def denoise(frames, at_index, strength, colour):
    if strength <= 0:
        return frames[at_index]
    bgr = [cv2.cvtColor(f, cv2.COLOR_RGB2BGR) for f in frames]
    window = min(len(bgr), 5) | 1
    centre = min(max(at_index, window // 2), len(bgr) - 1 - window // 2)
    if len(bgr) < 3:
        out = cv2.fastNlMeansDenoisingColored(bgr[at_index], None, strength, colour, 5, 17)
    else:
        bgr = bgr[centre - window // 2:centre + window // 2 + 1]
        out = cv2.fastNlMeansDenoisingColoredMulti(bgr, window // 2 + (at_index - centre), window, None,
                                                   strength, colour, 5, 17)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def tone(image, look):
    """image: sRGB float 0..1 -> remastered sRGB float."""
    luma = image @ np.array([.299, .587, .114], np.float32)
    low, high = np.percentile(luma, [look.get('black', .3), look.get('white', 99.7)])
    image = np.clip((image - low) / max(high - low, 1e-3), 0, 1) ** look.get('gamma', 1.0)
    lab = cv2.cvtColor(image.astype(np.float32), cv2.COLOR_RGB2LAB)
    lightness = lab[..., 0]
    if look.get('local', 0) > 0:
        clahe = cv2.createCLAHE(clipLimit=look.get('clip', 1.6), tileGridSize=(8, 8))
        equalised = clahe.apply(np.clip(lightness * 655.35, 0, 65535).astype(np.uint16)).astype(np.float32) / 655.35
        lightness = lightness + (equalised - lightness) * look['local']
    if look.get('sharpen', 0) > 0:
        detail = lightness - cv2.GaussianBlur(lightness, (0, 0), look.get('radius', 1.0))
        sharp = lightness + detail * look['sharpen']
        kernel = np.ones((3, 3), np.uint8)
        lightness = np.clip(sharp, cv2.erode(lightness, kernel), cv2.dilate(lightness, kernel))
    lab[..., 0] = lightness
    lab[..., 1:] *= look.get('saturation', 1.05)
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)


def object_shape(image8, box, unlit):
    """Mask (uint8 0/255, full size) of the plate or sign inside box: what differs from the ring around the box."""
    height, width = image8.shape[:2]
    x0, y0, x1, y1 = box
    pad = max(4, (y1 - y0) // 3)
    ox0, oy0, ox1, oy1 = max(0, x0 - pad), max(0, y0 - pad), min(width, x1 + pad), min(height, y1 + pad)
    region = image8[oy0:oy1, ox0:ox1].astype(np.float32)
    in_box = np.zeros(region.shape[:2], bool)
    in_box[y0 - oy0:y1 - oy0, x0 - ox0:x1 - ox0] = True
    ring = region[~in_box]
    if unlit:  # a lit sign: brightness above the dark surroundings, glow included
        luma = region.mean(axis=2)
        base = np.percentile(ring.mean(axis=1), 50)
        found = (luma > base + (luma[in_box].max() - base) * .05) & in_box
    else:
        diff = np.linalg.norm(region - np.median(ring, axis=0), axis=2)
        diff = cv2.GaussianBlur(diff, (0, 0), .8)
        scaled = np.clip(diff / max(diff[in_box].max(), 1) * 255, 0, 255).astype(np.uint8)
        threshold, _ = cv2.threshold(scaled[in_box], 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        found = (scaled > threshold) & in_box
    found = cv2.morphologyEx(found.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(found)
    shape = np.zeros(region.shape[:2], np.uint8)
    smallest = max(4, in_box.sum() * .01)
    parts = [n for n in range(1, count) if stats[n, cv2.CC_STAT_AREA] >= smallest]
    if parts and not unlit:  # a plate is one convex shape: the hull of all its parts
        points = cv2.findNonZero(np.isin(labels, parts).astype(np.uint8))
        cv2.fillConvexPoly(shape, cv2.convexHull(points), 255)
    for n in parts if unlit else []:  # a sign may be several lit parts
        cv2.fillConvexPoly(shape, cv2.convexHull(cv2.findNonZero((labels == n).astype(np.uint8))), 255)
    if shape.sum() / 255 < in_box.sum() * .15:  # nothing clear found: an ellipse filling the box
        cv2.ellipse(shape, ((float(x0 + x1) / 2 - ox0, float(y0 + y1) / 2 - oy0), (float(x1 - x0), float(y1 - y0)), 0),
                    255, -1)
    grow = 2 + (y1 - y0) // (4 if unlit else 12)
    shape = cv2.dilate(shape, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))
    mask = np.zeros((height, width), np.uint8)
    mask[oy0:oy1, ox0:ox1] = shape
    return mask


def erase_ink(image8, polygon, seed, writing=None):
    """Take the writing off a plate, sign or card: inside polygon, put back the plate's own colour.

    The plate colour under the writing is a morphological closing (dark writing on a light plate) or opening (light
    writing on a dark sign) wider than a stroke, smoothed; it replaces the polygon with soft edges and the grain of
    the plate."""
    height, width = image8.shape[:2]
    area = np.zeros((height, width), np.uint8)
    cv2.fillPoly(area, [np.array(polygon, np.int32)], 255)
    x, y, w, h = cv2.boundingRect(np.array(polygon, np.int32))
    pad = 8
    ox0, oy0, ox1, oy1 = max(0, x - pad), max(0, y - pad), min(width, x + w + pad), min(height, y + h + pad)
    crop, inside = image8[oy0:oy1, ox0:ox1], area[oy0:oy1, ox0:ox1]
    pixels = crop.astype(np.float32)
    luma = pixels.mean(axis=2)
    dark_writing = writing == 'dark' if writing else luma[inside > 0].mean() < np.median(luma[inside > 0])
    # Only the plate counts: outside the polygon takes the plate's median so the closing/opening sees no border.
    plate = pixels.copy()
    plate[inside == 0] = np.median(pixels[inside > 0], axis=0)
    size = max(7, int(h * .8) | 1)  # wider than the gaps between characters
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    base = cv2.morphologyEx(plate, cv2.MORPH_CLOSE if dark_writing else cv2.MORPH_OPEN, kernel)
    base = cv2.GaussianBlur(cv2.medianBlur(np.clip(base, 0, 255).astype(np.uint8), 5).astype(np.float32), (0, 0), 1.5)
    # Grain from the bare plate only (pixels near the plate colour), not from the writing's edges.
    bare = (inside > 0) & (np.abs(luma - base.mean(axis=2)) < 8)
    fine = np.abs(luma - cv2.GaussianBlur(luma, (0, 0), 1.2))
    grain = min(1.4826 * np.median(fine[bare]) * .5 if bare.any() else 0, 2.5)
    noise = cv2.GaussianBlur(np.random.default_rng(seed).normal(0, 1, luma.shape).astype(np.float32), (0, 0), .7)
    base += (noise / max(noise.std(), 1e-6) * grain)[..., None]
    soft = cv2.GaussianBlur(inside.astype(np.float32) / 255, (0, 0), .8)[..., None]
    image8[oy0:oy1, ox0:ox1] = np.clip(base * soft + pixels * (1 - soft) + .5, 0, 255).astype(np.uint8)
    return area


def entry_box(entry):
    if isinstance(entry, dict) and 'ink' in entry:
        x, y, w, h = cv2.boundingRect(np.array(entry['ink'], np.int32))
        return [x, y, x + w, y + h]
    return entry['box'] if isinstance(entry, dict) else entry


def erase(image8, entry, seed):
    if isinstance(entry, dict) and 'ink' in entry:
        return erase_ink(image8, entry['ink'], seed, entry.get('writing'))
    box, unlit = (entry['box'], entry.get('unlit', False)) if isinstance(entry, dict) else (entry, False)
    height, width = image8.shape[:2]
    mask = object_shape(image8, box, unlit)
    x0, y0, x1, y1 = box
    pad = (y1 - y0) + 12
    ox0, oy0, ox1, oy1 = max(0, x0 - pad), max(0, y0 - pad), min(width, x1 + pad), min(height, y1 + pad)
    crop, inside = image8[oy0:oy1, ox0:ox1], mask[oy0:oy1, ox0:ox1]
    source = crop.copy()
    if unlit:  # fill from the dark part of the surroundings only, so no glow is spread into the shape
        luma = crop.astype(np.float32).mean(axis=2)
        ring = (inside == 0) & (cv2.dilate(inside, np.ones((9, 9), np.uint8)) > 0)
        dark = np.percentile(luma[ring], 40)
        bright = (luma > dark * 1.6 + 6) & (inside == 0)
        source[bright] = np.median(crop[ring & ~bright], axis=0) if (ring & ~bright).any() else crop[ring].min(0)
    filled = cv2.cvtColor(cv2.inpaint(cv2.cvtColor(source, cv2.COLOR_RGB2BGR), inside, 4, cv2.INPAINT_NS),
                          cv2.COLOR_BGR2RGB).astype(np.float32)
    filled = np.where(inside[..., None] > 0, cv2.GaussianBlur(filled, (0, 0), 1.2), filled)
    # Grain like the surroundings (in lightness), so the patch is neither flat nor smoother than the picture.
    outside = (inside == 0) & (cv2.dilate(inside, np.ones((15, 15), np.uint8)) > 0)
    luma = crop.astype(np.float32).mean(axis=2)
    fine = np.abs(luma - cv2.GaussianBlur(luma, (0, 0), 1.2))[outside]
    grain = 1.4826 * np.median(fine) * .5 if fine.size else 0  # robust: edges and lights around are not grain
    noise = cv2.GaussianBlur(np.random.default_rng(seed).normal(0, 1, inside.shape).astype(np.float32), (0, 0), .7)
    filled += (noise / max(noise.std(), 1e-6) * grain)[..., None]
    feather = max(1.0, (y1 - y0) / 12) if unlit else 1.0  # a large dark fill fades into the night around it
    soft = cv2.GaussianBlur(inside.astype(np.float32) / 255, (0, 0), feather)
    soft = np.maximum(soft, cv2.erode(inside, np.ones((3, 3), np.uint8)).astype(np.float32) / 255)[..., None]
    image8[oy0:oy1, ox0:ox1] = np.clip(filled * soft + crop.astype(np.float32) * (1 - soft) + .5, 0, 255).astype(np.uint8)
    return mask


def main(scenes_file, logs, out):
    scenes = json.load(open(scenes_file, encoding='utf-8'))['scenes']
    for folder in ('raw', 'check', 'reflection'):
        os.makedirs(os.path.join(out, folder), exist_ok=True)
    for name, scene in scenes.items():
        if scene.get('frame'):  # borrows another scene's picture (a panel capture that does not show the video)
            continue
        for camera, boxes in scene['cameras'].items():
            path = os.path.join(logs, scene['log'], camera + '.mp4')
            near = decode(path, scene['time'])
            index = min(range(len(near)), key=lambda i: abs(near[i][0] - scene['time']))
            at, pixels = near[index]
            write_png(os.path.join(out, 'raw', f'{name}-{camera}.png'), pixels)
            look = scene.get('look', {})
            strength = look.get('denoise', 0)
            image = to_linear(denoise([f for _, f in near], index, strength, look.get('denoise_colour', strength)))
            note = 'no reflection step'
            if 'reflection' in scene:
                replay = json.load(open(os.path.join(logs, scene['log'], 'data.json'), encoding='utf-8'))['frames']
                image, layer, note = remove_reflection(image, path, replay, scene['reflection'])
                write_png(os.path.join(out, 'reflection', f'{name}-{camera}.png'),
                          (to_srgb(layer * 8) * 255 + .5).astype(np.uint8))
            result = (tone(to_srgb(image), look) * 255 + .5).astype(np.uint8)
            masks = [erase(result, entry, n) for n, entry in enumerate(boxes)]
            write_png(os.path.join(out, f'{name}-{camera}.png'), result)
            for n, (entry, mask) in enumerate(zip(boxes, masks)):
                x0, y0, x1, y1 = entry_box(entry)
                window = (slice(max(0, y0 - 24), y1 + 24), slice(max(0, x0 - 40), x1 + 40))
                outline = result[window].copy()
                contours, _ = cv2.findContours(mask[window], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
                cv2.drawContours(outline, contours, -1, (255, 255, 0), 1)
                pair = np.hstack([outline, np.full((outline.shape[0], 2, 3), 255, np.uint8), result[window]])
                write_png(os.path.join(out, 'check', f'{name}-{camera}-{n}.png'), pair.repeat(4, 0).repeat(4, 1))
            print(f'{name}-{camera}: frame {at:.3f} s for {scene["time"]} s, {len(boxes)} boxes, {note}', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:4])
