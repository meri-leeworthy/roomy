# Add project specific ProGuard rules here.
# By default, the flags in this file are applied to your project only.
# You can also apply them to modules and dependencies by using the consumer PostGuard
# files rule.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# The plugin class is reached by name in two ways that minification cannot
# see: its `emitEvent` native method resolves through JNI as
# `Java_app_tauri_mobilepush_MobilePushPlugin_emitEvent`, and Tauri's
# `PluginHandle` indexes the `@Command` methods by their Java name and
# dispatches with `Method.invoke`. Renaming either breaks command dispatch
# and event delivery in a release build only.
-keep class app.tauri.mobilepush.MobilePushPlugin { *; }

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you are using reflection, uncomment the following and list the class
# names of objects probed via reflection.
#-keep class com.your.package.YourClass
