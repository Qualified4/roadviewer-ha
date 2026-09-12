package io.homeassistant.companion.android.webview

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertNull

class LegacyWebViewParserTest {
    @Test
    fun `Given two ClipData URIs when old parser runs then result is null but fixed parser returns both`() {
        val first = mockk<Uri>()
        val second = mockk<Uri>()
        val clips = mockk<ClipData> {
            every { itemCount } returns 2
            every { getItemAt(0) } returns mockk<ClipData.Item> { every { uri } returns first }
            every { getItemAt(1) } returns mockk<ClipData.Item> { every { uri } returns second }
        }
        val intent = mockk<Intent> {
            every { data } returns null
            every { clipData } returns clips
        }
        assertNull(LegacyWebViewParser.parseFileChooserResult(Activity.RESULT_OK, intent))
        assertArrayEquals(arrayOf(first, second), ShowWebFileChooser().parseResult(Activity.RESULT_OK, intent))
    }
}
