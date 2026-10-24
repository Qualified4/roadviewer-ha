"""Recording names shared by ingestion, storage and conversion (no media imports)."""
SOURCES = {
    'qcamera': ('qcamera.ts', 'camera.mp4', 'qRoadEncodeIdx'),
    'front': ('fcamera.hevc', 'fcamera.mp4', 'roadEncodeIdx'),
    'wide': ('ecamera.hevc', 'ecamera.mp4', 'wideRoadEncodeIdx'),
}
ORIGINALS = tuple(row[0] for row in SOURCES.values())
DERIVED = {row[0]: row[1] for row in SOURCES.values()}
VIDEO_KINDS = (*ORIGINALS, *DERIVED.values())
CAMERA_KINDS = {kind: source for source, row in SOURCES.items() for kind in row[:2]}
CAMERA_KINDS['qcamera.mp4'] = 'qcamera'
UPLOAD_KINDS = ('rlog.zst', *VIDEO_KINDS, 'qcamera.mp4')
STORED_KINDS = ('rlog.zst', *VIDEO_KINDS)
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


def validate_mp4(path):
    # Force the local MOV/MP4 demuxer; an uploaded playlist must not fetch URLs.
    import av
    expected = 'h264' if path.name == 'camera.mp4' else 'hevc'
    try:
        with av.open(str(path), format='mov', options={'enable_drefs': '0', 'use_absolute_path': '0'}) as container:
            if len(container.streams.video) != 1:
                raise ValueError('MP4에는 카메라 영상이 하나만 있어야 합니다.')
            stream = container.streams.video[0]
            if stream.codec_context.name != expected:
                raise ValueError('카메라 종류와 MP4 영상 코덱이 일치하지 않습니다.')
            if not (0 < stream.width <= 4096 and 0 < stream.height <= 2160) or stream.width % 2 or stream.height % 2:
                raise ValueError('지원하지 않는 카메라 해상도입니다.')
    except OSError as error:
        raise ValueError('올바른 MP4 영상 파일이 아닙니다.') from error
