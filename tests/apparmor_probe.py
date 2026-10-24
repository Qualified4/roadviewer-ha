"""Run ONLY in disposable containers; never opens a device or transmits packets.

Use identical containers with NET_RAW and MKNOD for both profiles, so capability
or seccomp denials do not masquerade as an AppArmor improvement. See the guide.
"""
import argparse
import errno
import os
import socket
import stat
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--expect', required=True, choices=('allowed', 'denied'))
    args = parser.parse_args()
    label = Path('/proc/self/attr/current').read_text().strip()
    if label != args.profile + ' (enforce)':
        raise SystemExit('Expected enforcing profile; observed: ' + label)

    def raw(family, protocol):
        with socket.socket(family, socket.SOCK_RAW, protocol):
            pass

    def mark():
        # Linux >=5.17 accepts NET_RAW or NET_ADMIN for SO_MARK. Docker's
        # default set has NET_RAW and lacks NET_ADMIN. No packet is sent.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 1)

    with tempfile.TemporaryDirectory(prefix='roadviewer-aa-probe-') as folder:
        path = Path(folder) / 'unused-node'
        checks = {
            'IPv4 raw socket': lambda: raw(socket.AF_INET, socket.IPPROTO_ICMP),
            'IPv6 raw socket': lambda: raw(socket.AF_INET6, socket.IPPROTO_ICMPV6),
            'packet socket': lambda: raw(socket.AF_PACKET, socket.htons(3)),
            'NET_RAW use through SO_MARK': mark,
            'device node creation': lambda: os.mknod(path, stat.S_IFCHR | 0o600, os.makedev(1, 3)),
        }
        failed = False
        for name, action in checks.items():
            try:
                action()
                result = 'allowed'
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EPERM):
                    raise SystemExit(f'{name}: inconclusive ({error})') from error
                result = 'denied'
            print(f'{name}: {result}; expected {args.expect}')
            failed |= result != args.expect
        if failed:
            raise SystemExit('Probe mismatch; inspect capabilities/seccomp and AppArmor audit records.')


if __name__ == '__main__':
    main()
