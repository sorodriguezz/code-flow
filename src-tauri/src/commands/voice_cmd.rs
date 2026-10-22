//! «¿Cuál le va a este equipo?» — what Settings › Voz y sonido shows beside every model that listens
//! and every voice: weight, speed here, accuracy, and which one each feature is recommended. See
//! `crate::voice_fit`.

use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::voice_fit::{self, Fit, Measured};

/// The machine, every listener's and voice's fit, and the picks. Reads the hardware (once a session)
/// on a blocking thread.
#[tauri::command]
pub async fn voice_fit(app: AppHandle) -> Result<Fit, String> {
    tokio::task::spawn_blocking(move || {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        Ok(voice_fit::fit(&conn))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// «Medir»: runs `id` here on a synthetic utterance (a listener) or sentence (a voice) and stores it.
#[tauri::command]
pub async fn voice_measure(app: AppHandle, id: String) -> Result<Measured, String> {
    let worker = app.clone();
    let measured = tokio::task::spawn_blocking(move || {
        let db = worker.state::<Db>();
        voice_fit::measure_and_store(&db, &id).map(|measured| (measured, id))
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(voice_fit::EVENT, &measured.1);
    Ok(measured.0)
}
