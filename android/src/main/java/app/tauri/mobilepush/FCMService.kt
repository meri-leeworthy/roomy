package app.tauri.mobilepush

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives FCM messages and token rotations and hands them to the plugin,
 * which bridges them to the webview.
 *
 * The plugin instance is absent when the process was started for the push
 * alone (the app was swiped away): there is no webview to deliver to, and the
 * message is dropped rather than shown, which is the behavior FCM documents
 * for a data-only push.
 */
class FCMService : FirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        MobilePushPlugin.instance?.handleMessage(remoteMessage)
    }

    override fun onNewToken(token: String) {
        MobilePushPlugin.instance?.handleNewToken(token)
    }
}
