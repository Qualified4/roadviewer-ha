# AppArmor security policy

Road Viewer uses a dedicated `roadviewer/apparmor.txt`. Supervisor replaces the
profile declaration with the installed app ID and selects that profile instead
of Docker's `docker-default`; the profiles are not stacked.

## Docker baseline and additional restrictions

The policy retains Docker 29.7.2's complete default protection rules, including
mount denial, protected /proc and /sys access, AF_ALG denial, and signal/ptrace
peer restrictions. Source: [Moby template](https://github.com/moby/moby/blob/docker-v29.7.2/vendor/github.com/moby/profiles/apparmor/template.go),
using `moby/profiles/apparmor v0.2.1`. The unmodified template and Apache-2.0
license are retained in `tests/fixtures/apparmor/`.

General file/executable, TCP/UDP/Unix socket, and capability policy remains as
in the Docker baseline. Five audited deny rules additionally block:

- IPv4 and IPv6 raw sockets;
- AF_PACKET sockets;
- NET_RAW capability use;
- MKNOD capability use.

AppArmor denies do not remove capability bits from Docker's capability sets.
An empty `privileged` list does not mean the container has no capabilities.
No extra capabilities, host mounts, host networking, or authentication changes
are requested by this change.

Internal signal and ptrace peers use `@{profile_name}` so Supervisor's profile
name replacement remains correct. Host signal reception from unconfined,
runc, and crun is retained. The baseline daemon peer is covered when dockerd
is unconfined; verify its actual label before using this policy on another host.
A confined daemon needs its precise receive peer rule, rather than a wildcard.

## Validation

On 2026-10-24 the policy was tested on HAOS 18.3 / Docker 29.7.2 /
AppArmor 3.1.7 / Supervisor 2026.10.3 (arm64). The host's loaded docker-default
binary matched a regeneration using its actual parser, includes and kernel
features. The dedicated profile ran in enforce mode and Supervisor reported
security rating 8 (previously 7).

Tests covered Ingress, TLS device authentication, HMAC/Bearer/nonce rejection,
2 MiB and 8 MiB chunked uploads/retries, conversion, MP4 range streaming,
original-format exports, pin protection, deletion of synthetic recordings,
and data/authentication retention across app restart. H.264 and two 1080p HEVC
sources decoded successfully inside the confined app. Only synthetic test
recordings/devices were removed.

Disposable baseline controls allowed the five probed operations. The confined
app denied them with matching network and capability audit records, while its
capability bitmap remained unchanged. Normal-function checks produced no
additional DENIED records during that observation window.

The test Chromium client could play H.264 but did not support HEVC. HEVC
browser playback still needs a compatible client. Large sustained concurrent
uploads, other architectures, future Docker versions and long-term operation
are not established by this validation.

Supervisor 2026.10.3's Docker interface selects `seccomp=unconfined`; do not
assume Docker's default seccomp filter protects this app on that version.
This policy does not change that existing Supervisor behavior.

## Offline checks and safe enforcement probes

```sh
python tests/test_apparmor.py
```

The tests compare against the pinned Docker baseline and compile both original
and Supervisor-renamed profiles with `apparmor_parser -Q -T -K`. They do not
load policies into the kernel. Missing parser support is reported as a skip.
CI installs the parser before running these checks.

`tests/apparmor_probe.py` is for controlled test containers only. It validates
the current enforce label, opens sockets without sending packets, uses SO_MARK
on an unsent UDP socket to exercise NET_RAW (Linux >=5.17), and attempts to
create an unopened device node in its own temporary directory. Use identical
capability/seccomp conditions for default and custom profiles, and inspect
AppArmor audit records to distinguish capability removal from policy denial.
Never grant capabilities to the production app just to run a probe.

## Deployment and rollback

Back up current app data/authentication and retain the exact previous image
and deployment sources before applying the profile. Verify the host parser,
base abstractions, daemon label, actual container profile and audit records.
A security rating alone does not prove kernel enforcement.

Rollback must restore the previous app deployment and Docker default profile
through Supervisor, without disabling AppArmor or overwriting app data.
Deleting a source file or changing an image tag alone does not unload an
already registered custom policy. Verify `docker-default (enforce)` afterward.
Recheck the baseline after Docker or HAOS updates; the pinned regression
fixture does not automatically track future upstream protection changes.
