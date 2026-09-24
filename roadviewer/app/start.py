"""Keep one Gunicorn worker/state; nginx terminates optional device TLS."""
import json, os, re, signal, subprocess, time, sys
from urllib.request import Request, urlopen
from pathlib import Path


def device_host_port():
    """Read only our own Supervisor port mapping; never change host networking."""
    token = os.environ.get('SUPERVISOR_TOKEN')
    if not token: return None, 'Supervisor 포트 정보를 확인할 수 없습니다. Home Assistant에서 앱을 재시작하세요.'
    req = Request('http://supervisor/addons/self/info', headers={'Authorization': 'Bearer ' + token})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=5) as response: result = json.load(response)
            if result.get('result') != 'ok': raise ValueError('Supervisor response')
            network = result['data']['network']
            if not isinstance(network, dict): raise ValueError('Invalid network mapping')
            value = network.get('8443/tcp')
            if value is None: return None, None
            if type(value) is str and value.isdecimal(): value = int(value)
            if type(value) is not int or not 1 <= value <= 65535: raise ValueError('Invalid host port')
            return value, None
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            if attempt < 2: time.sleep(1)
    return None, 'Supervisor 포트 조회에 실패해 외부 API를 껐습니다. 네트워크 설정을 확인하고 앱을 재시작하세요.'

def nginx_config(options):
    paths = []
    for key, default in [('device_certfile', 'fullchain.pem'), ('device_keyfile', 'privkey.pem')]:
        value = options.get(key, default)
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', value):
            raise ValueError('TLS certificate/key must be a filename inside /ssl')
        paths.append('/ssl/' + value)
    cert, key = paths
    return f'''pid /tmp/roadviewer-nginx.pid;
worker_processes 1;
error_log /dev/stderr warn;
events {{ worker_connections 128; }}
http {{
 access_log off;
 client_body_temp_path /tmp/roadviewer-nginx-body;
 proxy_temp_path /tmp/roadviewer-nginx-proxy;
 fastcgi_temp_path /tmp/roadviewer-nginx-fastcgi;
 uwsgi_temp_path /tmp/roadviewer-nginx-uwsgi;
 scgi_temp_path /tmp/roadviewer-nginx-scgi;
 limit_req_zone $binary_remote_addr zone=device:1m rate=30r/s;
 limit_conn_zone $binary_remote_addr zone=connections:1m;
 server {{
  listen 8443 ssl;
  ssl_certificate {cert};
  ssl_certificate_key {key};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  client_max_body_size 300k;
  client_body_timeout 30s;
  location /api/device/ {{
   limit_req zone=device burst=60 nodelay;
   limit_req_status 429;
   limit_conn connections 8;
   proxy_pass http://127.0.0.1:8098;
   proxy_set_header Host $host;
   proxy_set_header X-Forwarded-Proto https;
   # Buffer small chunks before using a Gunicorn thread (protect Ingress from slow clients).
   proxy_request_buffering on;
   proxy_read_timeout 180s;
  }}
  location / {{ return 404; }}
 }}
}}
'''

def main():
    options = json.loads(Path('/data/options.json').read_text()) if Path('/data/options.json').exists() else {}
    port, port_error = device_host_port()
    child_env = {**os.environ, 'RV_DEVICE_HOST_PORT': str(port or 0), 'RV_DEVICE_PORT_ERROR': port_error or ''}
    if port_error: print(port_error, file=sys.stderr)
    children = []; stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
        for child in children:
            if child.poll() is None: child.terminate()
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    try:
        if port is not None:
            Path('/tmp/roadviewer-nginx.conf').write_text(nginx_config(options))
            subprocess.run(['nginx', '-t', '-c', '/tmp/roadviewer-nginx.conf'], check=True)
            children.append(subprocess.Popen(['nginx', '-c', '/tmp/roadviewer-nginx.conf', '-g', 'daemon off;']))
        children.append(subprocess.Popen(['gunicorn', '--bind', '0.0.0.0:8099', '--bind', '127.0.0.1:8098', '--workers', '1', '--threads', '4', '--timeout', '180', 'server:app'], env=child_env))
        last_check = 0; cert_stamp = None
        while not stopped and all(child.poll() is None for child in children):
            if port is not None and time.monotonic() - last_check > 60:
                last_check = time.monotonic()
                try:
                    stamp = tuple((Path('/ssl') / options.get(k, default)).stat().st_mtime_ns for k, default in [('device_certfile','fullchain.pem'),('device_keyfile','privkey.pem')])
                except OSError:
                    # Renewal may replace files non-atomically; keep the active certificate.
                    continue
                if cert_stamp is not None and stamp != cert_stamp:
                    if subprocess.run(['nginx', '-t', '-c', '/tmp/roadviewer-nginx.conf']).returncode != 0: continue
                    children[0].send_signal(signal.SIGHUP)
                cert_stamp = stamp
            time.sleep(.5)
        if not stopped: raise RuntimeError('Road Viewer listener exited unexpectedly')
    finally:
        stop()
        for child in children:
            try: child.wait(timeout=15)
            except subprocess.TimeoutExpired: child.kill(); child.wait()

if __name__ == '__main__': main()
