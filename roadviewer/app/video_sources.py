"""Recording names shared by ingestion, storage and conversion (no media imports)."""
SOURCES = {
    'qcamera': ('qcamera.ts', 'camera.mp4', 'qRoadEncodeIdx'),
    'front': ('fcamera.hevc', 'fcamera.mp4', 'roadEncodeIdx'),
    'wide': ('ecamera.hevc', 'ecamera.mp4', 'wideRoadEncodeIdx'),
}
ORIGINALS = tuple(row[0] for row in SOURCES.values())
DERIVED = {row[0]: row[1] for row in SOURCES.values()}
UPLOAD_KINDS = ('rlog.zst', *ORIGINALS)
STORED_KINDS = (*UPLOAD_KINDS, *DERIVED.values())
DEVICE_VIDEO_LIMIT = 2 * 1024**3
DEVICE_BATCH_LIMIT = 8 * 1024**3


def validate_hevc(path):
    # Bound inspection to the leading access unit. Full decoding is done by the worker.
    with path.open('rb') as source:
        header = source.read(65536)
    import re
    units = re.split(b'\x00\x00\x01', header)
    if not header.startswith((b'\x00\x00\x01', b'\x00\x00\x00\x01')) or not any(
        len(unit) >= 2 and not unit[0] & 128 and unit[1] & 7 and (unit[0] >> 1) & 63 in (32, 33, 34)
        for unit in units[1:]
    ):
        raise ValueError('올바른 HEVC 영상 파일이 아닙니다.')
