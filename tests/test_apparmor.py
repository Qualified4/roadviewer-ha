"""Offline policy checks; these do not prove kernel enforcement."""
import hashlib
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / 'roadviewer/apparmor.txt'
EXTRA = {
    'audit deny network inet raw,',
    'audit deny network inet6 raw,',
    'audit deny network packet,',
    'audit deny capability net_raw,',
    'audit deny capability mknod,',
}


def rules(text):
    return {line.split('#', 1)[0].strip() for line in text.splitlines()
            if line.split('#', 1)[0].strip().endswith(',')}


class AppArmorTests(unittest.TestCase):
    def test_docker_baseline_is_preserved_and_only_denials_added(self):
        source = (ROOT / 'tests/fixtures/apparmor/docker-default-29.7.2.go').read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(),
                         '2e9f9780a9b64d4f547f8563399d1147b22d810d973701688b5eb4cb0ec46168')
        upstream = source.decode()
        upstream = upstream[upstream.index('  network,'):upstream.rindex('\n}')]
        upstream = upstream.replace('"{{.Name}}"', '@{profile_name}')
        # HA OS daemon label must be checked before deployment. Its expected
        # unconfined receive rule is already present in the upstream template.
        upstream = upstream.replace('"{{.DaemonProfile}}"', 'unconfined')
        current = POLICY.read_text()
        body = current.split('flags=(attach_disconnected,mediate_deleted) {', 1)[1]
        self.assertEqual(rules(body), rules(upstream) | EXTRA)
        self.assertTrue(EXTRA.isdisjoint(rules(upstream)))
        self.assertIn('#include if exists <abstractions/base>', body)
        self.assertIn('abi <abi/3.0>,', current)
        self.assertIn('#include <tunables/global>', current)

    def test_supervisor_format_and_inherited_confinement(self):
        policy = POLICY.read_text()
        self.assertEqual(re.findall(r'^profile (\S+)', policy, re.M), ['roadviewer'])
        self.assertNotIn('complain', re.search(r'flags=\(([^)]+)\)', policy)[1])
        self.assertNotRegex(policy, r'\b(?:ux|Ux|px|Px|cx|Cx)\b')
        self.assertIn('signal (send,receive) peer=@{profile_name},', policy)
        self.assertIn('ptrace (trace,tracedby,read,readby) peer=@{profile_name},', policy)
        self.assertNotRegex(policy, r'peer=(?:docker-default|roadviewer),')
        config = (ROOT / 'roadviewer/config.yaml').read_text()
        self.assertRegex(config, r'(?m)^slug: roadviewer$')
        self.assertNotRegex(config, r'(?m)^apparmor: false$')

    @unittest.skipUnless(shutil.which('apparmor_parser'), 'apparmor_parser unavailable')
    def test_parser_before_and_after_supervisor_rename(self):
        policy = POLICY.read_text()
        with tempfile.TemporaryDirectory() as folder:
            for name in ('roadviewer', 'f21b33c3_roadviewer', 'local_roadviewer'):
                path = Path(folder) / name
                # Match Supervisor adjust_profile: only the declaration changes.
                path.write_text(policy.replace('profile roadviewer ', f'profile {name} ', 1))
                result = subprocess.run(['apparmor_parser', '-Q', '-T', '-K', str(path)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
