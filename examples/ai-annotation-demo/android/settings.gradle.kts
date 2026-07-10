pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        google()
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        mavenCentral()   // ppocr-sdk 依赖 onnxruntime-android / opencv / coroutines / core-ktx 全在此
        maven { url = uri("https://repo.boox.com/repository/maven-public/") }
    }
}
rootProject.name = "InkLoop"
include(":app")
include(":ppocr-sdk")   // 徐 PaddleOCR SDK 源码模块（端侧印刷区域 OCR；com.paddle.ocr）
