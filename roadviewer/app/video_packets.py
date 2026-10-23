"""Check compressed camera pictures and decoder headers without pixel decoding."""
import hashlib
import re
import av


class Pictures:
    def __init__(self, stream, annex_b=False):
        self.codec = stream.codec_context.name
        if self.codec not in ('h264', 'hevc'):
            raise ValueError('지원하지 않는 영상 코덱입니다.')
        self.filter = None if annex_b else av.bitstream.BitStreamFilterContext(self.codec + '_mp4toannexb', stream)
        self.digest = hashlib.sha256()
        self.headers = set()
        self.count = 0

    def add(self, packet):
        if packet.is_corrupt:
            raise ValueError('손상된 영상 패킷입니다.')
        picture = False
        for part in self.filter.filter(packet) if self.filter else (packet,):
            for unit in re.split(b'\x00\x00\x00?\x01', bytes(part))[1:]:
                unit = unit.rstrip(b'\0')  # Annex B trailing_zero_8bits are not picture data.
                if len(unit) < (2 if self.codec == 'hevc' else 1):
                    raise ValueError('영상 NAL 헤더가 잘렸습니다.')
                kind = (unit[0] >> 1) & 63 if self.codec == 'hevc' else unit[0] & 31
                if kind in ((32, 33, 34) if self.codec == 'hevc' else (7, 8)):
                    self.headers.add((kind, hashlib.sha256(unit).digest()))
                is_picture = kind < 32 if self.codec == 'hevc' else 1 <= kind <= 5
                if is_picture:
                    self.digest.update(len(unit).to_bytes(4, 'big'))
                    self.digest.update(unit)
                    picture = True
        if not picture:
            raise ValueError('영상 패킷에 압축 프레임이 없습니다.')
        self.count += 1

    def finish(self):
        required = {32, 33, 34} if self.codec == 'hevc' else {7, 8}
        if not self.count or not required <= {kind for kind, _ in self.headers}:
            raise ValueError('영상 디코더 헤더가 없거나 프레임이 없습니다.')
        return self.digest.digest(), self.headers


def inspect_mp4(path, times, progress, expected=None):
    stamps = []
    with av.open(str(path)) as inp:
        stream = inp.streams.video[0]
        pictures = Pictures(stream)
        for packet in inp.demux(stream):
            if not packet.size:
                continue
            if packet.pts is None or packet.dts is None or len(stamps) >= len(times):
                raise ValueError('영상 패킷 시간 또는 프레임 수가 올바르지 않습니다.')
            stamps.append(float(packet.pts * packet.time_base))
            pictures.add(packet)
            progress.update('video_verify', percent=100 * len(stamps) / len(times))
        signature = pictures.finish()
        if len(stamps) != len(times) or any(abs(a - b) > .002 for a, b in zip(sorted(stamps), times)):
            raise ValueError('영상 패킷 수 또는 시간이 로그와 일치하지 않습니다.')
        if expected is not None and signature != expected:
            raise ValueError('MP4의 압축 영상 데이터가 원본과 다릅니다.')
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else times[-1] + .05
        return dict(duration=duration, frames=len(stamps), width=stream.width, height=stream.height, codec=pictures.codec)
