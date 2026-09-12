import io, os, sys, tempfile, time
from pathlib import Path
os.environ['RV_DATA'] = tempfile.mkdtemp()
os.environ['RV_INGRESS_ONLY'] = '1'
sys.path.insert(0, '/app')
import server
import decoder
c = server.app.test_client()
peer = {'REMOTE_ADDR': '172.30.32.2'}
headers = {'X-RoadViewer-Request': '1'}
assert c.get('/').status_code == 403
assert c.get('/', environ_overrides=peer).status_code == 200
assert c.post('/api/upload', environ_overrides=peer).status_code == 403
assert c.post('/api/upload', headers=headers, environ_overrides=peer, data={'files': (io.BytesIO(b'x'), '../rlog.zst')}).status_code == 400
r = c.post('/api/uploads', headers=headers, environ_overrides=peer, json={'files': [{'name': 'rlog.zst', 'size': 7}]})
assert r.status_code == 201
upload_id = r.json['id']
assert c.post('/api/uploads/' + upload_id + '/finish', headers=headers, environ_overrides=peer).status_code == 409
url = '/api/uploads/' + upload_id + '/files/0'
assert c.put(url + '?offset=1', headers=headers, environ_overrides=peer, data=b'bad').status_code == 409
assert c.put(url + '?offset=0', headers=headers, environ_overrides=peer, data=b'bad').status_code == 200
assert c.put(url + '?offset=3', headers=headers, environ_overrides=peer, data=b' log').status_code == 200
r = c.post('/api/uploads/' + upload_id + '/finish', headers=headers, environ_overrides=peer)
assert r.status_code == 201
assert not (server.UPLOADS / upload_id).exists()
id = r.json['logs'][0]['id']
for _ in range(100):
    item = next(x for x in c.get('/api/logs', environ_overrides=peer).json['logs'] if x['id'] == id)
    if item['status'] == 'error':
        break
    time.sleep(.1)
assert item['status'] == 'error'
assert c.delete('/api/logs/' + id, headers=headers, environ_overrides=peer).status_code == 200
assert not (server.ROOT / id).exists()
assert c.get('/api/logs', environ_overrides=peer).json['logs'] == []
server.pool.shutdown()
print('PASS: schema import, ingress authentication, upload validation, worker error handling, list and deletion')
