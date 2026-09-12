# 0.2.2

- 대용량 업로드를 1MiB 조각으로 전송하여 Ingress 요청 크기 제한에 대응
- JSON이 아닌 프록시 오류 응답도 설명 메시지로 표시

# 0.2.1

- Home Assistant 이미지 버전·종류·아키텍처 라벨 추가
- CI에서 HA 이미지 메타데이터 검증 추가

# 0.2.0

- 차선 4개 확률과 좌우 로드엣지 Std 표시
- radarState의 leadsCenter/leadsLeft/leadsRight 전체 표시 (modelProb 필터 없음)
- liveTracks 감지점, ID, 거리·속도·센서·상태 표 추가
- 업데이트 시 기존 로그 자동 재변환

# 0.1.0
- 로그/영상 일괄 업로드, 영구 목록, 동기 재생과 삭제.
- 평면 파일명 및 구간 폴더 지원.
- Home Assistant Ingress 경로와 접근 제한 지원.
