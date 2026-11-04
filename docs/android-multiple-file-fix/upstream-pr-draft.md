# 상위 저장소 PR 초안 (과거 기록, 미제출)

한국어 · [English / 원본 제출 템플릿](upstream-pr-draft.en.md)

[분석 기록](README.md)에 명시한 버전·커밋 기준입니다. 최신 upstream의 상태를 뜻하지 않으며 아래 항목을 완료한 것으로 간주하지 않습니다. 외부 프로젝트의 원본 영문 템플릿은 영어 문서에 보존했습니다.

## 변경 요약

WebView에서 여러 파일을 선택하고 완료해도 파일 0개로 반환될 수 있습니다. 기존 `ShowWebFileChooser`는 Chromium 151.0.7922.199에서 `Intent.data`만 읽고 ClipData-only 결과를 놓치는 기본 파서에 위임합니다.

이미 포함된 AndroidX `GetMultipleContents` 파서로 바꾸고 빈 결과를 null로 바꿉니다. 선택창 생성과 취소 계약은 유지하며 단일·다중 URI를 모두 처리합니다.

추출한 기존 파서와 수정 Kotlin 클래스를 AndroidX activity 1.13.0 기반 독립 JVM에서 비교했습니다. 기존 파서는 두 ClipData URI에 null, 수정 파서는 두 URI를 반환했고 회귀 검사 7개도 통과했습니다. 전체 Gradle 검사와 실제 기기 검증은 남아 있습니다. 백포트는 2026.6.5용이며 분석 당시 main에서는 `FileChooserEffect.kt`가 대응 위치입니다.

## 제출 전 확인 (미완료)

- [ ] upstream 지침에 맞는 테스트 연결과 실행
- [ ] upstream 코드 스타일·모범 사례 확인
- [ ] 실제 기기를 포함한 충분한 경계 조건 검증
- [ ] 호환성과 사용자 영향 설명
- [ ] Open Home Foundation AI 정책 확인
- [ ] 실제 AI 사용 형태를 정확히 선택·표시
- [ ] 사람이 모든 변경을 검토하고 이해하며 직접 설명할 수 있음
- [ ] 필요한 사용자·개발자 문서 PR 연결 또는 해당 없음 확인

## 화면 및 관련 문서

물리적 Android 선택창의 새 화면 캡처나 연결된 upstream 문서 PR은 없습니다. 외부 제출은 사람이 원본 영문 템플릿과 현재 upstream 지침을 확인한 뒤 별도로 진행해야 합니다. 이 파일의 존재는 PR 제출 또는 승인을 의미하지 않습니다.
