# Road Viewer 장치 업로드 API v1

한국어 · [English](device-api.en.md)

구현 기준: **Road Viewer 0.5.3**. 이 저장소는 서버와 웹 UI를 제공하며 호환 장치 업로더는 별도 저장소에서 관리합니다. 기존 브라우저 업로드와 Home Assistant Ingress는 유지됩니다.

공유 데이터 디렉터리는 **Gunicorn worker 1개와 여러 thread**를 전제로 합니다. 같은 디렉터리를 사용하는 worker나 서버 복제본을 추가하지 마세요.

## 배포와 HTTPS

기본 주소는 경로 접두사 없는 `https://<인증서 도메인>:<외부 포트>`입니다. 예: `https://example.com:18443`.

1. Home Assistant의 `/ssl`에 신뢰할 수 있는 인증서와 개인키를 준비합니다. 인증서 SAN에 도메인이 포함되어야 합니다.
2. 앱 옵션에서 다음과 같이 파일명을 지정합니다. 절대 경로가 아니라 `/ssl` 바로 아래 파일명입니다.

   ```yaml
   max_upload_mb: 512
   device_certfile: fullchain.pem
   device_keyfile: privkey.pem
   ```

3. Road Viewer의 **로그 업로드 → 외부 장치 연결**에서 외부 연결을 켜고, 사용하지 않는 HTTPS 호스트 포트를 입력합니다. **네트워크 설정 저장 → 지금 재시작** 순서로 적용합니다. 기본값은 꺼짐(`null`)이며 끄고 저장하면 매핑을 해제합니다.
4. 공유기에서 외부 TCP 포트를 Home Assistant의 해당 호스트 포트로 전달합니다. Ingress 8099나 내부 upstream 8098은 외부로 공개하지 않습니다.
5. 외부 네트워크에서 DNS·인증서·방화벽을 확인합니다. 클라이언트의 TLS 검증을 끄지 않습니다.

앱은 시작 시 Supervisor의 `/addons/self/info`에서 `network["8443/tcp"]`를 읽습니다. 내부 설정은 `/addons/self/options`로 이 앱의 포트 매핑만 변경하며, 명시적인 재시작은 `/addons/self/restart`로 요청합니다. 다른 앱이나 포트 설정은 유지합니다. 별도의 `device_api_enabled` 옵션은 없습니다. 조회 실패 시 외부 API는 꺼진 상태를 유지합니다.

컨테이너 Nginx의 **8443**에서 TLS를 종료하고 `/api/device/`만 **127.0.0.1:8098**로 전달합니다. 같은 Gunicorn worker가 Ingress 8099도 담당합니다. 실제 소켓으로 리스너를 구분하므로 Host나 X-Forwarded 헤더를 조작해 UI·관리 API에 접근할 수 없습니다. Ingress에서는 장치 API를 차단합니다.

인증서는 앱 외부에서 발급·갱신합니다. 앱은 매분 파일 변경을 확인해 유효한 새 인증서 쌍을 재로딩합니다. 갱신 검증 실패 시 기존 TLS 설정을 유지합니다. 초기 인증서 오류는 앱 시작을 차단할 수 있으므로 파일이나 포트 설정을 바로잡아야 합니다. CORS는 제공하지 않고 접근 로그는 비활성화합니다.

## 페어링

Ingress의 **로그 업로드 → 외부 장치 연결 → 새 장치 연결**에서 96비트 난수인 **24자리 대문자 16진수 코드**를 발급합니다. 유효기간은 **300초**, 사용 횟수는 1회입니다. 새 발급·취소·만료·성공·서버 재시작으로 이전 코드는 무효화됩니다. 코드 소모와 장치 등록은 같은 잠금으로 처리합니다.

올바른 형식의 페어링 시도는 전역 분당 10회, 등록 장치는 최대 100개입니다. UI는 대기·완료·만료를 표시하고 복사·새 발급·취소를 지원합니다.

`POST /api/device/pair`, `Content-Type: application/json`:

```json
{"code":"<대문자 16진수 24자리>","metadata":{"name":"My comma","dongle_id":"optional identifier"}}
```

- 본문 최대 4096바이트.
- `metadata.name`: 공백만 아닌 문자열, 최대 80자.
- `dongle_id`: 선택 문자열, 최대 80자. 설명용이며 인증 수단이 아닙니다.
- 추가 필드는 허용하지 않습니다.

201 응답은 최초 한 번만 반환합니다.

```json
{"device_id":"<소문자 16진수 32자리>","device_secret":"<소문자 16진수 64자리>","algorithm":"HMAC-SHA256"}
```

장치는 두 값을 안전하게 영구 보관해야 합니다. UI/API에서 장기 키를 다시 조회할 수 없습니다. 응답을 잃으면 해당 장치를 연결 해제하고 새로 페어링합니다.

서버는 `/data/roadviewer/.devices.json`에 256비트 루트 비밀값, 장치 기록, 재전송 방지 nonce와 완료 영수증을 저장합니다(권한 0600). 장치 키는 루트 비밀값과 고유 ID로 HMAC 파생하며 개별 키 원문은 보관하지 않습니다. 파일 손상 시 조용히 초기화하지 않습니다. 이 인증 설정은 백업 대상이며, 유출되면 모든 장치 키가 영향을 받습니다.

## HMAC 요청 인증

장기 인증은 세션 생성·재연결에만 사용합니다. 장기 키를 다시 전송하지 않습니다.

`POST /api/device/uploads` 헤더:

| 헤더 | 값 |
|---|---|
| `X-RV-Device` | device_id |
| `X-RV-Timestamp` | UTC Unix 초, 10자리 십진수 |
| `X-RV-Nonce` | 새 난수 16~64자, `[A-Za-z0-9_-]`; 최소 128비트 난수 권장 |
| `X-RV-Signature` | HMAC-SHA256 소문자 16진수 |
| `Content-Type` | application/json |

시각 오차는 서버 기준 ±120초입니다. nonce는 허용 시각 구간 전체와 재시작 이후에도 재사용할 수 없습니다. 인증 성공 후 본문 검증·용량 검사에 실패하거나 응답을 잃어도 새 nonce를 사용합니다. 미만료 nonce 기록은 최대 10,000개이며 인증 시 만료분을 정리합니다.

UTF-8 서명 원문은 **LF로 구분하고 끝에는 LF를 붙이지 않습니다.**

```text
RV1
<device_id>
<timestamp 헤더 원문>
<nonce 헤더 원문>
POST
/api/device/uploads
<실제로 전송할 본문 바이트의 SHA256 소문자 16진수>
```

키는 **64자리 secret 문자열의 ASCII 바이트**이며 hex 디코딩한 바이트가 아닙니다. 메서드는 대문자, 경로는 정확히 위 값이며 query나 다른 표기를 허용하지 않습니다. JSON 공백·인코딩이 달라지면 본문 해시도 달라집니다.

```python
import hashlib, hmac, json, secrets, time

body = json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
timestamp = str(int(time.time()))
nonce = secrets.token_urlsafe(18)
canonical = "\n".join(("RV1", device_id, timestamp, nonce, "POST",
                       "/api/device/uploads", hashlib.sha256(body).hexdigest()))
headers = {
    "Content-Type": "application/json",
    "X-RV-Device": device_id,
    "X-RV-Timestamp": timestamp,
    "X-RV-Nonce": nonce,
    "X-RV-Signature": hmac.new(device_secret.encode("ascii"),
        canonical.encode("utf-8"), hashlib.sha256).hexdigest(),
}
# body 바이트를 그대로 HTTPS POST로 전송합니다.
```

## 배치와 세션 생성

서명된 `POST /api/device/uploads`의 본문은 최대 65,536바이트입니다.

```json
{
  "batch_id":"unique_batch_0123456789",
  "segments":[{
    "route":"00000395--0d0eda17c5",
    "segment":7,
    "files":[
      {"kind":"rlog.zst","size":123456,"sha256":"<소문자 16진수 64자리>"},
      {"kind":"qcamera.ts","size":234567,"sha256":"<소문자 16진수 64자리>"}
    ]
  }]
}
```

- `batch_id`: 장치 내 배치별 고유 16~64자 `[A-Za-z0-9_-]`. manifest와 함께 보관합니다.
- 1~50개 구간. 각 구간에는 `rlog.zst`가 필수이며 `qcamera.ts`, `fcamera.hevc`, `ecamera.hevc`는 선택입니다. 없는 파일은 manifest에서 제외합니다.
- 같은 route/segment나 파일 종류를 중복으로 넣을 수 없습니다. 영상만 업로드할 수 없으며, 기존 로그에 영상을 추가할 때도 동일 rlog를 포함합니다.
- `route`: 8자리 hex + `--` + 10자리 hex 또는 기존 `YYYY-MM-DD--HH-MM-SS` 형식입니다. 후자는 식별자 형태만 확인하며 실제 주행 시각을 검증하지 않습니다. 임의 경로나 이름은 거부합니다.
- `segment`: 정수 0~999999. 문자열이나 bool은 거부합니다.
- `size`: 실제 전체 파일 크기인 양의 정수. `sha256`: 필수 전체 파일 해시. 배치·구간·파일의 추가 필드는 거부합니다.

| 제한 | 값 |
|---|---|
| 장치 배치 | 50구간 / 200파일 / 전체 8 GiB |
| 장치 영상 파일 | 파일당 2 GiB |
| rlog 파일 | `max_upload_mb` 이내, 기본 512 MiB |
| 브라우저 업로드 | 배치 합계가 `max_upload_mb` 이내 |

8 GiB를 넘는 배치는 클라이언트에서 나눕니다. 이 제한은 실제 디스크 여유·저장 한도·고정 보호·세션 만료를 우회하지 않습니다.

HEVC는 Annex B parameter-set 헤더가 있어야 합니다. 변환 worker가 코덱·크기·프레임 수·카메라별 encode timestamp를 확인하고 제한된 thread로 H.264 MP4를 만듭니다. 주행 장치에서 트랜스코딩하지 않습니다.

서버가 정규화한 파일명과 UUID 디렉터리를 생성하므로 클라이언트는 저장 경로를 선택할 수 없습니다.

201 응답:

```json
{
  "id":"<업로드 ID 32자리 hex>",
  "token":"<임의 세션 토큰>",
  "expires_at":1780000000.5,
  "idle_timeout_seconds":900,
  "chunk_size":262144,
  "files":[{"index":0,"name":"00000395--0d0eda17c5--7--rlog.zst","size":123456,"received":0}]
}
```

세션은 배치 전체를 담당합니다. 전역 최대 32개 활성 장치 세션과 256개 미만료 완료 영수증을 허용합니다. 절대 유효기간은 처음 생성부터 **7200초**로 늘어나지 않습니다. 성공한 조각 전송은 **900초** 유휴 만료를 갱신하지만 상태 조회나 서명된 재연결·토큰 재발급은 갱신하지 않습니다.

응답 유실·서버 재시작 후 동일 batch_id와 동등한 manifest를 **새 nonce로 서명**해 다시 생성하면 200과 현재 수신 위치를 반환합니다. 새 토큰은 이전 토큰을 즉시 대체하므로 조각 전송 중 동시에 재연결하지 않습니다. manifest가 달라지면 409 `batch_conflict`입니다. 서버에는 토큰의 SHA256만 저장하며 토큰은 Authorization 헤더로만 보냅니다.

완료 영수증이 남아 있으면 200 `{"state":"completed","result":{...}}`를 반환합니다. 영수증은 원래 세션의 절대 만료 시각까지 보관합니다. 이후 같은 배치를 다시 전송할 수 있지만 등록 시 파일 해시 중복 검사를 적용합니다.

## 조각 전송과 이어올리기

다음 요청은 HTTPS와 `Authorization: Bearer <token>`을 사용합니다. 장기 HMAC이나 UI의 `X-RoadViewer-Request` 헤더는 필요하지 않습니다.

| 요청 | 의미 |
|---|---|
| `GET /api/device/uploads/<id>` | `{id,state:"uploading",expires_at,files:[{index,name,size,received}]}` |
| `PUT /api/device/uploads/<id>/files/<index>?offset=<바이트 위치>` | 1~262144바이트 조각, `application/octet-stream`; 200 `{"received":<누적 위치>}` |
| `POST /api/device/uploads/<id>/finish` | 전체 수신·검증 후 등록 |
| `DELETE /api/device/uploads/<id>` | 유휴 미완료 세션 취소 |

파일 index는 manifest의 구간·파일 순서입니다. 파일별 순서대로 보내고 겹치는 동시 쓰기를 하지 않습니다. 선언 크기를 넘는 조각은 거부합니다. offset은 조각 번호가 아니라 바이트 수입니다.

응답을 잃으면 GET으로 서버 위치를 확인합니다. 이미 받은 같은 바이트 범위는 재전송할 수 있지만, 빈 구간이나 기존 위치의 다른 내용은 409 `offset_conflict`입니다. 기존 바이트를 덮어쓸 수 없으므로 파일이 바뀌면 취소 후 새 세션을 사용합니다.

기한 내 네트워크 장애와 앱 재시작에는 부분 파일·manifest·예약을 보존합니다. 브라우저 업로드의 시작 시 정리 동작과는 다릅니다. TLS가 전송을 보호하고, 마지막 전체 SHA256이 서명한 manifest와 수신 내용을 대조합니다.

## 완료와 취소

finish는 빈 본문으로 요청합니다. 모든 파일이 선언 크기에 도달하고 검증·해시가 일치해야 기존 업로드 엔진으로 등록합니다. 201 응답:

```json
{"logs":[{"id":"...","name":"..."}],"updated":[{"id":"...","name":"..."}],"duplicates":[{"id":"...","name":"...","video_differs":false}]}
```

위 메타데이터는 예시이며 실제 객체에는 uploaded/status/files 등이 추가됩니다. 완료는 원본 등록을 뜻하며 변환 완료를 뜻하지 않습니다. 새 로그·기존 로그 영상 추가·중복은 각 배열로 구분합니다.

`updated` 항목의 `original_restored: true`는 저장된 원본 해시가 일치해 MP4 옆에 누락된 원본만 복원했다는 뜻입니다. 기존 MP4·분석·변환 상태를 유지하고 재변환하지 않습니다. 다른 영상이거나 해시가 없으면 불일치로 처리합니다.

완료 영수증을 저장하므로 finish를 다시 요청하면 200으로 동일 결과를 반환합니다. 완료 후 GET도 `{state:"completed",result:{...}}`입니다. 해시·등록에 시간이 걸릴 수 있으므로 180초를 허용하고 불확실한 응답에는 상태 조회·재연결을 사용합니다. 파일 반영과 영수증 저장 사이 프로세스가 종료되면 영수증이 없을 수 있습니다. 새 인증으로 재전송해도 기존 해시 비교가 중복 등록을 방지합니다.

DELETE는 유휴 미완료 세션의 임시 파일·예약을 지우고 200 `{"deleted":"<id>"}`를 반환합니다. 쓰기·finish 중이면 409 `upload_busy`이므로 기다린 뒤 재시도합니다. 완료 세션은 불변이며 DELETE해도 등록 로그를 지우지 않고 완료 상태를 반환합니다. 등록 로그 삭제는 Ingress 관리 API에서만 가능합니다.

- 수신 미완료 finish(409): 세션 유지, 나머지 전송.
- 해시 불일치(422): 세션 종료, 새 세션으로 재전송.
- 디스크 부족 조각: 안전하게 정리할 수 있는 세션을 종료.
- 최종 등록 실패: 임시 파일·예약 해제.
- 일시적 통신 실패: 재개 또는 만료까지 보존.
- 60초마다 만료 세션·조각·예약을 함께 정리하며 실행 중 요청이 끝나기 전에는 지우지 않습니다.

UI의 저장소 즉시 정리는 유효한 장치 세션을 보존합니다. 브라우저 미완료 업로드는 강제 정리할 수 있습니다.

## 재생과 와이드 보정

재생 메타데이터의 `videos`는 `front`, `qcamera`, `wide`별 로그 시간축 start/duration을 제공합니다. 기존 `video` 필드는 우선 사용 가능한 영상(front → qcamera → wide)을 가리킵니다.

Ingress의 `GET /api/logs/<id>/video?source=<key>`는 기존 접근 권한과 HTTP Range를 유지합니다. 영상 선택을 바꿔도 로그 시각을 보존하며 실패 시 대체 영상을 시도합니다.

와이드 겹쳐보기는 센서와 `liveCalibration.wideFromDeviceEuler`로 공유 3D 좌표를 투영합니다. 전방 투영을 대신 사용하지 않습니다. 보정 누락·미지원 센서는 안내를 표시하며 이전 변환 로그는 재분석해야 합니다. 카메라 겹쳐보기에는 우측 주행 상황의 전방 범위 제한을 적용하지 않습니다.

## 연결 해제와 관리 API

이 절의 엔드포인트는 모두 Ingress 전용입니다.

- `GET /api/settings/device-network`: configured_port, active_port, restart_required, boot_id, restarting, restart_error.
- 같은 경로의 POST: 정확히 `{"enabled":true,"port":18443}` 또는 `{"enabled":false,"port":null}`. 다른 포트·옵션은 유지합니다.
- `POST /api/settings/device-network/restart`: 202, 앱 재시작을 예약합니다. UI는 새 boot_id를 최대 3분 확인합니다. TLS/입력 오류 400, 재시작 중 변경 409, Supervisor 오류 502.
- `GET /api/settings/devices`: 이름, dongle_id, 등록·최근 HMAC 인증 시각, revoked, device_id와 enabled/host_port/configuration_error. 장기 키나 Supervisor 토큰은 반환하지 않습니다.
- `POST /api/settings/devices/<device_id>/revoke`: 장치를 영구 연결 해제합니다. 새로운 HMAC과 기존 세션 토큰의 이후 요청도 거부합니다. 유휴 세션은 제거하고 진행 중 요청은 끝날 수 있습니다. 남은 임시 세션은 만료 정리합니다.
- `DELETE /api/settings/devices/<device_id>`: 해제된 등록만 목록에서 지우고 100개 등록 한도에서 제외합니다. 활성 장치는 409 device_not_revoked, 없는 장치는 404 device_not_found.

장치 연결 해제·목록 제거는 업로드한 로그를 삭제하지 않습니다. 복구하려면 새로 페어링해야 합니다. 마지막 인증 시각은 마지막 조각 전송 시각과 다릅니다.

## 저장 한도·예약·구간 고정

`.storage-settings.json`에는 max_bytes, policy와 구간 UUID별 pinned_logs를 저장합니다. DB는 사용하지 않습니다. 화면은 전체 파일 사용량·디스크 여유·남은 예약량을 표시하고 GB는 1024³ 바이트입니다. 기본값은 무제한 / reject_new입니다.

조각 업로드는 **전체 선언 바이트 + 64 KiB**, 기존 multipart는 추가 복사본을 고려해 **2배 + 64 KiB**를 예약합니다. 이미 받은 바이트는 실제 사용량에 포함되므로 예약 잔여분만 더합니다. 물리적 디스크에는 기존 예약과 새 업로드 및 **100 MiB 여유**가 있어야 하며, 앞으로 삭제할 공간을 물리적 여유로 간주하지 않습니다.

**예약 생성은 기존 로그를 삭제하지 않습니다.** delete_oldest는 논리적 한도 계산에서 회수 가능한 용량을 고려하지만, 실제 삭제는 전체 파일 수신·검증·해시 확인 후 등록 직전에만 수행합니다. 다른 미수신 예약 때문에 추가 삭제하지 않으며 중복만 있는 등록도 삭제를 일으키지 않습니다. 반복 예약·토큰 갱신으로 기존 로그를 지울 수 없고, 세션 수 및 유휴·절대 만료로 예약을 제한합니다.

공유 등록/저장 잠금으로 동시 예약 계산을 보호합니다. 완료·취소·최종 실패·만료와 함께 예약을 해제합니다. 정상 장치 세션은 재시작 후 유지합니다.

delete_oldest 후보는 전체 주행 ID로 묶고 가장 이른 **업로드 시각**순으로 고릅니다. 선택한 주행의 고정하지 않은 구간만 삭제합니다. 고정 구간, 업로드에 포함된 주행, 대기·처리 중인 주행, 기존 영상 추가 대상 등 보호 대상은 제외합니다. 복원할 수 없는 옛 주행 ID는 개별 단위이며 화면의 짧은 이름으로 묶지 않습니다.

전체 후보로도 공간이 부족하면 삭제를 시작하지 않습니다. 다만 실제 파일시스템 삭제는 여러 디렉터리를 한 번에 되돌리는 트랜잭션이 아닙니다. 한도 변경만으로 삭제하지 않고 검증된 등록 시점에만 적용합니다. 변환 결과·외부 디스크 사용량이 증가할 수 있으므로 강제 파일시스템 quota가 아닙니다.

고정은 구간별이며 나중에 추가한 구간에 전파되지 않습니다. 옛 pinned_routes는 현재 존재하는 구간으로 한 번 이전합니다. 일괄 삭제는 기본적으로 고정 항목을 제외하고 **고정 항목도 삭제**를 켠 세션에서만 포함합니다.

Ingress의 `DELETE /api/logs/<id>`, `DELETE /api/logs/<id>/prepared`는 `?skip_pinned=1`일 때 잠금 안에서 고정을 확인해 200 `{"skipped":"pinned"}`를 반환할 수 있습니다. 생략하면 개별 메뉴처럼 명시적 삭제를 허용합니다. 장치 API에서는 이 관리 기능에 접근할 수 없습니다.

## 오류와 재시도

앱 오류는 `{"error":"stable_code"}`와 선택적 message입니다. Nginx의 400/404/413/429/502/504는 JSON이 아닐 수 있으므로 상태 코드를 먼저 확인합니다.

| HTTP | 주요 코드와 처리 |
|---|---|
| 400 | invalid_pairing_request, invalid_batch, invalid_segments, invalid_segment, duplicate_segment, invalid_file, duplicate_file, rlog_required, unexpected_query, invalid_offset, invalid_chunk, invalid_request: 요청 수정 |
| 401 | invalid_pairing_code, invalid_authentication, invalid_signature, invalid_device, invalid_upload_token, stale_timestamp: 인증·시각 확인 |
| 404 | not_found, session_not_found: 만료·정리·잘못된 ID 확인 후 재생성 |
| 409 | nonce_replayed: 새 nonce; batch_conflict: 원래 manifest 또는 새 batch_id; offset_conflict: 수신 위치 조회; upload_busy: 대기; incomplete_upload: 나머지 전송; session_completed: 완료 결과 조회; device_limit_reached: 관리자 확인 |
| 410 | session_expired: 새 세션 |
| 413 | batch_too_large, request_too_large: 배치·요청 크기 축소 |
| 422 | checksum_mismatch: 새 세션으로 해시 재계산·재전송 |
| 429 | pairing_rate_limited, authentication_rate_limited, session_limit_reached: 간격을 두고 재시도 |
| 507 | storage_limit_exceeded, insufficient_disk_space, no_deletable_logs: 저장 설정·고정·디스크 여유 확인 |

통신·429·5xx에는 상한 있는 지수 백오프를 사용합니다. 서명 요청을 다시 보낼 때는 항상 새 nonce입니다. 해제된 ID로 무한 재시도하거나 TLS 검증을 끄지 않습니다. 비밀값을 로그에 남기지 않습니다.

## 자동 테스트

저장소 루트의 WSL/Linux, Python 3.12에서:

```bash
python3 -m venv /tmp/roadviewer-test-env
/tmp/roadviewer-test-env/bin/python -m pip install Flask==3.1.3
/tmp/roadviewer-test-env/bin/python tests/test_device_api.py
/tmp/roadviewer-test-env/bin/python tests/test_storage.py
/tmp/roadviewer-test-env/bin/python tests/test_upload_recovery.py
```

임시 디렉터리와 가짜 파일을 사용하며 실제 Home Assistant 장치·로그에는 접근하지 않습니다. Flask 버전은 requirements.txt와 맞춥니다. 이 최소 설치는 실제 미디어 디코더 환경이 아닙니다.

실제 Nginx/Gunicorn TLS 경계를 검증하려면:

```bash
docker build -t roadviewer:0.5.3 ./roadviewer
docker run --rm -v "$PWD/tests:/tests:ro" --entrypoint python roadviewer:0.5.3 /tests/test_device_tls.py
```

컨테이너 안에서 임시 인증서로 통신하므로 포트 공개·공유기 변경은 필요하지 않습니다. 빌드는 네트워크가 필요하며 실제 DNS/NAT 검증을 대신하지 않습니다.

추가 검사: test_device_network.py는 포트·TLS·재시작·관리 격리, tests/storage_devices.cjs는 설정·고정·페어링 UI, tests/device_test_page.cjs는 Web Crypto 서명·이어올리기·비밀값 미저장을 검증합니다. 실제 설치에서는 설정·구간 고정의 재시작 유지와 외부 경로 격리를 확인하세요. delete_oldest 검사는 지워도 되는 테스트 로그로만 실행합니다.

## HTML 브라우저 테스트 페이지

외부 HTTPS를 켜고 재시작한 뒤 `https://<도메인>:<외부포트>/api/device/test`로 접속합니다. 같은 origin에서 제공하므로 CORS나 로컬 서버가 필요하지 않습니다. 외부 API가 꺼지면 사용할 수 없고, 로컬 HTML 직접 열기나 Ingress 접근은 지원하지 않습니다.

1. Ingress에서 **새 장치 연결**로 코드를 발급합니다.
2. 테스트 페이지에 이름과 코드를 입력해 연결합니다.
3. 가상 2개 구간 파일 또는 실제 rlog.zst/qcamera.ts를 선택합니다. 브라우저 메모리 해시 계산 때문에 파일당 **64 MiB** 제한입니다.
4. **세션 생성 / 복구 → 업로드 / 이어올리기**를 실행합니다. 기본 테스트는 첫 조각 뒤 멈추며 다시 누르면 서버 수신 위치부터 재개합니다.
5. 전체 전송 뒤 **완료 처리**, 등록 전 중단하려면 **세션 취소**를 누릅니다.
6. 잘못된 서명은 401, nonce 재전송은 409를 확인합니다. 재전송 검사는 먼저 실제 세션을 만들므로 예약량이 생길 수 있습니다.

실제 API 클라이언트이므로 장치·파일이 등록되고 저장 정책도 적용됩니다. 가상 파일은 변환에 실패합니다. 테스트 데이터는 Ingress에서 삭제하고 테스트 장치는 연결 해제합니다.

키는 추출 불가능한 Web Crypto HMAC 키로 페이지 메모리에만 있고 토큰도 메모리에만 유지합니다. localStorage/sessionStorage·화면·기록에 저장하지 않습니다. 새로고침하면 다시 페어링해야 하며 서버 재시작 후 재개는 페이지를 유지한 채 세션 재연결로 확인합니다.

## 관련 문서

- [사용 설명서 한국어](../roadviewer/DOCS.md) · [English user guide](../roadviewer/DOCS.en.md)
- [영문 API 문서](device-api.en.md)
