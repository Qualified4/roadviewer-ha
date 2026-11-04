# Home Assistant Android multiple-file investigation

[한국어](README.md) · English

This is a historical investigation pinned to Android **2026.6.5**, WebView **151.0.7922.199**, and the main commit linked below. It does not claim that current Companion releases still contain the issue.

## Findings

Single-file results worked; selecting two files delivered `cancel` and zero files even after the user chose Done. Selecting only one file in multiple mode worked, as did Chrome on the same phone.

- [ShowWebFileChooser.kt at 2026.6.5](https://github.com/home-assistant/android/blob/2026.6.5/app/src/main/kotlin/io/homeassistant/companion/android/webview/ShowWebFileChooser.kt) delegates to `WebChromeClient.FileChooserParams.parseResult`.
- [Chromium 151.0.7922.199 AwContentsClient.java](https://github.com/chromium/chromium/blob/151.0.7922.199/android_webview/java/src/org/chromium/android_webview/AwContentsClient.java) reads `Intent.data`, ignoring ClipData-only results. RESULT_OK can therefore become null; it does not mean the user pressed Cancel.
- The delegation was also present at [the inspected main commit](https://github.com/home-assistant/android/blob/3e132fab4d5d79de23222b158f9512f696eaf20d/app/src/main/kotlin/io/homeassistant/companion/android/frontend/filechooser/FileChooserEffect.kt).
- The failure precedes MIME filtering and the upload server.

## Proposed fix

Keep chooser construction and replace result parsing with the already available `ActivityResultContracts.GetMultipleContents().parseResult()`. It reads both data and ClipData, removes duplicate URIs, and maps an empty list to null to preserve cancellation semantics. No new dependency is needed.

`home-assistant-2026.6.5-multiple-files.patch` targets the installed-version source and includes seven Kotlin tests. `home-assistant-main-multiple-files.patch` targets the pinned main commit; the private Compose implementation requires test wiring for that branch before submission.

## Recorded verification

An isolated JVM harness used AndroidX activity 1.13.0, Kotlin 2.4.0, MockK 1.14.11, JUnit 6.1.0, JDK 21 and mocked Android API values. It checked a single URI, two ClipData-only URIs, deduplication/order, cancellation with residual URIs, missing intent, successful empty results, and ClipData entries without URIs. An eighth test compared the extracted Chromium parser with the fixed class.

**Eight passed; zero failures, errors, or skips.** See `test-results.txt`. The real AndroidX binary and fixed Kotlin class ran; physical Android picker, full Companion Gradle build/lint/detekt, and device installation were not verified. Both patches passed `git apply --check` on their pinned sources. These historical checks were not rerun for the documentation update.

## Scope and use

These patches modify **Companion Android source**, not Road Viewer. Updating Road Viewer cannot patch an installed APK. If affected, use Chrome or add one file at a time using Road Viewer’s same **파일 추가** button. No separate single-file button exists. The files are not APKs; installing a patched app requires build/signing and device validation. No app uninstall, signing change, or unofficial APK installation was performed.

After reviewing the checkout:

```sh
git checkout 2026.6.5
git apply --check /path/to/home-assistant-2026.6.5-multiple-files.patch
git apply /path/to/home-assistant-2026.6.5-multiple-files.patch
./gradlew :app:testFullDebugUnitTest --tests '*ShowWebFileChooserTest'
```

Compare source changes before applying to any other commit. Follow official Android development documentation for APK builds.

## Upstream submission

No upstream issue or PR was submitted. The [pinned upstream AGENTS.md](https://github.com/home-assistant/android/blob/3e132fab4d5d79de23222b158f9512f696eaf20d/AGENTS.md) requires human review and understanding before submission. [The draft](upstream-pr-draft.en.md) remains for human review; its unchecked checklist is not completed validation.

No private filenames, driving logs, or Ingress addresses are included in this patch bundle or report.
