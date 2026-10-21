package com.irissa.gzist.schedule

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.net.URLEncoder
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 把原 Node 版 server/server.mjs 的全部逻辑用 Kotlin 重写。
 * 运行在应用进程内的本地回环服务里，只在应用前台存活（无后台保活、无定时任务）。
 */
object Backend {

    private lateinit var ctx: Context
    @Volatile private var loaded = false

    // ---------- 常量 ----------
    private const val BASE = "https://portal.gzist.edu.cn"
    private const val CAS = "https://ids.gzist.edu.cn"
    private const val CAS_SERVICE = "https://portal.gzist.edu.cn/shiro-cas"
    private const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

    // 课表卡片实例 id：登录门户后在「学生课表」卡片的 uppcard 请求里可见，形如 cardId=xxxx。
    // App 里留空时，可写入 filesDir/config.json 的 {"cardId":"..."} 覆盖（见 cardId()）。
    private const val DEFAULT_CARD_ID = ""

    private const val CAS_MODULUS =
        "00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1"
    private const val CAS_RSA_CHUNK = 126
    private const val CAS_RSA_HEX = 256

    private val DAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    // ---------- 状态 ----------
    private val jar = ArrayList<Cookie>()
    private var authMeta = JSONObject()
    private val syncLock = Any()

    @Volatile var status = "idle"
    @Volatile var message = ""
    @Volatile var lastSyncAt: String? = null
    @Volatile var lastError: String? = null
    @Volatile var needLogin = false
    @Volatile var loggedOut = false

    // ---------- OKHttp（放宽证书校验，跟随内网 CA）----------
    private val trustAll: X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }
    private val http: OkHttpClient = run {
        val sc = SSLContext.getInstance("TLS")
        sc.init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        OkHttpClient.Builder()
            .sslSocketFactory(sc.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    fun init(c: Context) {
        ctx = c.applicationContext
        synchronized(this) {
            if (!loaded) {
                loadJar()
                loaded = true
            }
        }
    }

    // =====================================================================
    // 数据模型 / 文件
    // =====================================================================
    data class Cookie(
        val name: String,
        val value: String,
        val domain: String,
        val path: String,
        val secure: Boolean,
        val expires: Long
    )

    private val dataFile: File get() = File(ctx.filesDir, "data.json")
    private val authFile: File get() = File(ctx.filesDir, "auth.json")

    private fun loadJar() {
        try {
            val j = JSONObject(authFile.readText())
            jar.clear()
            val arr = j.optJSONArray("cookies")
            if (arr != null) for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { jar.add(cookieFromJson(it)) }
            authMeta = j.optJSONObject("meta") ?: JSONObject()
            val stu = authMeta.optJSONObject("student")
            if (stu != null && stu.optString("userId").isNotEmpty() && stu.optString("name").isNotEmpty()) {
                val known = authMeta.optJSONObject("known") ?: JSONObject()
                known.put(stu.optString("userId"), JSONObject().put("name", stu.optString("name")))
                authMeta.put("known", known)
            }
        } catch (e: Exception) {
            jar.clear(); authMeta = JSONObject()
        }
    }

    private fun saveJar() {
        val arr = JSONArray()
        for (c in jar) arr.put(cookieToJson(c))
        val root = JSONObject().put("cookies", arr).put("meta", authMeta)
        try { authFile.writeText(root.toString(2)) } catch (_: Exception) {}
    }

    private fun cookieFromJson(o: JSONObject) = Cookie(
        name = o.optString("name"),
        value = o.optString("value"),
        domain = o.optString("domain"),
        path = o.optString("path", "/").ifEmpty { "/" },
        secure = o.optBoolean("secure", false),
        expires = if (o.has("expires") && o.opt("expires") is Number) o.optLong("expires") else -1L
    )

    private fun cookieToJson(c: Cookie) = JSONObject()
        .put("name", c.name).put("value", c.value).put("domain", c.domain)
        .put("path", c.path).put("secure", c.secure).put("expires", c.expires)

    private fun readDataJson(): JSONObject? = try {
        if (dataFile.exists()) JSONObject(dataFile.readText()) else null
    } catch (e: Exception) { null }

    private fun writeDataJson(o: JSONObject) {
        try { dataFile.writeText(o.toString(2)) } catch (_: Exception) {}
    }

    // =====================================================================
    // Cookie Jar
    // =====================================================================
    private fun hostMatch(hostIn: String, domainIn: String): Boolean {
        val host = hostIn.lowercase()
        val domain = domainIn.lowercase().removePrefix(".")
        return host == domain || host.endsWith(".$domain")
    }

    private fun cookiesFor(urlStr: String): String {
        val u = urlStr.toHttpUrlOrNull() ?: return ""
        val now = System.currentTimeMillis() / 1000
        val picked = jar.filter { c ->
            hostMatch(u.host, c.domain) &&
                    (!c.secure || u.isHttps) &&
                    (c.path == "/" || u.encodedPath.startsWith(c.path.ifEmpty { "/" })) &&
                    (c.expires <= 0 || c.expires > now)
        }.sortedBy { (it.path.ifEmpty { "/" }).length }
        return picked.joinToString("; ") { "${it.name}=${it.value}" }
    }

    private fun upsertCookie(c: Cookie) {
        jar.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
        jar.add(c)
    }

    private fun absorbSetCookie(setCookies: List<String>?, urlStr: String) {
        if (setCookies.isNullOrEmpty()) return
        val u = urlStr.toHttpUrlOrNull() ?: return
        for (sc in setCookies) {
            val parts = sc.split(";").map { it.trim() }
            if (parts.isEmpty()) continue
            val nv = parts[0]
            val eq = nv.indexOf('=')
            if (eq < 0) continue
            val name = nv.substring(0, eq).trim()
            val value = nv.substring(eq + 1).trim()
            var domain = u.host
            var path = "/"
            var secure = false
            var expires = -1L
            for (a in parts.drop(1)) {
                val kvi = a.indexOf('=')
                val k = (if (kvi >= 0) a.substring(0, kvi) else a).trim().lowercase()
                val v = if (kvi >= 0) a.substring(kvi + 1).trim() else ""
                when (k) {
                    "domain" -> domain = v.removePrefix(".")
                    "path" -> path = v.ifEmpty { "/" }
                    "secure" -> secure = true
                    "max-age" -> v.toLongOrNull()?.let { expires = System.currentTimeMillis() / 1000 + it }
                    "expires" -> parseHttpDate(v)?.let { expires = it }
                }
            }
            val now = System.currentTimeMillis() / 1000
            if (expires in 1 until now) {
                jar.removeAll { it.name == name && it.domain == domain && it.path == path }
                continue
            }
            upsertCookie(Cookie(name, value, domain, path, secure, expires))
        }
    }

    private fun parseHttpDate(s: String): Long? {
        val fmts = listOf(
            "EEE, dd MMM yyyy HH:mm:ss zzz",   // RFC 1123
            "EEE, dd-MMM-yyyy HH:mm:ss zzz",   // RFC 850
            "EEE MMM d HH:mm:ss yyyy"          // asctime
        )
        for (f in fmts) {
            try {
                val sdf = SimpleDateFormat(f, Locale.US)
                sdf.timeZone = TimeZone.getTimeZone("GMT")
                val d = sdf.parse(s) ?: continue
                return d.time / 1000
            } catch (_: Exception) {}
        }
        return null
    }

    // =====================================================================
    // HTTP（自动带 Cookie、手动跟随重定向、自动收 Set-Cookie）
    // =====================================================================
    private data class Resp(val code: Int, val location: String?, val body: String, val finalUrl: String)

    private fun rawRequest(urlStr: String, method: String = "GET", extra: Map<String, String> = emptyMap(), formBody: String? = null): Resp {
        val url = urlStr.toHttpUrlOrNull() ?: throw RuntimeException("非法 URL: $urlStr")
        val b = Request.Builder().url(url)
        b.header("User-Agent", UA)
        b.header("Accept-Language", "zh-CN,zh;q=0.9")
        val ck = cookiesFor(urlStr)
        if (ck.isNotEmpty()) b.header("Cookie", ck)
        for ((k, v) in extra) b.header(k, v)
        if (formBody != null) {
            b.method(method, formBody.toRequestBody("application/x-www-form-urlencoded; charset=UTF-8".toMediaType()))
        } else if (method == "GET") {
            b.get()
        } else {
            b.method(method, ByteArray(0).toRequestBody(null))
        }
        http.newCall(b.build()).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            absorbSetCookie(resp.headers.values("Set-Cookie"), urlStr)
            return Resp(resp.code, resp.header("Location"), body, urlStr)
        }
    }

    private fun httpGet(urlStr: String, extra: Map<String, String> = emptyMap(), maxHops: Int = 10): Resp {
        var cur = urlStr
        for (i in 0 until maxHops) {
            val r = rawRequest(cur, "GET", extra)
            if (r.code in 300..399 && r.location != null) {
                val next = cur.toHttpUrlOrNull()?.resolve(r.location)?.toString()
                if (next != null) { cur = next; continue }
            }
            return r.copy(finalUrl = cur)
        }
        throw RuntimeException("重定向次数过多")
    }

    private fun formPost(urlStr: String, fields: Map<String, String>): Resp {
        val body = fields.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }
        return rawRequest(
            urlStr, "POST",
            mapOf("Origin" to CAS, "Referer" to "$CAS/lyuapServer/login", "Accept" to "application/json, text/plain, */*"),
            body
        )
    }

    // =====================================================================
    // 门户接口
    // =====================================================================
    class NeedLoginException(msg: String) : Exception(msg)

    private fun apiGet(path: String): Any? {
        val r = httpGet(
            "$BASE/${path.trimStart('/')}",
            mapOf("X-Requested-With" to "XMLHttpRequest", "Accept" to "application/json, text/plain, */*")
        )
        if (Regex("/login|lyuapServer|shiro-cas").containsMatchIn(r.finalUrl) && !Regex("/api/").containsMatchIn(r.finalUrl)) {
            throw NeedLoginException("会话已失效")
        }
        val json = try { JSONObject(r.body) } catch (e: Exception) {
            throw NeedLoginException("返回非 JSON（可能被重定向到登录页）")
        }
        val meta = json.optJSONObject("meta")
        if (meta == null || !meta.optBoolean("success", false)) {
            val msg = (meta ?: json).toString().take(200)
            if (Regex("登录|权限|token|auth|未授权", RegexOption.IGNORE_CASE).containsMatchIn(msg)) {
                throw NeedLoginException("接口失败: $msg")
            }
            throw RuntimeException("接口失败: $msg")
        }
        return json.opt("data")
    }

    // =====================================================================
    // CAS 登录
    // =====================================================================
    private fun rsaEncrypt(plain: String): String {
        val n = BigInteger(CAS_MODULUS, 16)
        val e = BigInteger.valueOf(65537)
        val s = plain.replace(Regex("\\s+"), "")
        val codes = ArrayList<Int>(s.length)
        for (ch in s) codes.add(ch.code)
        val nblocks = maxOf(1, (codes.size + CAS_RSA_CHUNK - 1) / CAS_RSA_CHUNK)
        while (codes.size < nblocks * CAS_RSA_CHUNK) codes.add(0)
        val out = ArrayList<String>()
        var off = 0
        while (off < codes.size) {
            var m = BigInteger.ZERO
            for (i in (CAS_RSA_CHUNK / 2 - 1) downTo 0) {
                val lo = codes[off + i * 2] and 0xffff
                val hi = codes[off + i * 2 + 1] and 0xffff
                val v = (lo + (hi shl 8)) and 0xffff
                m = m.shiftLeft(16).or(BigInteger.valueOf(v.toLong()))
            }
            val c = m.modPow(e, n)
            out.add(c.toString(16).padStart(CAS_RSA_HEX, '0'))
            off += CAS_RSA_CHUNK
        }
        return out.joinToString(" ")
    }

    private fun casCaptcha(): JSONObject {
        val r = httpGet("$CAS/lyuapServer/kaptcha?uid=", mapOf("Referer" to "$CAS/lyuapServer/login"))
        val j = JSONObject(r.body)
        if (!j.has("uid") || j.optString("uid").isEmpty()) throw RuntimeException("验证码获取失败")
        return JSONObject()
            .put("uid", j.optString("uid"))
            .put("image", j.optString("content"))
            .put("type", j.optString("kaptchaType"))
    }

    private val LOGIN_ERRORS = mapOf(
        "CODEFALSE" to "验证码错误",
        "PASSERROR" to "密码错误",
        "NOUSER" to "用户名或密码错误",
        "USERLOCK" to "账号已锁定，请稍后再试",
        "USERDISABLED" to "账号已被停用",
        "USERNOTONLY" to "账号不唯一，请联系管理员",
        "TWOVERIFY" to "需要二次验证（暂不支持，请改用粘贴 Cookie）",
        "ISMODIFYPASS" to "需要先修改密码才能登录（请先去门户改密）",
        "ISPHONEOREMAILORANSWER" to "需要手机/密保验证（暂不支持，请改用粘贴 Cookie）",
        "ISBINDWX" to "需要绑定微信（请改用粘贴 Cookie）",
        "NETWORKCOMMITMENT" to "需要先签署网络使用承诺书",
        "NOREGISTER" to "该账号未开通门户权限",
        "NOAUTHORIZATION" to "该账号未授权访问门户"
    )

    private fun hasPortalAuth(): Boolean =
        jar.any { it.name == "Authorization" && hostMatch("portal.gzist.edu.cn", it.domain) }

    private fun casRestSession(): Boolean {
        val tgt = jar.find { it.name == "CASTGC" && hostMatch("ids.gzist.edu.cn", it.domain) } ?: return false
        return try {
            val r = formPost("$CAS/lyuapServer/v1/tickets/${URLEncoder.encode(tgt.value, "UTF-8")}", mapOf("service" to CAS_SERVICE))
            val txt = r.body
            val st = Regex("ST-[0-9A-Za-z][0-9A-Za-z-]*").find(txt)?.value
                ?: Regex("ticket=(ST-[^&]+)").find(r.location ?: "")?.groupValues?.get(1)
            if (st == null) return false
            val sep = if (CAS_SERVICE.contains("?")) "&" else "?"
            httpGet("$CAS_SERVICE${sep}ticket=${URLEncoder.encode(st, "UTF-8")}")
            hasPortalAuth()
        } catch (e: Exception) { false }
    }

    private fun silentRenew(): Boolean {
        if (casRestSession()) return true
        return try {
            val r = httpGet("$BASE/shiro-cas")
            val okPortal = Regex("portal\\.gzist\\.edu\\.cn/(#|/|index)").containsMatchIn(r.finalUrl) && r.code == 200
            okPortal && hasPortalAuth()
        } catch (e: Exception) { false }
    }

    private fun casLogin(username: String, password: String, code: String, uid: String, loginType: String?) {
        if (username.isBlank() || password.isBlank()) throw RuntimeException("请填写学号和密码")
        if (uid.isBlank() || code.isBlank()) throw RuntimeException("请填写验证码")
        val snapshot = ArrayList(jar)
        jar.clear()
        try {
            val fields = LinkedHashMap<String, String>()
            fields["username"] = username.trim()
            fields["password"] = rsaEncrypt(password)
            fields["service"] = CAS_SERVICE
            if (!loginType.isNullOrEmpty()) fields["loginType"] = loginType
            fields["id"] = uid
            fields["code"] = code.trim()

            val r = formPost("$CAS/lyuapServer/v1/tickets", fields)
            val j = try { JSONObject(r.body) } catch (e: Exception) {
                throw RuntimeException(
                    if (r.body.trimStart().startsWith("<"))
                        "CAS 返回了网页而不是数据（验证码可能已过期，请刷新验证码重试）"
                    else "登录接口返回异常：${r.body.take(120)}"
                )
            }
            val d = j.optJSONObject("data") ?: JSONObject()
            val dcode = d.optString("code")
            if (dcode.isNotEmpty()) {
                if (dcode == "PASSERROR") {
                    val parts = d.optString("data").split(",")
                    val limit = parts.getOrNull(0) ?: ""
                    val count = parts.getOrNull(1)
                    throw RuntimeException(
                        if (count != null && count.matches(Regex("\\d+")))
                            "密码已连续错误 $count 次（连续错 $limit 次会锁定账号）" else "密码错误"
                    )
                }
                throw RuntimeException(LOGIN_ERRORS[dcode] ?: "登录失败：$dcode")
            }
            val meta = j.optJSONObject("meta")
            val metaNotFalse = meta == null || !meta.has("success") || meta.optBoolean("success", true)
            val hasTgtOrTicket = j.has("tgt") || j.has("ticket") || d.has("tgt") || d.has("ticket")
            if (!(metaNotFalse && hasTgtOrTicket)) {
                val mm = meta?.let { it.optString("message").ifEmpty { it.optString("statusCode") } } ?: "未知响应"
                throw RuntimeException("登录失败：$mm〔CAS 回包 ${r.code} ${r.body.replace(Regex("\\s+"), " ").take(200)}〕")
            }
            var tgt = if (j.opt("tgt") is String) j.optString("tgt") else ""
            if (tgt.isEmpty() && d.opt("tgt") is String) tgt = d.optString("tgt")
            if (tgt.isEmpty() && j.opt("data") is String) tgt = j.optString("data")
            var ticket = if (j.opt("ticket") is String) j.optString("ticket") else ""
            if (ticket.isEmpty() && d.opt("ticket") is String) ticket = d.optString("ticket")

            if (tgt.isNotEmpty()) upsertCookie(Cookie("CASTGC", tgt, "ids.gzist.edu.cn", "/lyuapServer", false, -1L))
            if (ticket.isNotEmpty()) {
                try {
                    val sep = if (CAS_SERVICE.contains("?")) "&" else "?"
                    httpGet("$CAS_SERVICE${sep}ticket=${URLEncoder.encode(ticket, "UTF-8")}")
                } catch (_: Exception) {}
            }
            if (!hasPortalAuth()) casRestSession()
            if (!hasPortalAuth()) silentRenew()
            if (!hasPortalAuth()) throw RuntimeException("已通过 CAS 认证，但没拿到门户会话（CAS 侧 TGT 已入 jar，稍后重试可能自动恢复）")
            loggedOut = false
            saveJar()
        } catch (e: Exception) {
            jar.clear(); jar.addAll(snapshot); throw e
        }
    }

    // =====================================================================
    // 课表解析与抓取
    // =====================================================================
    private data class CellInfo(val name: String, val room: String, val teacher: String, val cls: String)

    private fun parseCell(str: String): CellInfo {
        val p = str.split(",")
        if (p.size < 2) return CellInfo(str, "", "", "")
        return CellInfo(p[0], p[1], p[p.size - 1], p.subList(2, p.size - 1).joinToString(","))
    }

    private fun toBlocks(grid: JSONArray?): JSONArray {
        val blocks = JSONArray()
        if (grid == null) return blocks
        for (di in 0 until grid.length()) {
            val row = grid.optJSONArray(di) ?: continue
            var ci = 0
            while (ci < row.length()) {
                val cell = if (row.isNull(ci)) "" else row.optString(ci, "")
                if (cell.isEmpty()) { ci++; continue }
                val info = parseCell(cell)
                var end = ci
                while (end + 1 < row.length() && (if (row.isNull(end + 1)) "" else row.optString(end + 1, "")) == cell) end++
                blocks.put(
                    JSONObject()
                        .put("day", di)
                        .put("dayName", DAYS.getOrElse(di) { "" })
                        .put("startSection", ci + 1)
                        .put("endSection", end + 1)
                        .put("name", info.name)
                        .put("room", info.room)
                        .put("teacher", info.teacher)
                        .put("cls", info.cls)
                )
                ci = end + 1
            }
        }
        return blocks
    }

    private fun configJson(): JSONObject = try {
        val cf = File(ctx.filesDir, "config.json")
        if (cf.exists()) JSONObject(cf.readText()) else JSONObject()
    } catch (e: Exception) { JSONObject() }

    private fun saveConfig(o: JSONObject) {
        try { File(ctx.filesDir, "config.json").writeText(o.toString(2)) } catch (_: Exception) {}
    }

    private fun cardId(): String {
        val cf = configJson().optString("cardId", "")
        if (cf.isNotEmpty()) return cf
        val m = authMeta.optString("cardId", "")
        if (m.isNotEmpty()) return m
        if (DEFAULT_CARD_ID.isNotEmpty()) return DEFAULT_CARD_ID
        return BuildConfig.DEFAULT_CARD_ID
    }

    private fun decodeJwtPayload(tok: String): JSONObject? {
        return try {
            val parts = tok.split(".")
            if (parts.size < 2) return null
            val b = android.util.Base64.decode(
                parts[1],
                android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
            )
            JSONObject(String(b, Charsets.UTF_8))
        } catch (e: Exception) { null }
    }

    private fun studentId(): String? {
        val c = jar.find { it.name == "Authorization" && hostMatch("portal.gzist.edu.cn", it.domain) } ?: return null
        val p = decodeJwtPayload(c.value) ?: return null
        val sub = p.optString("sub", "")
        return if (sub.isEmpty()) null else sub
    }

    private fun deptFromBlocks(termsData: JSONObject): String? {
        val r1 = Regex("-(\\d{2}[^-]{0,20}?班)-")
        val r2 = Regex("-(\\d{2}[^-]{0,20}?班)")
        val tKeys = termsData.keys()
        while (tKeys.hasNext()) {
            val t = termsData.optJSONObject(tKeys.next()) ?: continue
            val pools = ArrayList<JSONArray>()
            t.optJSONArray("blocks")?.let { pools.add(it) }
            t.optJSONObject("weeks")?.let { weeks ->
                val wk = weeks.keys()
                while (wk.hasNext()) weeks.optJSONArray(wk.next())?.let { pools.add(it) }
            }
            for (pool in pools) {
                for (i in 0 until pool.length()) {
                    val b = pool.optJSONObject(i) ?: continue
                    val cls = b.optString("cls", "")
                    val m = r1.find(cls) ?: r2.find(cls)
                    if (m != null) return m.groupValues[1]
                }
            }
        }
        return null
    }

    private fun fetchWeek(cardIdV: String, xnq: String, week: String): JSONObject? {
        val q = "api/uppcard/kbsz/queryAWeekSchedule?cardId=$cardIdV&results=$week&years=" +
                URLEncoder.encode(xnq, "UTF-8")
        return apiGet(q) as? JSONObject
    }

    private fun doFetchAll(): JSONObject {
        val cid = cardId()
        val termsAny = try {
            apiGet("api/uppcard/kbsz/queryAllTerm?cardId=$cid")
        } catch (e: Exception) {
            if (cid.isEmpty() && e !is NeedLoginException) throw RuntimeException("还没设置课表卡片ID：请关掉这个窗口，点屏幕底部的黄色提示条填写后再试")
            throw e
        }
        val termArr = termsAny as? JSONArray ?: JSONArray()
        val termList = ArrayList<String>()
        for (i in 0 until termArr.length()) {
            val o = termArr.optJSONObject(i)
            if (o != null) termList.add(o.optString("XNXQ")) else termList.add(termArr.optString(i))
        }

        val termsData = JSONObject()
        for (xnq in termList) {
            val base = fetchWeekOrNull(cardId(), xnq, "")
            if (base == null) {
                termsData.put(xnq, JSONObject().put("blocks", JSONArray()).put("weeks", JSONObject()))
                continue
            }
            val weekcount = minOf(30, maxOf(1, base.optInt("weekcount", 20)))
            val currentWeekRaw = base.optInt("zs", 0)
            val currentWeek = if (currentWeekRaw > 0) currentWeekRaw else 0
            val grids = HashMap<Int, JSONArray>()
            if (currentWeek > 0) grids[currentWeek] = base.optJSONArray("resultsJsonArr") ?: JSONArray()
            for (w in 1..weekcount) {
                if (grids.containsKey(w)) continue
                val d = fetchWeekOrNull(cardId(), xnq, w.toString())
                grids[w] = d?.optJSONArray("resultsJsonArr") ?: JSONArray()
            }
            val weeks = JSONObject()
            for (w in 1..weekcount) weeks.put(w.toString(), toBlocks(grids[w]))
            val cw = if (currentWeek > 0) currentWeek else 1

            val t = JSONObject()
            t.put("xn", base.optString("xn"))
            t.put("xq", base.optString("xq"))
            t.put("zsms", base.optString("zsms"))
            t.put("weekcount", weekcount)
            t.put("currentWeek", if (currentWeek > 0) currentWeek else JSONObject.NULL)
            t.put("swskjc", base.opt("swskjc") ?: JSONObject.NULL)
            t.put("xwskjc", base.opt("xwskjc") ?: JSONObject.NULL)
            t.put("wsskjc", base.opt("wsskjc") ?: JSONObject.NULL)
            t.put("weeks", weeks)
            t.put("zs", cw.toString())
            t.put("blocks", weeks.optJSONArray(cw.toString()) ?: JSONArray())
            termsData.put(xnq, t)
        }

        // 认出当前账号
        val sid = studentId()
        val known = authMeta.optJSONObject("known")
        val knownName = if (sid != null) known?.optJSONObject(sid)?.optString("name", "") ?: "" else ""
        val prevObj = authMeta.optJSONObject("student")
        val prev = if (prevObj != null && (sid == null || prevObj.optString("userId") == sid)) prevObj else null
        var dept = prev?.optString("dept", "") ?: ""
        if (dept.isEmpty()) dept = deptFromBlocks(termsData) ?: ""
        var name = prev?.optString("name", "") ?: ""
        if (name.isEmpty()) name = knownName

        val student: JSONObject? = if (sid != null || dept.isNotEmpty() || name.isNotEmpty()) {
            JSONObject()
                .put("userId", sid ?: JSONObject.NULL)
                .put("name", if (name.isEmpty()) JSONObject.NULL else name)
                .put("dept", if (dept.isEmpty()) JSONObject.NULL else dept)
        } else null
        if (sid != null && name.isNotEmpty()) {
            val kn = authMeta.optJSONObject("known") ?: JSONObject()
            kn.put(sid, JSONObject().put("name", name))
            authMeta.put("known", kn)
        }
        if (student != null) authMeta.put("student", student)

        return JSONObject()
            .put("fetchedAt", isoNow())
            .put("source", "portal.gzist.edu.cn / ly-upp kbsz")
            .put("cardId", cardId())
            .put("student", student ?: JSONObject.NULL)
            .put("terms", JSONArray(termList))
            .put("termsData", termsData)
    }

    private fun fetchWeekOrNull(cardIdV: String, xnq: String, week: String): JSONObject? {
        return try {
            fetchWeek(cardIdV, xnq, week)
        } catch (e: NeedLoginException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    private fun isoNow(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
    }

    // =====================================================================
    // 同步
    // =====================================================================
    private fun sync(reason: String): JSONObject = synchronized(syncLock) {
        status = "syncing"; message = "同步中（$reason）"
        try {
            var data: JSONObject
            try {
                data = doFetchAll()
            } catch (e: NeedLoginException) {
                message = "会话失效，尝试静默续期…"
                val renewed = silentRenew()
                if (!renewed) throw NeedLoginException("登录已失效，需要重新导入 Cookie")
                data = doFetchAll()
            }
            if (!data.has("student") || data.isNull("student")) {
                readDataJson()?.let { old -> if (old.has("student") && !old.isNull("student")) data.put("student", old.opt("student")) }
            }
            writeDataJson(data)
            saveJar()
            status = "ok"; needLogin = false; lastError = null; loggedOut = false
            lastSyncAt = data.optString("fetchedAt"); message = "同步成功"
            return data
        } catch (e: Exception) {
            val nl = e is NeedLoginException
            status = if (nl) "needLogin" else "error"
            needLogin = nl
            lastError = e.message
            message = e.message ?: "同步失败"
            throw e
        }
    }

    // =====================================================================
    // 路由
    // =====================================================================
    fun route(session: IHTTPSession, path: String): Response {
        return try {
            when {
                path == "/api/status" -> jsonResp(statusObj())
                path == "/api/schedule" && session.method == Method.GET -> scheduleResp()
                path == "/api/sync" && session.method == Method.POST -> syncResp()
                path == "/api/auth/captcha" && session.method == Method.GET -> captchaResp()
                path == "/api/auth/login" && session.method == Method.POST -> loginResp(readBody(session))
                path == "/api/auth/cookies" && session.method == Method.POST -> cookiesResp(readBody(session))
                path == "/api/auth/logout" && session.method == Method.POST -> logoutResp(readBody(session))
                path == "/api/config" && session.method == Method.GET -> configResp()
                path == "/api/config" && session.method == Method.POST -> setConfigResp(readBody(session))
                else -> jsonResp(JSONObject().put("ok", false).put("error", "not_found").put("path", path))
            }
        } catch (e: Exception) {
            jsonResp(JSONObject().put("ok", false).put("error", e.message ?: "服务器错误"))
        }
    }

    private fun stateJson(): JSONObject = JSONObject()
        .put("status", status)
        .put("message", message)
        .put("lastSyncAt", lastSyncAt ?: JSONObject.NULL)
        .put("lastError", lastError ?: JSONObject.NULL)
        .put("needLogin", needLogin)
        .put("loggedOut", loggedOut)

    private fun statusObj(): JSONObject = stateJson()
        .put("ok", true)
        .put("autoSyncMin", 0)
        .put("keepaliveMin", 0)
        .put("hasCookies", jar.isNotEmpty())

    private fun scheduleResp(): Response {
        val data = readDataJson()
        val o = JSONObject()
            .put("ok", data != null)
            .put("state", stateJson())
            .put("fetchedAt", data?.opt("fetchedAt") ?: JSONObject.NULL)
            .put("student", data?.opt("student") ?: JSONObject.NULL)
            .put("data", data ?: JSONObject.NULL)
        return jsonResp(o)
    }

    private fun syncResp(): Response {
        return try {
            val data = sync("manual")
            jsonResp(JSONObject().put("ok", true).put("fetchedAt", data.opt("fetchedAt")).put("state", stateJson()))
        } catch (e: Exception) {
            jsonResp(JSONObject().put("ok", false).put("error", e.message).put("needLogin", needLogin).put("state", stateJson()))
        }
    }

    private fun captchaResp(): Response {
        return try {
            val cap = casCaptcha()
            jsonResp(JSONObject().put("ok", true).put("uid", cap.optString("uid")).put("image", cap.optString("image")).put("type", cap.optString("type")))
        } catch (e: Exception) {
            jsonResp(JSONObject().put("ok", false).put("error", e.message ?: "验证码获取失败"))
        }
    }

    private fun loginResp(body: JSONObject): Response {
        val username = body.optString("username")
        val password = body.optString("password")
        val code = body.optString("code")
        val uid = body.optString("uid")
        val loginType = if (body.has("loginType")) body.optString("loginType") else null
        // 第一步：CAS 认证。失败才算“登录失败”。
        try {
            casLogin(username, password, code, uid, loginType)
        } catch (e: Exception) {
            return jsonResp(JSONObject().put("ok", false).put("error", e.message ?: "登录失败").put("state", stateJson()))
        }
        // 第二步：认证已成功（会话已保存）。抓课表失败不应让“登录”被判失败——
        // 最常见是还没设置课表卡片 cardId。把错误放进 syncError 交给前端提示。
        var data: JSONObject? = null
        var syncError: String? = null
        try {
            data = sync("login")
        } catch (e: Exception) {
            syncError = e.message
        }
        return jsonResp(
            JSONObject().put("ok", true)
                .put("fetchedAt", data?.opt("fetchedAt") ?: JSONObject.NULL)
                .put("student", data?.opt("student") ?: JSONObject.NULL)
                .put("syncError", syncError ?: JSONObject.NULL)
                .put("state", stateJson())
        )
    }

    private fun cookiesResp(body: JSONObject): Response {
        var imported = 0
        val onlyGzist = if (body.has("onlyGzist")) body.optBoolean("onlyGzist", true) else true

        val arr = body.optJSONArray("cookies")
        if (arr != null) for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val name = c.optString("name")
            if (name.isEmpty()) continue
            val dom = c.optString("domain").removePrefix(".")
            if (onlyGzist && !Regex("gzist\\.edu\\.cn$", RegexOption.IGNORE_CASE).containsMatchIn(dom)) continue
            val exp = if (c.has("expires") && c.opt("expires") is Number && c.optLong("expires") > 0) c.optLong("expires") else -1L
            upsertCookie(Cookie(name, c.optString("value"), dom, c.optString("path", "/").ifEmpty { "/" }, c.optBoolean("secure", false), exp))
            imported++
        }

        val cookieStr = if (body.opt("cookie") is String) body.optString("cookie").trim() else ""
        if (cookieStr.isNotEmpty()) {
            val domain = body.optString("domain").ifEmpty { "portal.gzist.edu.cn" }
            for (kv in cookieStr.split(";")) {
                val i = kv.indexOf('=')
                if (i < 0) continue
                upsertCookie(Cookie(kv.substring(0, i).trim(), kv.substring(i + 1).trim(), domain, "/", true, -1L))
                imported++
            }
        }
        if (body.has("student")) {
            val stu = body.opt("student")
            authMeta.put("student", stu)
            if (stu is JSONObject) {
                val sid = studentId() ?: stu.optString("userId")
                val nm = stu.optString("name")
                if (sid.isNotEmpty() && nm.isNotEmpty()) {
                    val kn = authMeta.optJSONObject("known") ?: JSONObject()
                    kn.put(sid, JSONObject().put("name", nm))
                    authMeta.put("known", kn)
                }
            }
        }
        if (body.optString("cardId").isNotEmpty()) authMeta.put("cardId", body.optString("cardId"))
        saveJar()
        return jsonResp(JSONObject().put("ok", true).put("imported", imported).put("total", jar.size))
    }

    private fun configResp(): Response {
        val cid = cardId()
        return jsonResp(JSONObject().put("ok", true).put("cardId", cid).put("hasCardId", cid.isNotEmpty()))
    }

    private fun setConfigResp(body: JSONObject): Response {
        val cid = body.optString("cardId").trim()
        val cfg = configJson()
        if (cid.isEmpty()) cfg.remove("cardId") else cfg.put("cardId", cid)
        saveConfig(cfg)
        return jsonResp(JSONObject().put("ok", true).put("cardId", cid).put("hasCardId", cid.isNotEmpty()))
    }

    private fun logoutResp(body: JSONObject): Response {
        val wipe = if (body.has("wipe")) body.optBoolean("wipe", true) else true
        val removed = jar.size
        jar.clear()
        val known = authMeta.optJSONObject("known")
        authMeta = JSONObject()
        if (known != null) authMeta.put("known", known)
        saveJar()
        if (wipe) { try { dataFile.delete() } catch (_: Exception) {} }
        status = "needLogin"; message = "已退出登录"; lastSyncAt = null; lastError = null
        needLogin = true; loggedOut = true
        return jsonResp(JSONObject().put("ok", true).put("removed", removed).put("wiped", wipe).put("state", stateJson()))
    }

    // ---------- 工具 ----------
    private fun jsonResp(obj: JSONObject): Response {
        return NanoHTTPD.newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", obj.toString())
            .apply {
                addHeader("Access-Control-Allow-Origin", "*")
                addHeader("Cache-Control", "no-store")
            }
    }

    private fun readBody(session: IHTTPSession): JSONObject {
        return try {
            val map = HashMap<String, String>()
            session.parseBody(map)
            val s = (map["postData"] ?: "").trim()
            if (s.isEmpty()) JSONObject() else JSONObject(s)
        } catch (e: Exception) { JSONObject() }
    }
}
