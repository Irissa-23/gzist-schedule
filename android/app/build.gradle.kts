import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 从 local.properties / 环境变量读取 cardId，作为 APK 的默认值（不硬编码进源码，避免泄露到仓库）
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val glCardId: String = localProps.getProperty("gl.cardId") ?: System.getenv("GL_CARD_ID") ?: ""

android {
    namespace = "com.irissa.gzist.schedule"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.irissa.gzist.schedule"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1"
        buildConfigField("String", "DEFAULT_CARD_ID", "\"$glCardId\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
