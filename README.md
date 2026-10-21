# 广理课表 · 门户课表逆向 + 手机一屏课表

> 学校把课表入口关了。本项目通过逆向「融合门户」的课表接口，用**本人登录态**直接取回整学期课表，
> 并做成两种形态：
> - **网页版**：一个能把整周课表一屏铺满的手机网页（横屏、竖屏都支持，不用转屏）；
> - **安卓 App（APK）**：把本地后端**用 Kotlin 原生重写并内置进 App**，手机上装完即用，
>   不依赖电脑、不需要同一个 WiFi、也不需要另起 Node 服务。

仅用于查看本人课表，请勿用于抓取他人数据或压测学校服务器。

---

## 效果

| 手机横屏 844×390 | 小屏横屏 568×320 | 手机竖屏 390×844 |
| --- | --- | --- |
| ![](shots/l844.png) | ![](shots/l568.png) | ![](shots/portrait.png) |

顶栏的周次切换（`‹ [第8周 · 本周] › 本周`）：

| 手机横屏 844×390 | 小屏横屏 568×320 |
| --- | --- |
| ![](shots/l844.png) | ![](shots/l568.png) |

---

## 作业要求对照

| 要求 | 实现 |
| --- | --- |
| 展示课程名称（可以不完整） | ✅ 最多 2 行，超出省略号截断 |
| 展示教室号（**完整**） | ✅ 单独成行、可换行、**绝不省略**；`（白云）` 校区后缀拆成小字整体换行 |
| 有上下课时间（**完整**） | ✅ 时间只放在左侧栏，每节两行 `08:20` / `09:05`，10 节课一节不漏 |
| 完整展示 | ✅ 7 天 × 全部节次一屏铺满、无滚动；横屏竖屏都行（竖屏自动换成窄列排版） |
| 按周次查看 | ✅ 顶栏 `‹ 第N周 › 本周`：整学期 20 周都抓到本地，换周零延迟，当前周标「· 本周」 |
| 前端（加分项） | ✅ 零依赖单文件、按课程自动配色、今日列高亮、学期切换、安全区适配、**打开即见 + 后台自动更新 + 断网可用** |

---

## 两种形态与总体架构

后端本质是一个**约 700 行的「带 Cookie 的跨域网关」**：它持有门户登录态，
替你向学校门户发请求、吸收 `Set-Cookie`、处理跳转，再把课表整理成干净的 JSON 给前端。

| 形态 | 运行方式 | 适用 |
| --- | --- | --- |
| **网页版** | 电脑跑 `node server/server.mjs`，浏览器开 `127.0.0.1:8787`（手机同 WiFi 也行） | 电脑上看、或临时用 |
| **安卓 App** | 用 Kotlin 把同一套后端逻辑重写进 App，App 内起一个本地 HTTP 服务（`127.0.0.1:8787`），WebView 加载同一个前端页面 | 手机上装完即用、脱离电脑 |

> 为什么 APK 不能直接打包 Node？手机上没有 Node 运行时，且源门户的 TLS 证书可能不被系统信任，
> 纯静态网页又发不了跨域带 Cookie 的请求——所以必须有一个本地后端来「代发」请求。
> 详见下方 [安卓 App 开发](#安卓-appapk)。

---

## 目录结构

```
广理课表/
├─ server/
│  └─ server.mjs          # 零依赖本地服务：托管 Cookie、静默续期、/api/*、静态资源
├─ scripts/
│  └─ import-cookies.mjs  # 登录失效时，把浏览器 Cookie 一键导入服务端
├─ fetch/
│  └─ fetch.mjs           # 纯脚本抓取（给定 token 直接出 JSON），不依赖服务端
├─ web/
│  └─ index.html          # 前端（单文件，无依赖）；data.json / data.js 为运行期生成
├─ data/                  # 运行期生成（已被 .gitignore 忽略，绝不提交）
│  └─ auth.json           # Cookie Jar + 学生信息（本地私密）
├─ docs/
│  └─ 逆向说明.md          # 入口分析、接口清单、字段、作息、CAS 登录协议、数据流
├─ shots/                 # 各尺寸截图（已做脱敏）
├─ android/               # 安卓 App（APK）源码：Kotlin 原生本地后端 + WebView
│  └─ app/src/main/
│     ├─ java/com/irissa/gzist/schedule/
│     │  ├─ MainActivity.kt    # WebView + 启动本地服务
│     │  ├─ LocalServer.kt     # NanoHTTPD：/api/* 转后端，其余出静态资源
│     │  └─ Backend.kt         # server.mjs 的 Kotlin 移植：CAS 登录/验证码/同步
│     ├─ assets/index.html     # 由 web/index.html 复制而来（前端 0 改动）
│     └─ AndroidManifest.xml
└─ README.md
```

---

## 快速开始（网页版）

### 方式 A：只看课表（最省事）

```bash
node server/server.mjs      # 或 npm start
# 浏览器打开 http://127.0.0.1:8787
```

服务会把课表同步到 `web/data.json`，页面**先显示缓存、再自动更新**，顶栏胶囊显示更新时间。

### 方式 B：手机同局域网访问

```bash
node server/server.mjs
# 手机与电脑同一 WiFi，浏览器打开 http://<电脑局域网IP>:8787 ，横屏竖屏都行
```

### 方式 C：完全静态（不带服务）

直接双击 `web/index.html`。用的是 `web/data.js` 内置数据，
也能连上 `127.0.0.1:8787` 时自动取最新，取不到就显示缓存。

---

## 安卓 App（APK）

### 设计取舍

一开始评估过三条路：

1. **nodejs-mobile**：把 Node 原样塞进 APK。前端 0 改动，但包体大、后台保活难、Node 版本旧，弃用。
2. **Kotlin 原生重写后端（采用）**：用 `NanoHTTPD` 在 App 内起本地 `127.0.0.1:8787`，
   `OkHttp` 代发到门户（`trust-all` 跳过学校可能的无效证书、手写 `CookieJar` 持久化），
   把 `server.mjs` 的全部逻辑（CAS 登录、验证码、RSA 加密、静默续期、课表同步）用 Kotlin 复刻。
   **前端 `web/index.html` 一行不改**，直接复用它。
3. 前端 JS 直连门户（`plus.net` 绕 CORS）：改动大、证书绕不过、还要处理 HttpOnly Cookie，否决。

结论：选 **路线 2（Kotlin 原生）**，用 **Android Studio / Gradle** 出包（不是 HBuilder）。

### 生命周期：纯前台、缓存优先（不做常驻）

课表是「一次性用品」——看完即划后台关闭。所以刻意**不做**任何后台保活：

- 没有 `WorkManager`、没有前台服务、没有定时同步器；
- 本地 `8787` 服务与 App **同进程**，App 被杀 → 服务随之结束，**零后台残留、不耗电**；
- **冷启动缓存优先**：课表 JSON + 登录态落在 `filesDir`，重开先读缓存**即时渲染**（断网也能看上回课表），再按需刷新；
- 缓存超期且会话有效才静默拉一次；手动点「更新」强制拉；
- 登录态过期就提示重登或粘贴 Cookie。

### 零配置：cardId 私有注入

原网页版 `server.mjs` 里把课表卡片 `cardId` 写死，所以开箱即用；
为了脱敏公开，仓库里把它改成了空值 + 环境变量。APK 侧则**在打包时从 `local.properties` 私有注入**
（`BuildConfig.DEFAULT_CARD_ID`），所以：

- App 里**不需要手动填写 cardId**，和网页端体验一致；
- `local.properties`、`build/` 都被 `android/.gitignore` 忽略，**cardId/学号不会进仓库**。

### 构建步骤

前置：

- **JDK 17**（Temurin 或 Microsoft 均可）；
- **Android SDK**（命令行工具即可）：`platform-tools`、`platforms;android-34`、`build-tools;34.0.0`；
- **Gradle 8.10.2**（AGP 8.7.2 + Kotlin 2.0.20）；
- 工程路径**必须不含中文/非 ASCII 字符**（否则报 `Your project path contains non-ASCII characters`）。

`android/local.properties`（**不要提交**）：

```properties
sdk.dir=/path/to/Android/Sdk
gl.cardId=<你的课表卡片 cardId>
```

构建：

```bash
# 设置环境后（示例为 Windows 路径）
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/Android/Sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export GRADLE_USER_HOME=/path/to/gradle-home
gradle -p android assembleDebug --console=plain --no-daemon
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（约 1.4 MB）。
装上后用**学号 / 密码 / 验证码**登录一次，即自动同步并显示课表。

### 开发中踩过的坑（备忘）

- **Kotlin 块注释会嵌套**：注释里绝不能出现 `/*`（例如 KDoc 写 `/api/*` 会触发 `Unclosed comment` 编译失败）。
- **NanoHTTPD 读 JSON body**：非表单请求，要用 `session.parseBody(map)` 后从 `map["postData"]` 取原始 body
  （`Content-Length>0` 时才有值）。
- **登录成功 ≠ 同步成功**：最初「登录成功」后因缺 `cardId` 同步失败，被统一误报成「登录已失效」。
  已把「CAS 授权成功」与「同步失败」拆开：同步失败作为 `syncError` 返回，不再抹掉登录态。
- **RSA 必须复刻 jsbn 的小端字节对分块**（每块 126 字节、hex 补到 256 位、`e=65537`），与 `server.mjs` 完全一致，
  否则 CAS 密码加密对不上。
- **验证码是算式题**：要人眼算答案填进去（不是图形字符）。

---

## 登录态怎么维持

### ① 直接用学号密码登录（推荐，手机也能用）

点左上角**账号名** → 面板里填 **学号 / 密码 / 验证码（算式答案）** → **登录并同步**。

服务端把这几个字段按 CAS 的登录表单提交给 `ids.gzist.edu.cn`（协议逆向见 docs 第 11 节），
拿到门户 Cookie 后立刻同步一次课表并落盘，之后就不用再登录了。

> 密码只在这一次请求里透传给学校 CAS，不落盘、不写日志、不离开你的设备。

### ② 粘贴 Cookie（兜底通道）

门户登录态在 Cookie 里（部分 `HttpOnly`，浏览器 JS 读不到），所以由**服务端持有 Cookie**：

1. 首次（或登录失效后）：浏览器登录 <https://portal.gzist.edu.cn>，
   F12 → Network → 任选一个 `api/uppcard/...` 请求 → 右键 **Copy as cURL** → 保存为 `clip.txt`
2. 导入：

   ```bash
   node scripts/import-cookies.mjs clip.txt
   # 也支持直接粘贴：node scripts/import-cookies.mjs "SESSION=xxx; token=yyy"
   ```

3. 之后服务端每 `SYNC_MIN`（默认 15）分钟同步一次，每 `KEEPALIVE_MIN`（默认 5）分钟
   用 `CASTGC` 静默续期，只要 `CASTGC` 没过期就能长期免登录。

顶栏出现 **`登录失效 · 点此处理`** 时，点它会弹出上面这套步骤。

### 环境变量（网页版）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GL_CARD_ID` | 空 | 课表卡片实例 id（门户「学生课表」卡片 api/uppcard 请求里可见，必填） |
| `GL_PORT` | `8787` | 服务端口 |
| `SYNC_MIN` | `15` | 自动同步间隔（分钟） |
| `KEEPALIVE_MIN` | `5` | 会话保活间隔（分钟） |

> APK 版无需设置这些：`cardId` 打包时已注入，同步/保活策略改成了「纯前台、缓存优先」。

---

## 换账号 / Cookie 过期了怎么办

点左上角**账号名**，弹出「账号与登录态」面板：

| 截图 | 说明 |
| --- | --- |
| ![](shots/login-panel.png) | 面板：当前账号 + 学号密码验证码登录 + 粘贴 Cookie 兜底 |
| ![](shots/cookie-expired.png) | Cookie 过期：胶囊变红，但**课表照常显示** |
| ![](shots/logged-out.png) | 主动退出后：清空数据，等新账号导入 |

**Cookie 过期会发生什么**（重点：不会丢数据）

1. 服务端请求被弹回登录页 → 先自动用 `CASTGC` 静默续期，成功则你完全无感；
2. 续期失败 → 胶囊变红「登录失效 · 点此处理」，**已抓到的课表继续显示**（缓存可用），只是不再更新；
3. 后台每 15 分钟自动重试；也可以在面板里直接输学号密码重登，恢复后自动变绿。

**换账号**：面板里填新账号的学号 / 密码 / 验证码登录即可。登录是在一份**干净的 Cookie 罐**里做的——
成功才替换旧账号，失败则原样恢复旧登录态，不会把当前能用的账号弄掉。

面板里的按钮：

- **登录并同步**：走 CAS 登录（学号+密码+验证码）→ 立刻同步课表，成功后替换旧账号；
- **导入并同步**：粘贴 `Copy as cURL` 的兜底通道（先清旧账号 Cookie 与旧课表，避免串号）；
- **打开门户登录**：新窗口打开门户，方便手动登录后去拿 cURL；
- **退出 / 更换账号**：清空服务端 Cookie + 本地缓存 + 课表数据，回到「未登录」。

> 姓名来自「学号→姓名」记忆表（门户没有"当前用户"接口），登录过的账号会自动记住；
> 没记录过时显示「学号 · 某某班」，班级从课表的教学班名解析（详见 docs 第 10 节）。

---

## 接口一览（本地服务）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedule` | 课表数据 + 同步状态 |
| GET | `/api/status` | 仅状态：`status / lastSyncAt / lastError / needLogin / hasCookies` |
| POST | `/api/sync` | 立即同步（前端「更新」按钮） |
| GET | `/api/config` | （APK）读当前 cardId 配置：`{ok, cardId, hasCardId}` |
| POST | `/api/config` | （APK）写 cardId：`{cardId}` |
| GET | `/api/auth/captcha` | 取 CAS 登录验证码：`{uid, image}` |
| POST | `/api/auth/login` | 学号密码登录：`{username, password, code, uid}` |
| POST | `/api/auth/cookies` | 导入 Cookie |
| POST | `/api/auth/logout` | 退出 / 换账号（`{wipe:true}` 连课表数据一起清） |

门户上游接口（逆向所得）与字段说明见 **[docs/逆向说明.md](docs/逆向说明.md)**。

---

## 实现要点

- **一屏整周**：CSS Grid，列 = 节次列 + `repeat(7, 1fr)`，行 `minmax(0,1fr)`，容器 `100dvh` 撑满，
  横屏 844×390 / 667×375 / 568×320、竖屏 390×844 / 360×780 / 320×568 都能一屏显示、不滚动、无文字溢出。
- **字号跟着课块长**：课程块用容器查询（`container-type:size` + `cqh`），
  块矮就自动缩小字号、隐藏「第 x-y 节」，优先保住**时间**和**教室**。
- **精确到每一节**：作息时间用学校课表 App 的逐节时间表（`08:20–09:05`、`10:20–11:05`…），
  **左侧栏**每节显示「节号 + 上课时间 + 下课时间」，课程卡片里不再重复时间与节数（跟学校课表 App 一致）。
- **卡片只放三样**：课程名（可截断）/ 教师 / 教室（完整），长按或悬停可看完整信息。
  接口只给"第几节"，钟点由 `BELL` 表换算，改时间只需改这一处。
- **缓存优先 + 后台更新**：`localStorage` 缓存保证打开即有画面；随后拉 `/api/schedule`，
  `fetchedAt` 变了才重渲染，不闪屏；断网时降级为「离线 · 缓存」并照常显示。
- **数据可追溯**：每周保留合并后的 `blocks`（课程名 / 教室 / 教师 / 教学班 / 起止节次）。
- **周次参数是 `results`**：门户课表接口 `queryAWeekSchedule` 的周次参数不叫 week，
  而是 `results=<周次>`（留空＝当前周）；服务端一次性抓完 1…`weekcount` 周，
  前端换周只是切数组，因此**翻周零延迟、断网也能翻**。

---

## 开发记录（时间线）

1. **逆向门户**：定位「融合门户」课表接口 `api/uppcard`（`queryAllTerm` / `queryAWeekSchedule`），
   用本人 `Authorization` Cookie 打通，整学期 20 周一次抓全，产出 `fetch/fetch.mjs` 与 `docs/逆向说明.md`。
2. **网页版后端**：写零依赖 `server/server.mjs`——Cookie 罐、出站网关、CAS 登录（验证码 + RSA）、
   静默续期、`/api/*`、静态托管；前端做成单文件一屏课表。
3. **脱敏**：截图打马赛克（姓名/学号/通知栏），`data/` 加入 `.gitignore` 不提交，
   源码与文档里的真实 `cardId`/学号/姓名/班级全部替换为占位符与环境变量。
4. **上云**：`git init` → 提交「脱敏版」→ 推到 GitHub（`Irissa-23/gzist-schedule`）。
5. **APK 选型**：对比 nodejs-mobile / Kotlin 原生 / 前端直连三方案，选 **Kotlin 原生重写**，用 Gradle 出包。
6. **搭工具链**：机器原本无 Android SDK/Gradle，装 `cmdline-tools` + 接受许可 + `platform-tools/android-34/build-tools`，
   JDK17、Gradle 8.10.2；因**中文路径报错**把工程移到纯 ASCII 目录。
7. **空壳出包**：`NanoHTTPD` 起本地 `8787`、`WebView` 加载 `127.0.0.1:8787`、静态资源走 assets，先跑通壳。
8. **移植后端**：把 `server.mjs` 全部逻辑用 Kotlin 实现（CAS 登录、验证码算式、jsbn 一致的 RSA、
   Cookie 持久化到 `filesDir`、课表同步、静默续期），`/api/*` 全接上。
9. **联调修 bug**：解决 NanoHTTPD 读 body、RSA 分块、以及「登录成功但同步失败被误报登录失效」；
   加 `/api/config` + 卡片 ID 设置条。
10. **v1.2 零配置成功**：把 cardId 改为打包时私有注入，App 内账密登录一次即直接出课表；实测通过。

---

## 安全与脱敏

- `data/auth.json`（Cookie + 学生信息）与生成的 `web/data.json`、`web/data.js` 均被 `.gitignore` 忽略，**不进仓库**。
- `shots/` 截图中的姓名、学号、系统通知栏已马赛克处理。
- 源码/文档中的真实 `cardId`、学号、姓名、班级、教师、教室均替换为占位符（`张三`、`25XX17班`、`2025XXXXXXXX`、`<你的 cardId>` 等）。
- APK 的 `cardId` 通过 `local.properties` 私有注入，`local.properties`/`build/` 被忽略，**不会泄露到公开仓库**。

---

## 免责声明

- 数据来自本人账号登录后的个人课表接口，仅本地查看，`data/auth.json` 含登录凭据请勿外传。
- 请遵守学校相关规定，不要复用本项目抓取他人数据或对服务器造成压力。
