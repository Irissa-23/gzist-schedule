package com.irissa.gzist.schedule

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream

/**
 * 本机回环 HTTP 服务：等价于原项目的 server/server.mjs。
 * 负责把打包在 assets 里的前端页面发给 WebView，并承载 api 业务接口。
 */
class LocalServer(
    private val context: Context,
    port: Int
) : NanoHTTPD(port) {

    init {
        Backend.init(context)
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri.substringBefore('?')
        return if (uri.startsWith("/api/")) {
            Backend.route(session, uri)
        } else {
            serveAsset(uri)
        }
    }

    private fun serveAsset(uri: String): Response {
        var path = uri.trimStart('/')
        if (path.isEmpty()) path = "index.html"
        return try {
            val bytes = context.assets.open(path).use { it.readBytes() }
            newFixedLengthResponse(
                Response.Status.OK,
                mimeOf(path),
                ByteArrayInputStream(bytes),
                bytes.size.toLong()
            ).apply {
                addHeader("Cache-Control", "no-store")
            }
        } catch (e: Exception) {
            newFixedLengthResponse(
                Response.Status.NOT_FOUND,
                "text/plain; charset=utf-8",
                "404 Not Found: $path"
            )
        }
    }

    private fun mimeOf(path: String): String = when {
        path.endsWith(".html") || path.endsWith(".htm") -> "text/html; charset=utf-8"
        path.endsWith(".js") || path.endsWith(".mjs") -> "application/javascript; charset=utf-8"
        path.endsWith(".css") -> "text/css; charset=utf-8"
        path.endsWith(".json") -> "application/json; charset=utf-8"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
        path.endsWith(".webp") -> "image/webp"
        path.endsWith(".ico") -> "image/x-icon"
        else -> "application/octet-stream"
    }
}
