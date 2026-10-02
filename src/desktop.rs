use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<MobilePush<R>> {
    Ok(MobilePush(app.clone()))
}

/// Plugin handle on the desktop targets, where there is no push service to
/// register with. The commands report that rather than pretending to work.
pub struct MobilePush<R: Runtime>(AppHandle<R>);
