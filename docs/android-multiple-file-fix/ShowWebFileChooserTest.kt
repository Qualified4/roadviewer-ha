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

class ShowWebFileChooserTest {
    private val chooser = ShowWebFileChooser()

    @Test
    fun `Given a single URI when parsing successful selection then return the URI`() {
        val uri = mockk<Uri>()
        assertArrayEquals(arrayOf(uri), chooser.parseResult(Activity.RESULT_OK, resultIntent(uri)))
    }

    @Test
    fun `Given ClipData only when parsing two selected files then return both URIs`() {
        val first = mockk<Uri>()
        val second = mockk<Uri>()
        assertArrayEquals(
            arrayOf(first, second),
            chooser.parseResult(Activity.RESULT_OK, resultIntent(clips = listOf(first, second))),
        )
    }

    @Test
    fun `Given overlapping data and clips when parsing selection then preserve order without duplicates`() {
        val first = mockk<Uri>()
        val second = mockk<Uri>()
        assertArrayEquals(
            arrayOf(first, second),
            chooser.parseResult(Activity.RESULT_OK, resultIntent(first, listOf(first, second))),
        )
    }

    @Test
    fun `Given cancelled result with stale URIs when parsing then return null`() {
        assertNull(chooser.parseResult(Activity.RESULT_CANCELED, resultIntent(mockk())))
    }

    @Test
    fun `Given missing intent when parsing successful result then return null`() {
        assertNull(chooser.parseResult(Activity.RESULT_OK, null))
    }

    @Test
    fun `Given successful result without URIs when parsing then return null`() {
        assertNull(chooser.parseResult(Activity.RESULT_OK, resultIntent()))
    }

    @Test
    fun `Given a clip without URI when parsing then ignore it and preserve valid files`() {
        val uri = mockk<Uri>()
        assertArrayEquals(
            arrayOf(uri),
            chooser.parseResult(Activity.RESULT_OK, resultIntent(clips = listOf(null, uri))),
        )
    }

    private fun resultIntent(data: Uri? = null, clips: List<Uri?>? = null): Intent {
        val clipData = clips?.let { uris ->
            mockk<ClipData> {
                every { itemCount } returns uris.size
                uris.forEachIndexed { index, uri ->
                    every { getItemAt(index) } returns mockk<ClipData.Item> { every { getUri() } returns uri }
                }
            }
        }
        return mockk {
            every { getData() } returns data
            every { getClipData() } returns clipData
        }
    }
}
