package app.tauri.mobilepush

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Scope for main-thread plugin work (the permission dialog). */
private val mainScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
    ]
)
class MobilePushPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    companion object {
        /**
         * The live plugin, so [FCMService] can reach it. The service runs in the
         * same process as the activity, so one reference is enough.
         */
        var instance: MobilePushPlugin? = null
    }

    override fun load(webView: WebView) {
        super.load(webView)
        instance = this
        // A cold start from a notification tap carries the payload on the
        // launch intent; `onNewIntent` covers every later tap.
        deliverTap(activity.intent)
    }

    /**
     * Bridges a platform event to the Rust side, which fans it out to the JS
     * listeners registered with `register_listener`. The symbol is
     * `Java_app_tauri_mobilepush_MobilePushPlugin_emitEvent` in `src/commands.rs`.
     */
    private external fun emitEvent(event: String, payload: String)

    @Command
    fun getToken(invoke: Invoke) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                invoke.reject("Failed to get the FCM token", task.exception)
                return@addOnCompleteListener
            }
            val result = JSObject()
            result.put("token", task.result)
            invoke.resolve(result)
        }
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        // Notification permission is runtime-granted from API 33; below that
        // there is nothing to ask for and the framework would reject the
        // unknown permission string.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            invoke.resolve(granted(true))
            return
        }
        // Launching the permission dialog is main-thread work.
        mainScope.launch {
            requestPermissionForAlias("notifications", invoke, "requestPermissionsCallback")
        }
    }

    @PermissionCallback
    fun requestPermissionsCallback(invoke: Invoke) {
        invoke.resolve(granted(getPermissionState("notifications") == PermissionState.GRANTED))
    }

    private fun granted(granted: Boolean): JSObject {
        val result = JSObject()
        result.put("granted", granted)
        return result
    }

    override fun onNewIntent(intent: Intent) {
        deliverTap(intent)
    }

    /**
     * Emits the FCM payload an intent was opened with.
     *
     * The FCM SDK copies the message's `data` keys onto the launch intent as
     * extras, so the payload is whatever the sender put there. The extras are
     * cleared afterwards, which is what keeps a re-delivered intent (a
     * configuration change, say) from emitting the same tap twice.
     */
    private fun deliverTap(intent: Intent?) {
        val extras: Bundle = intent?.extras ?: return
        val data = JSObject()
        for (key in extras.keySet()) {
            val value = extras.get(key)
            if (value is String) data.put(key, value)
        }
        intent.replaceExtras(Bundle())
        if (data.length() == 0) return

        val event = JSObject()
        event.put("data", data)
        emitEvent("notification-tapped", event.toString())
    }

    /**
     * A push arrived while the app was running. The event carries the same
     * shape as the one a browser receives: the visible text the sender put in
     * `notification`, and its `data` map.
     */
    fun handleMessage(message: RemoteMessage) {
        val data = JSObject()
        for ((key, value) in message.data) data.put(key, value)

        val event = JSObject()
        message.notification?.title?.let { event.put("title", it) }
        message.notification?.body?.let { event.put("body", it) }
        event.put("data", data)
        emitEvent("notification-received", event.toString())
    }

    /** FCM rotated the registration token; the appserver has to hear about it. */
    fun handleNewToken(token: String) {
        val payload = JSObject()
        payload.put("token", token)
        emitEvent("token-received", payload.toString())
    }
}
