# Road Viewer for Home Assistant

Openpilot 로그를 업로드하고 카메라 영상과 차량 중심 도로 지도를 함께 재생하는 **Home Assistant OS 앱**입니다.

- 로그·영상 업로드, 로그 목록, 재생, 삭제
- 차선 4개의 확률과 좌우 로드엣지 Std
- 모델 앞차, radarState의 중앙·좌우 차량 목록
- liveTracks 감지점과 Track ID, 거리·상대속도·센서·상태 표
- Home Assistant 로그인과 Ingress를 통한 원격 접근

## 설치

1. Home Assistant의 **설정 → 앱 → 앱 스토어 → ⋮ → 저장소**를 엽니다. 이전 버전에서는 앱이 ‘애드온’으로 표시됩니다.
2. 저장소 주소 `https://github.com/Qualified4/roadviewer-ha`를 추가합니다.
3. **Road Viewer**를 설치하고 시작한 후 **웹 UI 열기**를 누릅니다. 사이드바 표시도 켤 수 있습니다.
4. `rlog.zst`와 같은 구간의 `qcamera.ts`를 함께 업로드합니다. 변환이 끝나면 목록의 **재생**을 누릅니다.

여러 구간의 `0000035f--b513269850--1--rlog.zst` / `0000035f--b513269850--1--qcamera.ts` 형식도 지원합니다. 영상이 없어도 도로 지도는 재생됩니다.

**이 저장소는 HACS가 아닌 앱 스토어에 추가합니다.** 별도 서버 프로세스와 영상 처리 라이브러리를 사용하는 앱입니다. 원격에서는 기존 Home Assistant 원격 주소로 로그인해서 앱을 열면 됩니다. 별도 Road Viewer 포트 개방은 필요하지 않습니다.

자세한 용량 제한, 좌표 기준, 업그레이드와 데이터 보관 안내는 [설치 및 사용 설명](roadviewer/DOCS.md)을 참고하세요.

업로드한 로그와 영상은 HA 장비의 앱 데이터에 저장됩니다. 이 GitHub 저장소에는 사용자 로그·영상·계정 정보가 포함되지 않습니다.

## 개발 및 검증

`roadviewer/`를 Docker 빌드 컨텍스트로 사용합니다. GitHub Actions에서 amd64/aarch64 이미지를 빌드하고 API smoke test를 실행합니다. 실제 로그와 브라우저의 Ingress 하위 경로 재생은 별도 로컬 검증을 수행합니다. HA 실장비 설치와 외부 접속은 사용자 환경에서 확인해야 합니다.

포함된 openpilot 스키마의 라이선스는 [OPENPILOT-LICENSE](roadviewer/schema/OPENPILOT-LICENSE)를 참고하세요.
