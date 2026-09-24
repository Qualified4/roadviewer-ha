"""Ingress-only controls for this app's Supervisor port mapping and restart."""
import json, os, subprocess, tempfile, threading, uuid
from urllib.request import Request, urlopen
from flask import request, jsonify


def supervisor(action, body=None, timeout=10):
    token = os.environ.get('SUPERVISOR_TOKEN')
    if not token: raise ValueError('Supervisor unavailable')
    # Callers use only fixed self endpoints; never accept a URL or slug from the UI.
    req = Request('http://supervisor/addons/self/' + action,
                  data=json.dumps(body).encode() if body is not None else None,
                  headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urlopen(req, timeout=timeout) as response: result = json.load(response)
    if result.get('result') != 'ok': raise ValueError('Supervisor request failed')
    return result.get('data') or {}


def mapped_port(info):
    network = info['network']
    if not isinstance(network, dict): raise ValueError('Invalid network mapping')
    value = network.get('8443/tcp')
    if value is None: return None
    if type(value) is str and value.isdecimal(): value = int(value)
    if type(value) is not int or not 1 <= value <= 65535: raise ValueError('Invalid host port')
    return value


def validate_tls(options):
    from start import nginx_config
    with tempfile.NamedTemporaryFile(mode='w', suffix='.conf', prefix='roadviewer-check-') as config:
        config.write(nginx_config(options)); config.flush()
        subprocess.run(['nginx', '-t', '-c', config.name], check=True, capture_output=True, timeout=10)


class DeviceNetwork:
    def __init__(self, s):
        self.s = s
        self.lock = threading.Lock()
        self.boot_id = uuid.uuid4().hex
        self.restarting = False
        self.restart_error = ''
        s.app.add_url_rule('/api/settings/device-network', 'device_network', self.settings, methods=['GET', 'POST'])
        s.app.add_url_rule('/api/settings/device-network/restart', 'device_network_restart', self.restart, methods=['POST'])

    def snapshot(self, port):
        return dict(configured_port=port, active_port=self.s.DEVICE_HOST_PORT,
                    restart_required=port != self.s.DEVICE_HOST_PORT or bool(os.environ.get('RV_DEVICE_PORT_ERROR')),
                    boot_id=self.boot_id, restarting=self.restarting, restart_error=self.restart_error)

    def settings(self):
        with self.lock:
            body = request.get_json(silent=True) if request.method == 'POST' else None
            if request.method == 'POST':
                if not isinstance(body, dict) or set(body) != {'enabled', 'port'} or type(body['enabled']) is not bool:
                    return jsonify(error='invalid_network_settings', message='네트워크 설정을 확인하세요.'), 400
                port = body['port']
                if (body['enabled'] and (type(port) is not int or not 1 <= port <= 65535)) or (not body['enabled'] and port is not None):
                    return jsonify(error='invalid_port', message='포트는 1~65535 사이의 정수로 입력하세요.'), 400
                if self.restarting: return jsonify(error='restarting', message='재시작이 끝난 뒤 설정을 변경하세요.'), 409
            try:
                info = supervisor('info')
                current = mapped_port(info)
                if request.method == 'POST' and current != port:
                    if port is not None:
                        try: validate_tls(info.get('options', {}))
                        except (OSError, ValueError, subprocess.SubprocessError):
                            return jsonify(error='invalid_tls', message='TLS 인증서·키를 확인할 수 없습니다. /ssl 파일과 앱의 인증서 파일명 설정을 확인하세요.'), 400
                    network = dict(info['network']); network['8443/tcp'] = port
                    supervisor('options', {'network': network})
                    current = port
                return jsonify(self.snapshot(current))
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                return jsonify(error='supervisor_unavailable', message='Home Assistant에 설정을 요청하지 못했습니다. 잠시 후 다시 시도하세요.'), 502

    def restart(self):
        with self.lock:
            if self.restarting: return jsonify(self.snapshot(self.s.DEVICE_HOST_PORT)), 202
            try:
                info = supervisor('info'); port = mapped_port(info)
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                return jsonify(error='supervisor_unavailable', message='Home Assistant에 재시작을 요청할 수 없습니다. 잠시 후 다시 시도하세요.'), 502
            if port is not None:
                try: validate_tls(info.get('options', {}))
                except (OSError, ValueError, subprocess.SubprocessError):
                    return jsonify(error='invalid_tls', message='TLS 인증서·키를 확인하세요. 설정을 수정한 뒤 재시작할 수 있습니다.'), 400
            self.restarting = True; self.restart_error = ''
            # Return before Supervisor stops this worker. A new boot ID proves restart.
            timer = threading.Timer(.5, self.restart_app); timer.daemon = True; timer.start()
            return jsonify(self.snapshot(port)), 202

    def restart_app(self):
        try: supervisor('restart', {}, timeout=60)
        except (OSError, ValueError, TypeError, AttributeError):
            with self.lock:
                self.restarting = False
                self.restart_error = '재시작 요청을 완료하지 못했습니다. 현재 적용 상태를 확인하고 다시 시도하세요.'
