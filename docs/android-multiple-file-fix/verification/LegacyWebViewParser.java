package io.homeassistant.companion.android.webview;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
public class LegacyWebViewParser {
    public static Uri[] parseFileChooserResult(int resultCode, Intent intent) {
        if (resultCode == Activity.RESULT_CANCELED) {
            return null;
        }
        Uri result = intent == null || resultCode != Activity.RESULT_OK ? null : intent.getData();

        Uri[] uris = null;
        if (result != null) {
            uris = new Uri[1];
            uris[0] = result;
        }
        return uris;
    }

}
