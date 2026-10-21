package com.irissa.gzist.schedule

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {

    private var server: LocalServer? = null
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 启动本机回环服务（等价于原 server.mjs），端口与前端约定一致：8787
        try {
            val s = LocalServer(applicationContext, PORT)
            s.start()
            server = s
        } catch (_: Exception) {
            // 端口占用等异常时仍尝试加载，前端会自行提示
        }

        web = WebView(this)
        web.setBackgroundColor(Color.WHITE)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            // window.open / target=_blank 走同窗口导航，交给 shouldOverrideUrlLoading 处理
            setSupportMultipleWindows(false)
            userAgentString = userAgentString + " GuangliTimetable/1.0"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val host = url.host ?: ""
                return if (host == "127.0.0.1" || host == "localhost") {
                    false // 本机地址应用内打开
                } else {
                    openExternal(url) // 学校门户等外部链接用系统浏览器
                }
            }
        }

        setContentView(
            web,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        web.loadUrl("http://127.0.0.1:$PORT/")
    }

    private fun openExternal(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) {
            false
        }
    }

    override fun onDestroy() {
        try { server?.stop() } catch (_: Exception) {}
        server = null
        try {
            web.loadUrl("about:blank")
            web.destroy()
        } catch (_: Exception) {}
        super.onDestroy()
    }

    companion object {
        const val PORT = 8787
    }
}
