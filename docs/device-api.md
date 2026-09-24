# Road Viewer device upload API v1

This is the Road Viewer half of the protocol. No openpilot uploader is included or modified. Existing browser uploads and Home Assistant Ingress remain supported. One Gunicorn worker with multiple threads is required; do not add workers/replicas sharing this data directory.

## Deployment and HTTPS

Base URL: `https://<certificate-domain>:<WAN-port>` (no path prefix), for example `https://example.com:18443`.

1. Place a valid certificate and its private key in Home Assistant's `/ssl` directory (for example using an existing certificate/ACME add-on). Its SAN must cover the domain. Certificates do not bind a port number.
2. Road Viewer add-on options:
   ```yaml
   max_upload_mb: 512
   device_certfile: fullchain.pem
   device_keyfile: privkey.pem
   ```
   The certificate options are filenames directly under `/ssl`, not absolute paths. Road Viewer mounts `/ssl` read-only. It does not request or renew certificates. On startup it reads only `GET http://supervisor/addons/self/info` to obtain `network["8443/tcp"]`; it does not change Supervisor networking. If this lookup fails, external HTTPS stays disabled and Ingress shows a configuration error. There is no separate `device_api_enabled` option.
3. In the add-on Network settings, map **8443/tcp** to an unused host TCP port, for example **18443**. This mapping is disabled by default (`null`) and is the only on/off control: assign a host port to enable the HTTPS API, clear it to disable. Restart after changing options/ports. Missing or invalid certificates with a mapped port cause startup to fail closed; correct the files or clear the port mapping.
4. UniFi: `WAN TCP 18443 → Home Assistant Green LAN IP TCP 18443` (the host mapping above). Alternatively choose host 18099 and forward `18443 → 18099`. Do not forward the Ingress HTTP port 8099 or private upstream 8098.
5. Verify DNS resolves to your WAN, certificate trust and firewall rules from outside your LAN. Certificate verification must remain enabled on the device.

TLS terminates at **Nginx inside the Road Viewer container on 8443**. Nginx forwards only `/api/device/` to **127.0.0.1:8098**. The same single Gunicorn worker also serves Ingress at 8099. The application checks the actual Gunicorn socket, not Host/X-Forwarded headers; the device listener cannot serve UI, assets, management APIs or browser upload endpoints. The Ingress listener rejects device API paths and keeps its existing Supervisor peer and mutation-header checks. The port number is not an authentication mechanism.

Nginx checks certificate file mtimes every minute via the startup supervisor and reloads a valid updated pair; existing TLS configuration stays active during a failed renewal. Access logs are disabled. Certificate files/master credentials must not be committed or shared. No CORS support is provided for the device API. The single static test page described below is served within the device namespace; it exposes no management UI or credentials.

Home Assistant configuration reference: [ports and SSL mounts](https://developers.home-assistant.io/docs/apps/configuration/).

## Pairing

In the Ingress UI, open **로그 업로드 → 외부 장치 연결 → 새 장치 연결**. A 96-bit random, 24-character uppercase hex code is shown with a countdown. It lasts **300 seconds**. Creating another code replaces the previous code. Cancel, expiry, a successful pair, or server restart invalidates it. A successful code is consumed under the same lock as credential creation. The UI shows waiting/paired/expired states. Pairing has a global limit of 10 valid-shape attempts/minute; at most 100 device records are retained.

`POST /api/device/pair`, `Content-Type: application/json`:

```json
{"code":"<24 uppercase hex characters>","metadata":{"name":"My comma","dongle_id":"optional identifier"}}
```

`metadata.name`: nonblank string, max 80 characters. `dongle_id`: optional string, max 80 characters. No other metadata fields. Dongle ID is descriptive, never a credential. Request <= 4096 bytes.

201 response, returned **once**:
```json
{"device_id":"<32 lowercase hex>","device_secret":"<64 lowercase hex>","algorithm":"HMAC-SHA256"}
```

The device must protect these values persistently. Neither is stored in browser localStorage. No UI/API can read back a device secret. If the response is lost, revoke that device and pair again.

Road Viewer stores a random 256-bit root secret in `/data/roadviewer/.devices.json` with mode 0600, alongside device records, replay nonces and short-lived completion receipts. Per-device secrets are derived with HMAC-SHA256 from that root and the unique device ID; individual plaintext secrets are not recorded. HMAC verification cannot use only a one-way hash of the client key. A local persistent root secret is used rather than encryption with another colocated key; filesystem/backup protection remains essential. Compromise of this file compromises all device credentials. The file is retained by Home Assistant backups as authentication configuration; logs/video are excluded as before. Corrupt credential state is not silently reset.

## HMAC request authentication

Only session creation/reattachment uses long-term authentication. The secret is **never sent again**. All other upload operations use the short-lived token below.

`POST /api/device/uploads` requires:

| Header | Value |
|---|---|
| `X-RV-Device` | device_id |
| `X-RV-Timestamp` | decimal Unix UTC seconds, 10 digits |
| `X-RV-Nonce` | unique random 16–64 characters from `[A-Za-z0-9_-]`, at least 128 random bits recommended |
| `X-RV-Signature` | lowercase hex HMAC-SHA256 |
| `Content-Type` | application/json |

Timestamp must be within ±120 seconds of the server. Synchronize the device clock. Nonce replay is rejected for the entire timestamp acceptance interval, including restarts. Nonces are persisted before success; do not reuse a nonce after a connection failure or a validation/capacity error. Outstanding nonce records are capped at 10,000; expired entries are pruned on authentication.

Canonical string, UTF-8, **LF separators with no final LF**:
```text
RV1
<device_id>
<timestamp header exactly>
<nonce header exactly>
POST
/api/device/uploads
<lowercase SHA256 hex of exact request body bytes>
```

Signature key is the **ASCII bytes of the 64-character secret**, not hex-decoded bytes. Method is uppercase. No query string or alternate path spelling is accepted. JSON whitespace and encoding affect the body hash. Send exactly the bytes used to compute it.

Python standard-library signing example:
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
# HTTPS POST base_url + '/api/device/uploads', body=body, headers=headers.
```

## Batch/session creation

Signed `POST /api/device/uploads` body (<= 65,536 bytes):
```json
{
  "batch_id":"unique_batch_0123456789",
  "segments":[
    {
      "route":"00000395--0d0eda17c5",
      "segment":7,
      "files":[
        {"kind":"rlog.zst","size":123456,"sha256":"<64 lowercase hex>"},
        {"kind":"qcamera.ts","size":234567,"sha256":"<64 lowercase hex>"}
      ]
    }
  ]
}
```

- `batch_id`: 16–64 `[A-Za-z0-9_-]` characters, unique per device per batch. Save it with the manifest on the device.
- 1–50 segments; each segment has one required `rlog.zst` and an optional `qcamera.ts`. No repeated route/segment or file kind. Video-only uploads are rejected; to attach video later send the matching rlog again with it (existing hash deduplication is reused).
- `route`: either 8 hex characters, `--`, 10 hex characters, or legacy `YYYY-MM-DD--HH-MM-SS` digit shape. Legacy timestamps are identifiers only, not validated driving times. No paths, slashes or arbitrary names.
- `segment`: integer 0–999999 (not string/bool).
- `size`: positive integer of actual file bytes. `sha256`: mandatory SHA256 of the complete file. Additional fields at batch/segment/file level are rejected.
- 100 files maximum; **sum of file sizes** must fit the add-on's `max_upload_mb` setting (default 512 MiB, configurable 16–2048 MiB), not 512 MiB per segment. Split larger batches client-side.
- The server generates canonical flat names and UUID storage directories. Clients cannot select disk paths.

201 response:
```json
{
  "id":"<32 hex upload id>",
  "token":"<opaque random token>",
  "expires_at":1780000000.5,
  "idle_timeout_seconds":900,
  "chunk_size":262144,
  "files":[{"index":0,"name":"00000395--0d0eda17c5--7--rlog.zst","size":123456,"received":0}]
}
```

The session covers the **whole batch**. There are at most 32 live device sessions and 256 unexpired completion receipts globally. Absolute TTL is **7200 seconds** from first creation, never extended. Successful chunks refresh the 900-second idle deadline. Status polling does not extend it. A signed reattachment refreshes activity but not absolute expiry.

Repeat a signed creation with a **fresh nonce**, same batch_id and equivalent JSON metadata to recover after a lost response/restart: 200 with the same session and current offsets, but a newly issued token that invalidates the old token. Changed metadata with that batch_id returns 409 `batch_conflict`. Do not do this concurrently with chunk transfers. The server stores only a SHA256 digest of the random session token. Session tokens may only be sent in the Authorization header, never URL/query/body.

If already completed and its receipt is still valid: 200 `{"state":"completed","result":{...finish result...}}`. Receipts expire at the original session's absolute expiry. After expiry there is no permanent batch-id ledger; creating it again may upload again, with existing file-content deduplication on registration.

## Chunks and resume

All following requests require `Authorization: Bearer <token>` and HTTPS. No long-term HMAC or UI `X-RoadViewer-Request` header is needed.

- `GET /api/device/uploads/<id>` → `{id,state:"uploading",expires_at,files:[{index,name,size,received}]}`. Indices are the order of segments/files in the manifest. It reports persisted offsets; it does not reserve more space.
- `PUT /api/device/uploads/<id>/files/<index>?offset=<byte offset>` with raw binary body, `Content-Type: application/octet-stream`. Chunk length is 1–262144 bytes and cannot exceed declared file size. Upload sequentially per file; no overlapping concurrent writes. 200 `{"received":<offset after this chunk>}`.
- If a response is lost, GET status then continue at `received`. Repeating an already received identical range is accepted. A gap or changed data at an old offset returns 409 `offset_conflict`; query status. Offsets are byte counts, not chunk numbers. A conflicting chunk cannot overwrite old bytes; cancel/restart for a changed file.
- Partial data is retained across a network failure and an ordinary add-on restart within both deadlines. Startup removes browser/staging leftovers but preserves valid device manifests/chunks/reservations. Device credentials and replay checks survive restarts.

TLS protects chunks in flight; final SHA256 verifies the entire received file against HMAC-authenticated metadata.

## Completion and cancellation

`POST /api/device/uploads/<id>/finish` (empty body): all files must reach declared sizes, then their checksums must match. Registration reuses the browser upload engine, grouping, duplicate detection, optional video attachment and conversion queue. 201:
```json
{"logs":["new recording metadata objects"],"updated":["metadata of logs receiving video"],"duplicates":[{"id":"...","name":"...","video_differs":false}]}
```
The strings above stand for objects; actual new/updated metadata contain `id`, `name`, `uploaded`, `status`, `files`, etc. Use the arrays to distinguish new, updated and duplicate entries. Upload completion means originals are registered, not that conversion is complete.

A completed finish is recorded persistently and may be retried: 200 with the same result. GET on a completed session returns `{state:"completed",result:{...}}`. Checksumming/registration can take time; allow 180 seconds and use status/reattachment after an uncertain response. A process crash between committing files and persisting the receipt may leave no receipt/session; recreate and upload the batch with fresh authentication. Existing rlog/video digest checks avoid duplicate recording data.

`DELETE /api/device/uploads/<id>` cancels an idle live session, deletes all its temporary chunks and releases reservation → 200 `{"deleted":"<id>"}`. An in-flight write/finish returns 409 `upload_busy`; retry after it ends. A completed session is immutable: DELETE returns the completed state and does not delete registered logs. Registered-log deletion is only available inside Ingress.

Incomplete finish (409) keeps the session for remaining bytes. Checksum failure (422) terminates it; retransmit under a new session. A disk-full chunk terminates an inactive session. Other terminal registration failures release staging/reservation; a transient transport failure retains them until resumed or expired. The cleanup timer runs every 60 seconds. Expired sessions, chunks and reservations are deleted together. Active requests are not deleted by timer cleanup; they drain before deletion. The UI's explicit cleanup also preserves live device sessions (its existing force-cancel behavior for browser uploads remains).

## Revoke and authentication state

Ingress-only `GET /api/settings/devices` provides name, optional dongle_id, registered_at, last_seen (last HMAC authentication), revoked flag and device_id, never credentials. The response also includes `enabled`, `host_port` (null when disabled), and `configuration_error` for startup port discovery failures. `POST /api/settings/devices/<device_id>/revoke` permanently revokes that ID. New HMAC requests **and subsequent token requests** are rejected. Idle sessions are removed immediately; an in-flight operation may complete, and its leftover temporary session is removed by expiry cleanup. Existing recordings are not deleted. Re-pair for a new ID; a revoked device cannot reactivate itself. Ingress-only `DELETE /api/settings/devices/<device_id>` removes a revoked device record from the list and frees its registration slot (100 total). Active devices return 409 `device_not_revoked`; unknown IDs return 404 `device_not_found`. Removal persists across restarts and does not delete recordings or restore authentication. The UI shows 목록 제거 after revocation.

## Storage limits, reservations and Pin

The UI offers unlimited (default), 10/20/50/100 GB and custom; UI GB uses 1024³ bytes. `/data/roadviewer/.storage-settings.json` stores integer `max_bytes`, `policy` and segment UUID pins (`pinned_logs`). No database was added. Settings and pins persist and are backed up. UI exposes used bytes (all regular files below Road Viewer root), disk free bytes and remaining reserved bytes.

Before accepting a browser or device batch, admission reserves **2 × total declared bytes + 64 KiB** for chunks plus the staging copy/metadata. Already received bytes are counted in used space, so only the remaining reservation is added. A **100 MiB disk safety margin** is required. A shared lock covers space check, optional deletion and reservation creation; two concurrent batches cannot reserve the same free bytes. Reservation files live in the upload folder and are released with completion/cancellation/terminal failure/expiry. Surviving device sessions retain reservation across restart; expired/browser reservations are cleared.

`reject_new` rejects admission and preserves existing logs. `delete_oldest` groups the UUID segment folders by full original route ID, orders groups by earliest **upload time**, preflights enough deletable capacity, and deletes the unpinned segments of the oldest eligible group through the shared existing deletion helper, leaving pinned segments in place. Interrupted filesystem deletion is not a multi-directory transaction. Legacy logs without a recoverable route ID are individual units. Admission protects incoming/active-upload routes, any group with queued/processing segments and individually pinned segments. Shortened display names are never grouping keys. Pinning affects only the selected segment. Legacy `pinned_routes` migrate once to all currently stored segments in those routes; later uploads do not inherit pins. Explicit manual deletion remains allowed.

Insufficient total reclaimable space returns an error without beginning automatic deletion. Reducing a limit or selecting delete_oldest does not immediately delete data; deletion is admission-driven. The limit is an **upload admission budget, not a kernel filesystem quota**: later decoded JSON/MP4 size, other applications using the filesystem and unexpected metadata growth can exceed an estimate. Subsequent uploads account for actual usage and are rejected or trigger the configured cleanup. Conversion output is not pre-sized by this protocol. Do not set a budget equal to all filesystem capacity.

## Error handling

Application errors are JSON: `{"error":"stable_code"}` with optional human `message`. Nginx may return a non-JSON 400/404/413/429/502/504 before the app; handle HTTP status even without JSON. No secrets should be written to client/server logs.

| HTTP | Codes / client action |
|---|---|
| 400 | `invalid_pairing_request`, `invalid_batch`, `invalid_segments`, `invalid_segment`, `duplicate_segment`, `invalid_file`, `duplicate_file`, `rlog_required`, `unexpected_query`, `invalid_offset`, `invalid_chunk`, `invalid_request`: fix request |
| 401 | `invalid_pairing_code`, `invalid_authentication`, `invalid_signature`, `invalid_device`, `invalid_upload_token`, `stale_timestamp`: correct auth/time; do not loop on a revoked ID |
| 404 | `not_found`, `session_not_found`: expired/cleaned/unknown resource; reauthenticate and recreate if appropriate |
| 409 | `nonce_replayed`: retry only with a fresh nonce; `batch_conflict`: use original metadata or new batch_id; `offset_conflict`: GET offsets; `upload_busy`: wait; `incomplete_upload`: send remaining chunks; `session_completed`: read completion; `device_limit_reached`: administrator action |
| 410 | `session_expired`: recreate session |
| 413 | `batch_too_large`, `request_too_large`: split batch or use smaller requests |
| 422 | `checksum_mismatch`: session discarded; recompute/retransmit |
| 429 | `pairing_rate_limited`, `authentication_rate_limited`, `session_limit_reached`: back off |
| 507 | `storage_limit_exceeded`, `insufficient_disk_space`, `no_deletable_logs`: no admission; operator must change budget/policy/pins or free space |

Use bounded exponential backoff for transport/429/5xx errors. A retry of a signed request always needs a new nonce. Never disable TLS verification to work around authentication or certificate errors.

## Tests

- `python tests/test_device_api.py`: pairing, HMAC/replay/revoke, batch validation, rlog/video, multi-segment resume, checksum failure, restart cleanup, reservation race, grouped eviction and pins.
- `python tests/test_device_tls.py`: real Nginx/Gunicorn HTTPS with a temporary trusted test certificate, socket isolation including forged headers, pairing and signed admission. Requires nginx/openssl/gunicorn; the image CI runs it.
- `node tests/storage_devices.cjs`: mobile settings, Pin, pairing and revoke UI with no credential browser persistence.
- Existing upload recovery, duplicates, storage, conversion and browser tests remain applicable.

## openpilot 없이 테스트하기 (PC / WSL)

다음 명령은 저장소 루트에서 WSL/Linux 환경으로 실행합니다. 장치 API 테스트는 임시 디렉터리와 가짜 로그 바이트를 사용합니다. Home Assistant의 실제 저장소나 등록 장치에는 접근하지 않고, openpilot·실제 주행 로그·인증서도 필요하지 않습니다. Python 3.11 이상을 사용하세요.

```bash
python3 -m venv /tmp/roadviewer-test-env
/tmp/roadviewer-test-env/bin/python -m pip install Flask==3.1.2
/tmp/roadviewer-test-env/bin/python tests/test_device_api.py
```

16개 테스트 후 `OK`가 나오면 페어링·만료·취소·HMAC·재전송 차단·단일/다중 구간·이어올리기·폐기·용량 예약 경쟁·Pin 및 주행 묶음 삭제 검증을 통과한 것입니다. 이 검사는 가짜 데이터를 사용하므로 실제 로그 해석과 영상 변환 품질까지 검사하지는 않습니다.

실제 HTTPS/Nginx/Gunicorn 경계까지 확인하려면 Docker가 동작하는 WSL/Linux에서:

```bash
docker build -t roadviewer:0.3.4 ./roadviewer
docker run --rm -v "$PWD/tests:/tests:ro" --entrypoint python roadviewer:0.3.4 /tests/test_device_tls.py
```

임시 테스트 인증서를 신뢰하도록 설정한 테스트 클라이언트로 HTTPS 페어링·서명된 세션 생성과 UI 접근 차단을 검사합니다. 서버와 클라이언트가 컨테이너 내부에서 통신하므로 호스트 포트 공개나 공유기 설정은 필요하지 않습니다. 이미지 빌드에는 인터넷 연결이 필요합니다. 이 검사는 실제 Home Assistant/UniFi의 DNS·NAT 설정을 확인하지 않습니다.

실제 Home Assistant에 설치한 후에는 기존 로그로 다음 UI 항목을 확인할 수 있습니다.

1. 저장공간 관리의 사용량·여유·예약량 표시와 설정 저장 후 재시작 유지.
2. 같은 주행의 구간 하나에 Pin → 해당 구간만 고정 표시 → 재시작 후 유지 → 다른 구간은 자동 삭제 가능 → Unpin.
3. 외부 장치 연결에서 코드 발급 → 5분 만료 또는 취소. 코드 사용 성공과 Revoke 검증은 위 자동 테스트에서 가상 장치가 수행합니다.
4. 작은 저장 한도 + `reject_new`로 새 업로드 거부 확인. `delete_oldest` 검증은 삭제해도 되는 테스트 로그만 있는 환경에서 수행합니다. 삭제는 실제 완전 삭제입니다.
5. HTTPS 포트 설정 후 외부 네트워크에서 `https://도메인:포트/`와 `/api/logs`가 404인지 확인합니다. 루트 404는 정상입니다. 이것만으로 장치 인증이나 전체 업로드 성공까지 확인된 것은 아닙니다.

## HTML 브라우저 테스트 페이지

PC 브라우저에서 **`https://<도메인>:<외부포트>/api/device/test`**를 엽니다. 예: `https://example.com:18443/api/device/test`. 정적 테스트 HTML 하나를 장치 API와 같은 HTTPS origin에서 제공하므로 CORS 설정이나 로컬 웹 서버가 필요하지 않습니다. 파일을 직접 열거나 Ingress의 assets 경로로 여는 방식은 지원하지 않습니다. 외부 API가 꺼져 있으면 페이지도 404입니다.

1. Home Assistant UI의 외부 장치 연결에서 **새 장치 연결**을 눌러 코드를 발급합니다.
2. 테스트 페이지에서 장치 이름과 코드를 입력해 **장치 연결**을 누릅니다.
3. **가상 파일 준비 · 2개 구간**을 누르거나 기존 이름의 실제 rlog.zst/qcamera.ts 파일들을 선택합니다. 이 페이지는 브라우저 SHA256 계산에 메모리를 사용하므로 파일당 64 MiB까지 허용합니다. API의 기존 배치 용량 제한도 적용됩니다.
4. **세션 생성 / 복구 → 업로드 / 이어올리기**를 누릅니다. 기본적으로 첫 조각 뒤 한 번 멈춥니다. 서버 상태를 확인하고 다시 업로드를 누르면 저장된 위치부터 재개합니다.
5. 모든 파일을 전송했으면 **완료 처리**를 누르고 Home Assistant 목록에서 확인합니다. 등록 전 **세션 취소**는 임시 파일·예약량을 해제합니다.
6. **잘못된 서명 검사**는 401, **동일 요청 재전송 검사**는 409 차단을 확인합니다. 재전송 검사는 먼저 정상 세션을 생성/복구하므로 예약량이 생길 수 있습니다.

이것은 모의 화면이 아니라 실제 API 클라이언트입니다. 장치가 등록되고 실제 파일이 저장되며, 저장 한도와 자동 삭제 정책도 그대로 적용됩니다. 가상 파일은 전송 검증만을 위한 데이터여서 변환은 실패합니다. 테스트 로그는 Ingress에서 완전 삭제하고 테스트 장치는 Revoke할 수 있습니다.

장기 키는 추출 불가능한 Web Crypto HMAC 키로 페이지 메모리에만 두며 localStorage/sessionStorage·화면·테스트 기록에는 저장하지 않습니다. 토큰도 메모리에만 유지합니다. 새로고침하면 다시 페어링해야 합니다. 서버 재시작 후 이어올리기는 페이지를 열어 둔 채 **세션 생성 / 복구**로 확인하세요. 페이지는 현재 origin에만 요청하고 외부 도메인으로 리다이렉트하지 않습니다.

`node tests/device_test_page.cjs`는 브라우저의 실제 Web Crypto 서명을 Node의 HMAC과 대조하고 가상/실제 파일 선택, 체크섬, 일시정지·재개·완료·취소·nonce 차단·비밀값 미저장을 검증합니다.
