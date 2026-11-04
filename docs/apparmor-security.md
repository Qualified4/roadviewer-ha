# AppArmor 보안 정책

한국어 · [English](apparmor-security.en.md)

Road Viewer는 전용 `roadviewer/apparmor.txt`를 사용합니다. Supervisor가 프로필 선언을 설치된 앱 ID로 바꾸고 Docker의 `docker-default` 대신 선택합니다. 두 프로필이 중첩되는 방식은 아닙니다.

## Docker 기준 정책과 추가 제한

정책은 Docker **29.7.2** 기본 보호 규칙 전체를 유지합니다. 마운트 금지, `/proc`·`/sys` 보호, AF_ALG 금지, signal·ptrace 상대 제한을 포함합니다. 기준 소스는 `moby/profiles/apparmor v0.2.1`을 사용하는 [Moby 템플릿](https://github.com/moby/moby/blob/docker-v29.7.2/vendor/github.com/moby/profiles/apparmor/template.go)입니다. 수정하지 않은 템플릿과 Apache-2.0 라이선스는 `tests/fixtures/apparmor/`에 보관합니다. 이는 고정된 회귀 검사 기준이며 최신 Docker 정책을 자동 추적하지 않습니다.

일반 파일·실행 파일, TCP/UDP/Unix 소켓과 capability 정책은 Docker 기준을 유지합니다. 추가한 감사 대상 deny 규칙 5개는 IPv4 raw 소켓, IPv6 raw 소켓, AF_PACKET 소켓, NET_RAW 사용, MKNOD 사용을 차단합니다.

AppArmor의 deny는 Docker capability 비트를 제거하지 않습니다. 빈 `privileged` 목록도 capability가 없다는 뜻은 아닙니다. 추가 capability, 호스트 마운트·네트워크, 인증 변경을 요청하지 않습니다.

내부 signal·ptrace 상대는 `@{profile_name}`을 사용하여 Supervisor의 이름 치환을 지원합니다. unconfined·runc·crun에서 오는 호스트 signal 수신은 유지합니다. dockerd가 unconfined일 때 기준 daemon 상대 규칙으로 처리합니다. 다른 호스트에서는 실제 레이블을 확인하고, 제한된 daemon에는 와일드카드가 아닌 정확한 수신 상대 규칙이 필요합니다.

## 기존 검증 기록

**2026-10-24**에 HAOS 18.3 / Docker 29.7.2 / AppArmor 3.1.7 / Supervisor 2026.10.3(arm64)에서 검증했습니다. 실제 parser·include·커널 기능으로 재생성한 기준 정책과 호스트의 docker-default 바이너리가 일치했습니다. 전용 프로필은 enforce 모드로 실행되었고 Supervisor 보안 점수는 7에서 8로 바뀌었습니다. 이번 문서 갱신에서 운영 검증을 반복하지 않았습니다.

Ingress, TLS 장치 인증, HMAC·Bearer·nonce 거부, 2/8 MiB 조각 전송·재시도, 변환, MP4 Range 재생, 원본 형식 내보내기, 고정 보호, 가상 기록 삭제, 앱 재시작 후 데이터·인증 유지가 대상이었습니다. 제한된 앱 내부에서 H.264와 1080p HEVC 두 소스를 디코딩했습니다. 삭제 대상은 가상 테스트 기록·장치뿐이었습니다.

일회용 기준 컨테이너에서는 5개 탐침 작업이 허용되었고 전용 정책에서는 대응하는 네트워크·capability 감사 기록과 함께 거부되었습니다. capability 비트맵은 동일했습니다. 정상 기능 관찰 구간에는 추가 DENIED 기록이 없었습니다.

테스트 Chromium은 H.264를 재생했지만 HEVC는 지원하지 않았습니다. HEVC 브라우저 재생은 호환되는 클라이언트가 필요합니다. 지속적인 대용량 동시 업로드, 다른 아키텍처, 미래 Docker 버전, 장기 운용까지 보장한 검증은 아닙니다.

Supervisor 2026.10.3의 Docker 인터페이스는 `seccomp=unconfined`를 선택합니다. 해당 버전에서 Docker 기본 seccomp가 앱을 보호한다고 가정하면 안 됩니다. 이 정책은 기존 Supervisor 동작을 변경하지 않습니다.

## 오프라인 검사와 통제된 탐침

```sh
python tests/test_apparmor.py
```

고정 Docker 기준과 비교하고 `apparmor_parser -Q -T -K`로 원본·Supervisor 이름 치환 프로필을 컴파일합니다. 커널에 정책을 로드하지 않습니다. parser가 없으면 skip으로 표시하며 CI는 검사 전에 설치합니다.

`tests/apparmor_probe.py`는 **통제된 테스트 컨테이너용**입니다. enforce 레이블 확인, 패킷 없는 소켓 열기, 미전송 UDP의 SO_MARK로 NET_RAW 검사(Linux 5.17 이상), 자체 임시 디렉터리에 열지 않는 장치 노드 생성을 시도합니다. 기본·전용 프로필의 capability/seccomp 조건을 같게 하고 감사 기록으로 capability 제거와 정책 거부를 구별해야 합니다. 탐침을 위해 운영 앱에 capability를 추가하지 마세요.

## 적용과 롤백

적용 전 앱 데이터·인증을 백업하고 정확한 이전 이미지·배포 소스를 보관합니다. 호스트 parser·기본 abstraction·daemon 레이블·실제 컨테이너 프로필·감사 기록을 확인합니다. 보안 점수만으로 커널 강제 적용을 증명할 수 없습니다.

롤백은 AppArmor를 끄거나 데이터를 덮어쓰지 않고 Supervisor를 통해 이전 앱과 Docker 기본 프로필을 복구해야 합니다. 소스 삭제나 이미지 태그 변경만으로 등록된 정책이 내려가지 않습니다. 이후 `docker-default (enforce)`를 확인하세요. Docker/HAOS 업데이트 후에는 기준 정책을 다시 대조해야 합니다.
