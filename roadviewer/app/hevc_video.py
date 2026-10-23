"""Remux HEVC losslessly into MP4 using the camera's logged clock."""
from fractions import Fraction
import av
from video_packets import Pictures, inspect_mp4


class VideoProgress:
    """Keep the existing 75–100% video interval monotonic across multiple cameras."""
    def __init__(self, reporter, count):
        self.reporter, self.count, self.index = reporter, count, 0

    def update(self, stage, **fields):
        if self.count <= 1:
            self.reporter.update(stage, **fields)
            return
        percent = fields.get('percent', 0) / 100
        part = percent if stage == 'video_verify' else 0
        self.reporter.update(stage, **fields, video_percent=100 * (self.index + part) / self.count)


def prepare_video(source, output, indices, origin, progress):
    rows = sorted(indices, key=lambda row: row['segmentId'])
    if not rows or [row['segmentId'] for row in rows] != list(range(len(rows))):
        raise ValueError('카메라 프레임 인덱스가 없거나 연속되지 않습니다.')
    stamps = [row['timestampEof'] for row in rows]
    if stamps[0] <= 0 or any(b <= a for a, b in zip(stamps, stamps[1:])):
        raise ValueError('카메라 프레임 시간이 올바르지 않습니다.')
    times = [(stamp - stamps[0]) / 1e9 for stamp in stamps]
    raw = source.suffix == '.hevc'
    expected = None
    if raw:
        try:
            with av.open(str(source)) as inp, av.open(str(output), 'w', options={'movflags': '+faststart'}) as out:
                stream = inp.streams.video[0]
                if stream.codec_context.name != 'hevc':
                    raise ValueError('HEVC 코덱이 아닙니다.')
                width, height = stream.width, stream.height
                if not (0 < width <= 4096 and 0 < height <= 2160) or width % 2 or height % 2:
                    raise ValueError('지원하지 않는 카메라 해상도입니다.')
                target = out.add_stream_from_template(stream, opaque=True)
                target.codec_context.codec_tag = 'hvc1'
                target.codec_context.thread_count = 2
                target.time_base = Fraction(1, 1_000_000)
                pictures = Pictures(stream, annex_b=True)
                count = 0
                for packet in inp.demux(stream):
                    if not packet.size:
                        continue
                    if count >= len(times) or stream.codec_context.has_b_frames:
                        raise ValueError('영상 프레임 수 또는 B 프레임 구성이 지원되지 않습니다.')
                    pictures.add(packet)
                    packet.pts = packet.dts = round(times[count] * 1_000_000)
                    packet.duration = round((times[count + 1] - times[count] if count + 1 < len(times) else .05) * 1_000_000)
                    packet.time_base = target.time_base
                    packet.stream = target
                    out.mux(packet)
                    count += 1
                    progress.update('video_convert', percent=100 * count / len(times))
                if count != len(times):
                    raise ValueError('영상과 로그의 프레임 수가 다릅니다.')
                expected = pictures.finish()
        except Exception:
            output.unlink(missing_ok=True)
            raise
    else:
        output = source  # Reuse the sole retained MP4.
    try:
        return dict(inspect_mp4(output, times, progress, expected), start=stamps[0] / 1e9 - origin)
    except Exception:
        if raw:
            output.unlink(missing_ok=True)
        raise
