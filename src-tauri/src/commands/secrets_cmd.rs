use crate::secrets;

#[tauri::command]
pub fn set_ado_pat(org: String, pat: String) -> Result<(), String> {
    secrets::set_secret(&secrets::ado_pat_key(&org), &pat)
}

#[tauri::command]
pub fn get_ado_pat(org: String) -> Result<Option<String>, String> {
    secrets::get_secret(&secrets::ado_pat_key(&org))
}

#[tauri::command]
pub fn delete_ado_pat(org: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::ado_pat_key(&org))
}
