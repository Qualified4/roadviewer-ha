<!--
    Please review the contributing guide before submitting: https://developers.home-assistant.io/docs/android/submit
    Please, complete the following sections to help the processing and review of your changes.
    Please, DO NOT DELETE ANY TEXT from this template! (unless instructed).

    Thank you for submitting a Pull Request and helping to improve Home Assistant. You are amazing!
-->

## Summary

Selecting two or more files in a WebView file input can return no files even when the picker reports success. `ShowWebFileChooser` delegates to `WebChromeClient.FileChooserParams.parseResult`, whose Chromium 151.0.7922.199 implementation reads only `Intent.data` and ignores ClipData-only results.

Use the existing AndroidX GetMultipleContents result parser and map an empty list to null. This handles both single and multiple URI results while preserving cancellation behavior and the existing chooser intent.

Reproduced against the extracted Chromium parser and fixed Kotlin class in an isolated JVM harness using AndroidX activity 1.13.0: the old parser returns null for two ClipData URIs; the fixed parser returns both. Seven regression cases also pass. Full Companion Gradle checks and device testing remain outstanding. The attached backport targets 2026.6.5; the equivalent current-main change is in FileChooserEffect.kt.

<!--
    Provide a brief summary of the changes you have made and most importantly what they aim to achieve.
    Don't forget any links that could be useful to the reader. (Github issues, PRs, documentation, articles, ...)

    * What was the motivation behind this change?
    * What is the impact of the changes on the application?
-->

## Checklist
<!--
    Put an `x` in the boxes that apply. You can also fill these out after
    creating the PR. If you're unsure about any of them, don't hesitate to ask.
    We're here to help! This is simply a reminder of what we are going to look
    for before merging your code.
-->

- [ ] New or updated tests have been added to cover the changes following the testing [guidelines](https://developers.home-assistant.io/docs/android/testing/introduction).
- [ ] The code follows the project's [code style](https://developers.home-assistant.io/docs/android/codestyle) and [best_practices](https://developers.home-assistant.io/docs/android/best_practices).
- [ ] The changes have been thoroughly tested, and edge cases have been considered.
- [ ] Changes are backward compatible whenever feasible. Any breaking changes are documented in the changelog for users and/or in the code for developers depending on the relevance.
- [ ] I have read the [Open Home Foundation AI Policy](https://developers.home-assistant.io/docs/ai_policy).

Select exactly one option that describes AI usage in this contribution:

- [ ] I have not used AI for this contribution.
- [ ] AI assistance was used for this contribution.
- [ ] AI fully generated the code for this contribution, but I've reviewed and understood it before submitting and will respond without AI during review.

## Screenshots
<!--
    If this is a user-facing change not in the frontend, please include screenshots in light and dark mode.

    Note: Remove this section if there are no screenshots.
-->

## Link to pull request in documentation repositories
<!-- 
    This pull request introduces, changes, or removes user-facing functionality.
    A corresponding update to the Companion App documentation in the documentation repository (https://github.com/home-assistant/companion.home-assistant) is required.

    Instructions:
    1. Create a pull request in the documentation repository.
    2. Add the documentation pull request number after the "#" below.
    3. Add the `<span class='beta'>BETA</span> ` flag in the documentation to mark it as such.

    Note: Remove this section if there is no PR.
-->
User Documentation: home-assistant/companion.home-assistant#

<!-- 
    This pull request introduces, changes, or removes developer-facing functionality.
    A corresponding update to the Developer documentation in the documentation repository (https://github.com/home-assistant/developers.home-assistant) is required.

    Instructions:
    1. Create a pull request in the documentation repository.
    2. Add the documentation pull request number after the "#" below.

    Note: Remove this section if there is no PR.
-->
Developer Documentation: home-assistant/developers.home-assistant#

## Any other notes

This is an unsubmitted draft prepared with AI. The human review and AI policy acknowledgments below must be completed by the person submitting it. No physical-device validation or full-project CI result is claimed.

<!-- 
    If there is any other information of note, like if this Pull Request is part of a bigger change, please include it here.
-->