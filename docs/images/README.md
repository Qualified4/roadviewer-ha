# 스크린샷 안내

한국어 · [English](README.en.md)

## 촬영 기준과 개인정보

2026-11-07에 **1.0.0** 버전(브랜치 `feature/ui-redesign`)의 실제 HTML·CSS·JavaScript로 21장을 모두 다시 촬영했습니다. API 응답은 격리된 브라우저에서 예시 데이터로 대체했으며 운영 HA·Google Drive의 설정·파일을 변경하지 않았습니다. 데스크톱 1440px, 모바일 390px 화면을 사용했고, 일관성을 위해 모두 라이트 모드로 촬영했습니다.

장치 ID `DEMO-DEVICE`, 주행 식별자의 해시 `0000000000`, 페어링 코드 `DEMO0123DEMO4567DEMO8901`, 저장공간·시각·태그·북마크·차량 정보 값은 예시입니다. 실제 인증 키·장치 토큰·개인 주행 로그가 아니며 코드로 페어링할 수 없습니다. 로그 목록의 썸네일은 생성한 예시 그림입니다. 그림은 UI 배치 예시이며 실제 계정 연결·영상 재생의 검증 결과를 대신하지 않습니다.

소개 사진 3장(주행 영상·차량 정보, 주행 상황, 와이드)은 기존 사진의 영상 영역만 잘라 정지 영상으로 만든 뒤 새 재생 화면에 합성했습니다. 영상 속 차선·차량 표시는 기존 사진에 이미 그려져 있던 것이므로 겹쳐 보기는 끈 상태로 촬영했습니다. 속도·그래프·주행 상황 값은 예시 데이터이며 영상 장면과 일치하지 않습니다. 상세 화면은 한국어 UI이며 영어 문서도 동일 이미지를 사용합니다.

## 이미지 목록

| 이미지 | 설명 | 기준 |
|---|---|---|
| [roadviewer-overview.png](roadviewer-overview.png) | 재생 화면: 주행 영상과 차량 정보 그래프 | 1.0.0 · 기존 사진의 영상 영역을 새 UI에 합성 |
| [roadviewer-driving-view.png](roadviewer-driving-view.png) | 재생 화면: 주행 영상과 주행 상황 지도 | 1.0.0 · 기존 사진의 영상 영역을 새 UI에 합성 |
| [roadviewer-wide-camera.png](roadviewer-wide-camera.png) | 와이드 카메라를 선택한 재생 화면 | 1.0.0 · 기존 사진의 영상 영역을 새 UI에 합성 |
| [roadviewer-library-upload.png](roadviewer-library-upload.png) | 업로드 탭: 파일 3개를 선택한 상태와 파일 준비 안내 (장치 연결은 장치 탭) | 1.0.0 · 예시 데이터 |
| [roadviewer-device-pairing.png](roadviewer-device-pairing.png) | 장치 탭의 새 장치 연결 팝업 (예시 페어링 코드) | 1.0.0 · 예시 데이터 |
| [roadviewer-library-settings.png](roadviewer-library-settings.png) | 설정 탭: 변환 기본 설정과 화면 모드 | 1.0.0 · 예시 데이터 |
| [roadviewer-archive-confirm.png](roadviewer-archive-confirm.png) | 저장공간 탭: 수동 전체 이동 실행 전 확인 | 1.0.0 · 예시 데이터 |
| [roadviewer-storage-overview.png](roadviewer-storage-overview.png) | 저장공간 탭: 로컬·확장 저장소(Google Drive) 상태 | 1.0.0 · 예시 데이터 |
| [roadviewer-storage-mobile.png](roadviewer-storage-mobile.png) | 모바일 저장공간 탭 전체 | 1.0.0 · 예시 데이터 |
| [roadviewer-storage-advanced.png](roadviewer-storage-advanced.png) | 저장공간 탭: 펼친 고급 설정 | 1.0.0 · 예시 데이터 |
| [roadviewer-library-logs.png](roadviewer-library-logs.png) | 로그 탭: 빠른 필터, 펼친 주행과 구간별 썸네일·자동 제어 요약 | 1.0.0 · 예시 데이터 |
| [roadviewer-bulk-selection.png](roadviewer-bulk-selection.png) | 목록 안 선택 모드와 하단 작업 바 | 1.0.0 · 예시 데이터 |
| [roadviewer-download-options.png](roadviewer-download-options.png) | 파일·형식 선택 다운로드 | 1.0.0 · 예시 데이터 |
| [roadviewer-tags-library.png](roadviewer-tags-library.png) | 태그 필터 칩과 주행·구간에 표시된 태그, 저장 위치 | 1.0.0 · 예시 데이터 |
| [roadviewer-tags-editor.png](roadviewer-tags-editor.png) | 구간 태그 편집 팝업 | 1.0.0 · 예시 데이터 |
| [roadviewer-bookmarks-editor.png](roadviewer-bookmarks-editor.png) | 재생 화면 북마크 탭: 장면 추가와 저장된 장면 | 1.0.0 · 예시 데이터 |
| [roadviewer-bookmarks-timeline.png](roadviewer-bookmarks-timeline.png) | 북마크 표시가 있는 하단 재생 바 | 1.0.0 · 예시 데이터 |
| [roadviewer-overlay-settings.png](roadviewer-overlay-settings.png) | 겹쳐 보기 설정 팝업 (보이는 상단 영역) | 1.0.0 · 예시 데이터 |
| [roadviewer-camera-info.png](roadviewer-camera-info.png) | 카메라 설치 정보 팝업 | 1.0.0 · 예시 데이터 |
| [roadviewer-boundaries-probability.png](roadviewer-boundaries-probability.png) | 레이어 메뉴의 차선 · 도로 경계: 확률 모드 | 1.0.0 · 예시 데이터 |
| [roadviewer-boundaries-distance.png](roadviewer-boundaries-distance.png) | 레이어 메뉴의 차선 · 도로 경계: y[0] 좌우 거리 모드 | 1.0.0 · 예시 데이터 |

[메인 안내](../../README.md) · [사용 설명서](../../roadviewer/DOCS.md)
