package io.homeassistant.companion.android.webview

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts

class ShowWebFileChooser : ActivityResultContract<WebChromeClient.FileChooserParams, Array<Uri>?>() {

    override fun createIntent(context: Context, input: WebChromeClient.FileChooserParams): Intent {
        return input.createIntent().apply {
            type = "*/*"
        }
    }

    override fun parseResult(resultCode: Int, intent: Intent?): Array<Uri>? {
        // The WebView parser only reads Intent.data and drops ClipData-only results.
        return ActivityResultContracts.GetMultipleContents()
            .parseResult(resultCode, intent)
            .takeIf { it.isNotEmpty() }
            ?.toTypedArray()
    }
}
