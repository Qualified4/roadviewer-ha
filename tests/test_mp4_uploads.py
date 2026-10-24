"""Downloaded camera MP4s can be imported with their log without losing video."""
import io
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'roadviewer/app'))
os.environ.setdefault('RV_DATA', tempfile.mkdtemp(prefix='rv-mp4-import-'))
import av
import zstandard
import decoder
import server
from test_video_sources import hevc
from werkzeug.exceptions import HTTPException

PEER = {'REMOTE_ADDR': '172.30.32.2'}
HEADERS = {'X-RoadViewer-Request': '1'}
ROUTE = '0000041b--c6f39793a8--1--'


class MP4UploadTests(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(temp) / 'data'; self.root.mkdir()
        uploads = self.root / '.uploads'; uploads.mkdir()
        for name, value in [('ROOT', self.root), ('UPLOADS', uploads), ('auto_convert', False)]:
            self.enterContext(patch.object(server, name, value))
        self.enterContext(patch.object(server, 'submit'))
        self.enterContext(patch.object(server.storage_policy, 'settings',
                                     {'max_bytes': 0, 'policy': 'reject_new', 'pinned_logs': []}))
        self.client = server.app.test_client()
        source = Path(temp) / 'source'; source.mkdir()
        messages = []
        for i in range(8):
            for kind in ('modelV2', 'qRoadEncodeIdx', 'roadEncodeIdx', 'wideRoadEncodeIdx'):
                stamp = 10_000_000_000 + i * 50_000_000
                event = decoder.log.Event.new_message(); event.valid = True
                event.logMonoTime = stamp; event.init(kind)
                values = {'frameId': i, 'timestampEof': stamp}
                if kind == 'modelV2':
                    values.update(laneLines=[], laneLineProbs=[], roadEdges=[], roadEdgeStds=[])
                else:
                    values['segmentId'] = i
                setattr(event, kind, values); messages.append(event.to_bytes())
        self.log = zstandard.ZstdCompressor().compress(b''.join(messages))
        (source / 'rlog.zst').write_bytes(self.log)
        for name in ('fcamera.hevc', 'ecamera.hevc'):
            hevc(source / name)
        with av.open(str(source / 'qcamera.ts'), 'w', format='mpegts') as output:
            stream = output.add_stream('libx264', rate=20)
            stream.width = 160; stream.height = 96; stream.pix_fmt = 'yuv420p'
            stream.options = {'preset': 'ultrafast', 'bf': '0'}
            for i in range(8):
                frame = av.VideoFrame(160, 96, 'yuv420p')
                for plane in frame.planes: plane.update(bytes([32 + i]) * plane.buffer_size)
                for packet in stream.encode(frame): output.mux(packet)
            for packet in stream.encode(): output.mux(packet)
        prepared, _ = decoder.prepare(source / 'rlog.zst')
        self.mp4 = {name: (prepared / name).read_bytes()
                    for name in ('camera.mp4', 'fcamera.mp4', 'ecamera.mp4')}
        self.raw = {name: (source / name).read_bytes()
                    for name in ('qcamera.ts', 'fcamera.hevc', 'ecamera.hevc')}

    def call(self, path, method='GET', **kwargs):
        return self.client.open(path, method=method, headers=HEADERS,
                                environ_overrides=PEER, **kwargs)

    def upload(self, files):
        return self.call('/api/upload', 'POST', data={
            'files': [(io.BytesIO(payload), name) for name, payload in files]})

    def test_downloaded_three_camera_mp4s_round_trip_and_reconvert(self):
        files = [('rlog.zst', self.log), ('qcamera.mp4', self.mp4['camera.mp4']),
                 ('fcamera.mp4', self.mp4['fcamera.mp4']), ('ecamera.mp4', self.mp4['ecamera.mp4'])]
        response = self.upload([(ROUTE + name, payload) for name, payload in files])
        self.assertEqual(response.status_code, 201, response.json)
        item = response.json['logs'][0]; path = self.root / item['id']
        self.assertTrue(item['video'])
        for name, payload in self.mp4.items(): self.assertEqual((path / name).read_bytes(), payload)
        self.assertFalse((path / 'qcamera.mp4').exists())
        meta = server.read_meta(path); meta.update(status='queued', manual_conversion=True)
        server.save_meta(path, meta); server.run_job(item['id'])
        meta = server.read_meta(path); self.assertEqual(meta['status'], 'ready', meta)
        for source, codec, filename in [('qcamera', 'h264', 'qcamera.mp4'),
                                        ('front', 'hevc', 'fcamera.mp4'),
                                        ('wide', 'hevc', 'ecamera.mp4')]:
            response = self.call(f'/api/logs/{item["id"]}/download?source={source}&format=mp4')
            self.assertEqual(response.status_code, 200)
            self.assertIn(ROUTE + filename, response.headers['Content-Disposition'])
            with av.open(io.BytesIO(response.data)) as video:
                self.assertEqual(video.streams.video[0].codec_context.name, codec)
                self.assertEqual(sum(1 for _ in video.decode(video=0)), 8)
            response.close()
        server.clear_prepared(path, meta)
        for name, payload in self.mp4.items(): self.assertEqual((path / name).read_bytes(), payload)
        meta.update(status='queued', manual_conversion=True); server.save_meta(path, meta)
        server.run_job(item['id']); self.assertEqual(server.read_meta(path)['status'], 'ready')

    def test_bare_camera_name_and_chunked_download_alias(self):
        files = [('rlog.zst', self.log), ('camera.mp4', self.mp4['camera.mp4'])]
        upload = self.call('/api/uploads', 'POST', json={
            'files': [{'name': name, 'size': len(data)} for name, data in files]})
        self.assertEqual(upload.status_code, 201)
        sid = upload.json['id']
        for index, (_, payload) in enumerate(files):
            split = len(payload) // 2
            for offset, chunk in [(0, payload[:split]), (split, payload[split:])]:
                self.assertEqual(self.call(f'/api/uploads/{sid}/files/{index}?offset={offset}',
                                          'PUT', data=chunk).status_code, 200)
        response = self.call(f'/api/uploads/{sid}/finish', 'POST')
        self.assertEqual(response.status_code, 201, response.json)
        path = self.root / response.json['logs'][0]['id']
        self.assertEqual((path / 'camera.mp4').read_bytes(), self.mp4['camera.mp4'])

    def test_invalid_mp4_and_playlist_rejected_before_registration(self):
        for data in (b'not MP4', b'#EXTM3U\nhttp://127.0.0.1:9/private.ts\n'):
            response = self.upload([('rlog.zst', self.log), ('camera.mp4', data)])
            self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(self.call('/api/logs').json['logs'], [])
        self.assertFalse(list(self.root.glob('.upload-*')))

    def test_wrong_camera_codec_and_duplicate_formats_rejected(self):
        response = self.upload([('rlog.zst', self.log), ('fcamera.mp4', self.mp4['camera.mp4'])])
        self.assertEqual(response.status_code, 400)
        for files in [ [('qcamera.ts', self.raw['qcamera.ts']), ('qcamera.mp4', self.mp4['camera.mp4'])],
                       [('fcamera.hevc', self.raw['fcamera.hevc']), ('fcamera.mp4', self.mp4['fcamera.mp4'])],
                       [('camera.mp4', self.mp4['camera.mp4']), ('qcamera.mp4', self.mp4['camera.mp4'])] ]:
            response = self.upload([('rlog.zst', self.log), *files])
            self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(self.call('/api/logs').json['logs'], [])

    def test_attach_missing_mp4_without_losing_other_camera(self):
        response = self.upload([('rlog.zst', self.log), ('fcamera.mp4', self.mp4['fcamera.mp4'])])
        rid = response.json['logs'][0]['id']
        response = self.upload([('rlog.zst', self.log), ('qcamera.mp4', self.mp4['camera.mp4'])])
        self.assertEqual(response.status_code, 201, response.json)
        self.assertEqual(response.json['updated'][0]['id'], rid)
        path = self.root / rid
        self.assertEqual((path / 'fcamera.mp4').read_bytes(), self.mp4['fcamera.mp4'])
        self.assertEqual((path / 'camera.mp4').read_bytes(), self.mp4['camera.mp4'])

    def test_duplicates_and_alternate_formats_never_overwrite_camera(self):
        for first, second in [('qcamera.ts', 'camera.mp4'), ('camera.mp4', 'qcamera.ts')]:
            payload = self.raw[first] if first in self.raw else self.mp4[first]
            response = self.upload([('rlog.zst', self.log), (first, payload)])
            rid = response.json['logs'][0]['id']; path = self.root / rid
            other = self.raw[second] if second in self.raw else self.mp4[second]
            response = self.upload([('rlog.zst', self.log), (second, other)])
            self.assertEqual(response.json['updated'], [])
            self.assertTrue(response.json['duplicates'][0]['video_differs'])
            self.assertEqual((path / first).read_bytes(), payload)
            self.assertFalse((path / second).exists())
            self.call(f'/api/logs/{rid}', 'DELETE')
        response = self.upload([('rlog.zst', self.log), ('camera.mp4', self.mp4['camera.mp4'])])
        rid = response.json['logs'][0]['id']
        same = self.upload([('rlog.zst', self.log), ('qcamera.mp4', self.mp4['camera.mp4'])])
        self.assertFalse(same.json['duplicates'][0]['video_differs'])
        different = self.upload([('rlog.zst', self.log), ('camera.mp4', self.mp4['camera.mp4'] + b'\x00\x00\x00\x08free')])
        self.assertTrue(different.json['duplicates'][0]['video_differs'])
        self.assertEqual((self.root / rid / 'camera.mp4').read_bytes(), self.mp4['camera.mp4'])

    def test_device_manifest_accepts_mp4_and_rejects_camera_alias_conflicts(self):
        files = [{'kind': kind, 'size': 100, 'sha256': '0' * 64}
                 for kind in ('rlog.zst', 'qcamera.mp4', 'fcamera.mp4', 'ecamera.mp4')]
        body = {'batch_id': 'mp4_upload_0123456789', 'segments': [
            {'route': '0000041b--c6f39793a8', 'segment': 1, 'files': files}]}
        with server.app.test_request_context('/api/device/uploads', method='POST'):
            self.assertEqual(len(server.devices.batch_files(body)), 4)
            body['segments'][0]['files'] = [files[0], files[1], {'kind': 'qcamera.ts', 'size': 100, 'sha256': '0' * 64}]
            with self.assertRaises(HTTPException) as error:
                server.devices.batch_files(body)
            self.assertEqual(error.exception.description, 'duplicate_file')

    def test_authenticated_device_upload_registers_all_mp4_cameras(self):
        self.enterContext(patch.object(server, 'DEVICE_HOST_PORT', 8443))
        self.enterContext(patch.object(server.devices, 'path', self.root / '.devices.json'))
        self.enterContext(patch.object(server.devices, 'state',
                                     {'master': 'a' * 64, 'devices': {}, 'nonces': {}, 'receipts': {}}))
        self.enterContext(patch.object(server.devices, 'pairing', None))
        self.enterContext(patch.object(server.devices, 'attempts', deque()))
        listener = type('Listener', (), {'getsockname': lambda _: ('127.0.0.1', 8098)})()
        def external(path, method='POST', **kwargs):
            return self.client.open(path, method=method,
                                    environ_overrides={'REMOTE_ADDR': '127.0.0.1', 'gunicorn.socket': listener}, **kwargs)
        code = self.call('/api/settings/devices/pairing', 'POST').json['code']
        device = external('/api/device/pair', json={'code': code, 'metadata': {'name': 'MP4 test'}}).json
        payloads = [('rlog.zst', self.log), ('qcamera.mp4', self.mp4['camera.mp4']),
                    ('fcamera.mp4', self.mp4['fcamera.mp4']), ('ecamera.mp4', self.mp4['ecamera.mp4'])]
        body = {'batch_id': 'mp4_device_0123456789', 'segments': [
            {'route': '0000041b--c6f39793a8', 'segment': 1, 'files': [
                {'kind': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                for name, data in payloads]}]}
        raw = json.dumps(body).encode(); stamp = str(int(time.time())); nonce = 'mp4_nonce_0123456789'
        canonical = '\n'.join(('RV1', device['device_id'], stamp, nonce, 'POST', '/api/device/uploads', hashlib.sha256(raw).hexdigest()))
        headers = {'Content-Type': 'application/json', 'X-RV-Device': device['device_id'],
                   'X-RV-Timestamp': stamp, 'X-RV-Nonce': nonce,
                   'X-RV-Signature': hmac.new(device['device_secret'].encode(), canonical.encode(), hashlib.sha256).hexdigest()}
        response = external('/api/device/uploads', data=raw, headers=headers)
        self.assertEqual(response.status_code, 201, response.json)
        session = response.json; auth = {'Authorization': 'Bearer ' + session['token']}
        for index, (_, data) in enumerate(payloads):
            response = external(f'/api/device/uploads/{session["id"]}/files/{index}?offset=0',
                                'PUT', data=data, headers=auth)
            self.assertEqual(response.status_code, 200, response.json)
        response = external(f'/api/device/uploads/{session["id"]}/finish', headers=auth)
        self.assertEqual(response.status_code, 201, response.json)
        path = self.root / response.json['logs'][0]['id']
        for name, data in self.mp4.items(): self.assertEqual((path / name).read_bytes(), data)


if __name__ == '__main__':
    unittest.main()
