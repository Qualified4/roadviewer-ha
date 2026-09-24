"""Keep one Gunicorn worker/state; nginx terminates optional device TLS."""
import json, os, re, signal, subprocess, time
from pathlib import Path

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
    children = []; stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
        for child in children:
            if child.poll() is None: child.terminate()
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    try:
        if options.get('device_api_enabled', False):
            Path('/tmp/roadviewer-nginx.conf').write_text(nginx_config(options))
            subprocess.run(['nginx', '-t', '-c', '/tmp/roadviewer-nginx.conf'], check=True)
            children.append(subprocess.Popen(['nginx', '-c', '/tmp/roadviewer-nginx.conf', '-g', 'daemon off;']))
        children.append(subprocess.Popen(['gunicorn', '--bind', '0.0.0.0:8099', '--bind', '127.0.0.1:8098', '--workers', '1', '--threads', '4', '--timeout', '180', 'server:app']))
        last_check = 0; cert_stamp = None
        while not stopped and all(child.poll() is None for child in children):
            if options.get('device_api_enabled') and time.monotonic() - last_check > 60:
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
