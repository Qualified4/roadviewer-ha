# 독립 JVM 검증

한국어 · [English](README.en.md)

과거 고정 버전의 재현용 환경이며 Companion 전체 빌드나 최신 upstream 검증이 아닙니다. JDK 21과 Maven이 필요합니다.

1. Google Maven에서 공식 `androidx.activity:activity:1.13.0` AAR을 받아 `classes.jar`를 이 `pom.xml` 옆 `activity.jar`로 풉니다.
2. 상위 `ShowWebFileChooser.kt`를 `src/main/kotlin`, `ShowWebFileChooserTest.kt`를 `src/test/kotlin`으로 복사합니다.
3. `mvn test`로 회귀 사례 7개를 실행합니다.
4. 기존 파서도 재현하려면 Maven이 가져온 android-all jar를 클래스패스에 넣어 `javac`으로 `LegacyWebViewParser.java`를 `target/classes`에 컴파일합니다. `LegacyWebViewParserTest.kt`를 `src/test/kotlin`에 복사한 뒤 clean 없이 `mvn test`를 다시 실행합니다.

`LegacyWebViewParser.java`는 Chromium 태그 151.0.7922.199의 `AwContentsClient.java`에 있는 `parseFileChooserResult`를 테스트용 독립 클래스로 감싼 것입니다. Android API 반환값은 mock으로 제어하고 수정 Kotlin 클래스와 공식 AndroidX 바이너리는 직접 실행합니다. 전체 검증 결과와 한계는 [분석 기록](../README.md)을 참고하세요.
