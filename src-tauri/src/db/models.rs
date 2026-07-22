use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
    pub color: String,
    pub icon: String,
    pub ado_org: Option<String>,
    pub ado_project: Option<String>,
    pub ado_repo_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProject {
    pub workspace_id: String,
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
    pub color: String,
    pub icon: String,
    pub ado_org: Option<String>,
    pub ado_project: Option<String>,
    pub ado_repo_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewContext {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub content: String,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkill {
    pub id: String,
    pub name: String,
    pub source_url: String,
    pub installed_at: String,
}
