# Isolated JVM verification

Requires JDK 21 and Maven. This is not the full Companion build.

1. Download the official `androidx.activity:activity:1.13.0` AAR from Google Maven and extract `classes.jar` as `activity.jar` beside this pom.xml.
2. Copy ../ShowWebFileChooser.kt into src/main/kotlin and ../ShowWebFileChooserTest.kt into src/test/kotlin.
3. Run `mvn test` for the seven regression cases.
4. To reproduce the old parser too, compile LegacyWebViewParser.java into target/classes with javac and the Maven-resolved android-all jar on the classpath. Copy LegacyWebViewParserTest.kt into src/test/kotlin and run `mvn test` again (without clean).

LegacyWebViewParser.java contains the exact parseFileChooserResult method from Chromium tag 151.0.7922.199, AwContentsClient.java, wrapped in a standalone class for testing. Android API return values are mocked; the fixed Kotlin class and official AndroidX binary execute directly.
