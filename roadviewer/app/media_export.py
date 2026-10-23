"""Stream a retained MP4 back into its camera format without encoding."""
import sys
import av


def export(source, sink, kind, offset=0):
    if kind not in ('hevc', 'mpegts'):
        raise ValueError('Unsupported export container')
    with av.open(source) as inp, av.open(sink, 'w', format=kind) as out:
        stream = inp.streams.video[0]
        expected = 'hevc' if kind == 'hevc' else 'h264'
        if stream.codec_context.name != expected:
            raise ValueError('The retained video cannot restore this codec losslessly')
        target = out.add_stream_from_template(stream, opaque=True)
        target.codec_context.thread_count = 2
        for packet in inp.demux(stream):
            if packet.dts is None:
                continue
            shift = round(float(offset) / float(packet.time_base))
            packet.pts += shift
            packet.dts += shift
            packet.stream = target
            out.mux(packet)


if __name__ == '__main__':
    export(sys.argv[1], sys.stdout.buffer, sys.argv[2], float(sys.argv[3]))
