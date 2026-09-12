# Home Assistant Android 다중 파일 선택 분석 및 수정안

## 확인 결과

Home Assistant Android **2026.6.5**, WebView **151.0.7922.199** 조합에서 단일 선택은 정상이고 두 파일 이상은 웹 화면에 `cancel`, 파일 0개로 전달되는 현상을 분석했습니다. 다중 선택창에서 한 개만 선택하면 정상이며 같은 스마트폰의 Chrome에서는 여러 개 선택도 정상이라는 비교 결과가 있습니다.

- [2026.6.5 ShowWebFileChooser.kt](https://github.com/home-assistant/android/blob/2026.6.5/app/src/main/kotlin/io/homeassistant/companion/android/webview/ShowWebFileChooser.kt)는 `WebChromeClient.FileChooserParams.parseResult`를 호출합니다.
- [WebView 151.0.7922.199의 AwContentsClient.java](https://github.com/chromium/chromium/blob/151.0.7922.199/android_webview/java/src/org/chromium/android_webview/AwContentsClient.java)의 `parseFileChooserResult`는 `Intent.getData()`만 읽으며 `ClipData`를 읽지 않습니다.
- 다중 선택 결과가 ClipData에만 담기면 RESULT_OK여도 null이 됩니다. 실제 사용자가 취소 버튼을 눌렀다는 의미가 아닙니다.
- [현재 Home Assistant main](https://github.com/home-assistant/android/blob/3e132fab4d5d79de23222b158f9512f696eaf20d/app/src/main/kotlin/io/homeassistant/companion/android/frontend/filechooser/FileChooserEffect.kt)에서도 동일한 위임이 남아 있습니다.
- 파일명 필터, MIME 검사, 업로드 서버에 도달하기 전의 문제입니다.

## 수정

기존 선택창 생성은 유지하고 반환값 해석만 프로젝트에 이미 포함된 `ActivityResultContracts.GetMultipleContents().parseResult()`로 교체합니다. 이 파서는 단일 data와 ClipData 목록을 모두 수집하며 중복 URI를 제거합니다. 빈 목록은 null로 변환해 기존 취소 계약을 유지합니다. 새 라이브러리 의존성을 추가하지 않습니다.

`home-assistant-2026.6.5-multiple-files.patch`는 설치 버전의 소스용이며 Kotlin 단위 테스트 7개를 포함합니다. `home-assistant-main-multiple-files.patch`는 위에 고정된 현재 main의 이동된 클래스에 대한 최소 수정안입니다. main용은 코드가 private Compose 파일 안으로 옮겨져 있어 단위 테스트 파일은 포함하지 않았으며, 제출 전 해당 브랜치에 맞는 테스트 연결이 필요합니다.

## 검증

공식 AndroidX activity **1.13.0** 바이너리, Kotlin **2.4.0**, MockK **1.14.11**, JUnit **6.1.0**, JDK 21과 Android API 클래스를 이용한 독립 JVM 검증:

1. 단일 URI 정상 수신
2. ClipData에만 있는 두 URI 모두 수신
3. data/ClipData 중복 제거와 순서 보존
4. 취소 결과에 잔여 URI가 있어도 null
5. intent 없음 → null
6. 성공 결과에 URI 없음 → null
7. URI 없는 ClipData 항목은 무시
8. 해당 Chromium 버전에서 그대로 추출한 기존 Java 파서는 ClipData-only 결과에 null을 반환하고, 수정된 Kotlin 클래스는 같은 입력에 두 URI를 반환

**8개 통과, 실패·오류·건너뜀 0개.** `test-results.txt` 참고. Android Intent/URI는 MockK로 제어하고 수정된 Kotlin 클래스와 실제 AndroidX 바이너리를 실행했습니다. 물리적 Android 선택창, Companion 전체 Gradle 빌드·lint·detekt는 실행하지 않았습니다. 두 패치 모두 기준 소스에 `git apply --check`를 통과했습니다. 실제 기기 설치 후 최종 확인이 필요합니다.

## 적용 범위

이 패치는 **Home Assistant Companion Android 앱 소스용**입니다. Road Viewer 애드온 버전을 올려도 스마트폰 APK 내부를 변경할 수 없습니다. 설치된 앱에는 아직 적용되지 않았습니다. 공식 수정 버전이 나오기 전에는 Chrome 다중 업로드 또는 앱의 개별 추가를 사용합니다. 패치를 설치하려면 Android 앱 빌드·서명 및 기기 검증이 필요하며, 제공 파일은 APK가 아닙니다. 기존 앱 삭제·서명 변경·비공식 APK 설치는 수행하지 않았습니다.

소스 체크아웃에서 검토 후 적용 예:

```sh
git checkout 2026.6.5
git apply --check /path/to/home-assistant-2026.6.5-multiple-files.patch
git apply /path/to/home-assistant-2026.6.5-multiple-files.patch
./gradlew :app:testFullDebugUnitTest --tests '*ShowWebFileChooserTest'
```

최신 개발 브랜치에는 main용 패치를 사용하고, 해당 시점의 파일 변경 여부를 먼저 확인하세요. 별도 APK 빌드를 하려면 공식 개발 문서를 따르세요.

## 상위 제출 상태

상위 이슈·PR은 제출하지 않았습니다. [Home Assistant AGENTS.md](https://github.com/home-assistant/android/blob/3e132fab4d5d79de23222b158f9512f696eaf20d/AGENTS.md)의 AI 정책은 “a human must review, understand, and be able to explain every change before it is submitted”라고 규정합니다. `upstream-pr-draft.md`는 사람이 검토해 사용할 제출 초안이며 체크리스트의 사람 검토 항목은 미완료 상태입니다.

개인 파일명·차량 로그·Ingress 주소는 이 패치 묶음과 저장소 보고서에 포함하지 않았습니다.
