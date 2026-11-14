# 스크린샷 안내

한국어 · [English](README.en.md)

## 촬영 기준과 개인정보

2026-11-11에 **1.2.1** 버전의 실제 HTML·CSS·JavaScript로 27장을 라이트·다크 모드 두 벌(54장)로 다시 촬영했습니다. API 응답은 격리된 브라우저에서 예시 데이터로 대체했으며 운영 HA·Google Drive의 설정·파일을 변경하지 않았습니다. 데스크톱 1440px, 모바일 390px 화면을 사용했고(휴대폰 지도는 2배 해상도), 다크 모드 이미지는 같은 이름에 `-dark`를 붙인 파일이며(예: `roadviewer-overview-dark.png`), README는 보는 환경의 테마에 맞는 쪽을 보여 줍니다.

장치 ID `DEMO-DEVICE`, 주행 식별자의 해시 `0000000000`, 페어링 코드 `DEMO0123DEMO4567DEMO8901`, 저장공간·시각·태그·북마크·차량 정보 값은 예시입니다. 실제 인증 키·장치 토큰·개인 주행 로그가 아니며 코드로 페어링할 수 없습니다. 로그 목록의 썸네일은 생성한 예시 그림입니다. 그림은 UI 배치 예시이며 실제 계정 연결·영상 재생의 검증 결과를 대신하지 않습니다.

지도 화면의 경로는 실제 주행 기록이 아닙니다. 서울 도심의 공개 지명(시청, 광화문, 서울역 등) 사이를 공개 경로 탐색 서비스(OSRM)로 이은 도로 경로를 1초 간격으로 나눈 예시이며, 지도 바탕은 촬영 때 OpenFreeMap에서 받은 실제 지도(© OpenMapTiles, OpenStreetMap 기여자)입니다. 영상 장면과 지도 위치는 서로 관계가 없습니다.

영상이 들어간 5장(주행 영상·차량 정보, 주행 상황, 와이드, 지도 탭, 작은 지도)의 라이트·다크 10장은 2026-11-14에 **1.3.10** 버전 UI로 다시 촬영했습니다(스크립트 `docs/tools/docs_video_shots.cjs`, 장면과 지운 영역 목록 `docs/tools/docs_video_scenes.json`). 이 화면의 영상만은 실제 주행 로그에서 가져왔습니다. **라이트 이미지는 낮 주행, 다크 이미지는 밤 주행**(와이드 카메라는 낮 와이드 영상이 없어 라이트도 밤 와이드 영상)의 실제 영상 프레임 한 장을 정지 영상으로 만든 것이며, 프레임은 리마스터링했습니다. 낮 장면은 앞유리에 비친 대시보드 반사가 거의 보이지 않는 시각을 골랐고, 반사는 같은 구간의 여러 프레임에서 추정하되(도로는 움직이고 반사는 제자리에 있음) 주행 데이터의 차량 위치를 영상에 투영해 차량이 가린 화소는 추정에서 빼며, 그 프레임에 실제로 보이는 곳에서만 빼냈습니다. 밤 장면은 깊은 검정과 대비를 살린 가벼운 밝기·선명도 보정과 약한 다중 프레임 잡음 제거만 했습니다. 번호판은 앞뒤·먼 차량까지 모두, 표지판·간판 글자도 상자 안에서 번호판·간판의 모양을 찾아 그 모양대로 주변 화소로 메우는 인페인팅으로 지워 읽을 수 없고, 불이 켜진 간판은 번짐까지 포함해 주변 어두운 면으로 메웠습니다. 밤 영상을 쓴 이미지에는 예시 주행의 출발 시각을 저녁으로 표시했습니다. 겹쳐 보기는 기본 설정으로 켰고, 같은 시각의 그 로그 재생 데이터와 차량 정보(길이 방향 제어 상태 포함)로 앱이 직접 그렸으므로 영상과 겹쳐 보기, 속도·그래프·주행 상황 값이 서로 맞습니다. 제공한 데이터에서 위치(GPS) 항목은 모두 지웠고, 지도 탭과 작은 지도의 경로·현재 위치는 위의 예시 경로이며 영상 장면과 관계가 없습니다. 장치 ID·주행 식별자·날짜·시각·북마크는 예시 값입니다. 상세 화면은 한국어 UI이며 영어 문서도 동일 이미지를 사용합니다.

## 이미지 목록

| 이미지 | 설명 | 기준 |
|---|---|---|
| [roadviewer-overview.png](roadviewer-overview.png) | 재생 화면: 주행 영상과 차량 정보 그래프 | 1.3.10 · 실제 주행 영상(라이트 낮·다크 밤) · 번호판 지움 · 겹쳐 보기 켬(그 로그 데이터) |
| [roadviewer-driving-view.png](roadviewer-driving-view.png) | 재생 화면: 주행 영상과 주행 상황 지도 | 1.3.10 · 실제 주행 영상(라이트 낮·다크 밤) · 번호판 지움 · 겹쳐 보기 켬(그 로그 데이터) |
| [roadviewer-wide-camera.png](roadviewer-wide-camera.png) | 와이드 카메라를 선택한 재생 화면 | 1.3.10 · 실제 밤 와이드 영상(낮 와이드 영상이 없어 라이트·다크 모두) · 번호판 지움 · 겹쳐 보기 켬(그 로그 데이터) |
| [roadviewer-library-map.png](roadviewer-library-map.png) | 로그 탭 지도 보기: 주행별 파스텔 경로와 유리 카드 주행 목록 | 1.2.1 · 예시 데이터 · 예시 경로와 실제 지도 |
| [roadviewer-drive-map.png](roadviewer-drive-map.png) | 주행 지도: 구간별 경로와 구간 카드, 구간 1 강조 | 1.2.1 · 예시 데이터 · 예시 경로와 실제 지도 |
| [roadviewer-drive-map-mobile.png](roadviewer-drive-map-mobile.png) | 휴대폰 주행 지도: 지도와 구간 카드 시트 | 1.2.1 · 예시 데이터 · 예시 경로와 실제 지도 |
| [roadviewer-replay-map.png](roadviewer-replay-map.png) | 재생 화면 지도 탭: 지나온 길과 현재 위치 | 1.3.10 · 실제 주행 영상(라이트 낮·다크 밤) · 번호판 지움 · 겹쳐 보기 켬(그 로그 데이터) · 예시 경로와 실제 지도(영상과 무관) |
| [roadviewer-video-minimap.png](roadviewer-video-minimap.png) | 영상 위 작은 지도(글자 숨김) | 1.3.10 · 실제 주행 영상(라이트 낮·다크 밤) · 번호판 지움 · 겹쳐 보기 켬(그 로그 데이터) · 예시 경로와 실제 지도(영상과 무관) |
| [roadviewer-library-upload.png](roadviewer-library-upload.png) | 업로드 탭: 파일 3개를 선택한 상태와 파일 준비 안내 (장치 연결은 장치 탭) | 1.2.1 · 예시 데이터 |
| [roadviewer-device-pairing.png](roadviewer-device-pairing.png) | 장치 탭의 새 장치 연결 팝업 (예시 페어링 코드) | 1.2.1 · 예시 데이터 |
| [roadviewer-library-settings.png](roadviewer-library-settings.png) | 설정 탭: 변환 기본 설정과 화면 모드 | 1.2.1 · 예시 데이터 |
| [roadviewer-archive-confirm.png](roadviewer-archive-confirm.png) | 저장공간 탭: 수동 전체 이동 실행 전 확인 | 1.2.1 · 예시 데이터 |
| [roadviewer-storage-overview.png](roadviewer-storage-overview.png) | 저장공간 탭: 로컬·확장 저장소(Google Drive) 상태 | 1.2.1 · 예시 데이터 |
| [roadviewer-storage-mobile.png](roadviewer-storage-mobile.png) | 모바일 저장공간 탭 전체 | 1.2.1 · 예시 데이터 |
| [roadviewer-storage-advanced.png](roadviewer-storage-advanced.png) | 저장공간 탭: 펼친 고급 설정 | 1.2.1 · 예시 데이터 |
| [roadviewer-library-logs.png](roadviewer-library-logs.png) | 로그 탭: 빠른 필터, 펼친 주행과 구간별 썸네일·자동 제어 요약, 주행 경로 그림 | 1.2.1 · 예시 데이터 |
| [roadviewer-bulk-selection.png](roadviewer-bulk-selection.png) | 목록 안 선택 모드와 하단 작업 바 | 1.2.1 · 예시 데이터 |
| [roadviewer-download-options.png](roadviewer-download-options.png) | 파일·형식 선택 다운로드 | 1.2.1 · 예시 데이터 |
| [roadviewer-tags-library.png](roadviewer-tags-library.png) | 태그 필터 칩과 주행·구간에 표시된 태그, 저장 위치 | 1.2.1 · 예시 데이터 |
| [roadviewer-tags-editor.png](roadviewer-tags-editor.png) | 구간 태그 편집 팝업 | 1.2.1 · 예시 데이터 |
| [roadviewer-bookmarks-editor.png](roadviewer-bookmarks-editor.png) | 북마크 기록 팝업: 장면 시각, 제목과 메모 | 1.2.1 · 예시 데이터 |
| [roadviewer-bookmarks-list.png](roadviewer-bookmarks-list.png) | 재생 화면 북마크 탭: 저장된 장면 목록 | 1.2.1 · 예시 데이터 |
| [roadviewer-bookmarks-timeline.png](roadviewer-bookmarks-timeline.png) | 북마크 표시가 있는 하단 재생 바 | 1.2.1 · 예시 데이터 |
| [roadviewer-overlay-settings.png](roadviewer-overlay-settings.png) | 겹쳐 보기 설정 팝업 (보이는 상단 영역) | 1.2.1 · 예시 데이터 |
| [roadviewer-camera-info.png](roadviewer-camera-info.png) | 카메라 설치 정보 팝업 | 1.2.1 · 예시 데이터 |
| [roadviewer-boundaries-probability.png](roadviewer-boundaries-probability.png) | 분석 패널 **차선·도로** 탭: 확률 모드 | 1.2.1 · 예시 데이터 |
| [roadviewer-boundaries-distance.png](roadviewer-boundaries-distance.png) | 분석 패널 **차선·도로** 탭: y[0] 좌우 거리 모드 | 1.2.1 · 예시 데이터 |

[메인 안내](../../README.md) · [사용 설명서](../../roadviewer/DOCS.md)
