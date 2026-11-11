use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{models::{AgentDraft, WorkspaceAgent}, queries, Db};
use crate::team::{self, Team};

const INVALID_CONFIGURATION: &str = "La configuración de agentes o equipos no es válida.";
const INVALID_REPOSITORY: &str = "Vincula los repositorios al workspace de destino antes de importar.";
const REPOSITORY_EXISTS_SQL: &str = "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND workspace_id = ?2)";
const ROSTER_EVENT: &str = "crew:roster";
const TEAM_IMPORTED_EVENT: &str = "crew:team-imported";
const ALL_REPOSITORIES: &str = "*";
const COPY_SUFFIX_START: usize = 2;
const COPY_SUFFIX_INCREMENT: usize = 1;
const COPY_NAME_PREFIX: &str = " (";
const COPY_NAME_SUFFIX: &str = ")";
const WORKSPACE_ID_FIELD: &str = "workspaceId";

fn unique_name(name: &str, taken: &mut HashSet<String>) -> String {
    let original = name.trim();
    let mut candidate = original.to_string();
    let mut suffix = COPY_SUFFIX_START;
    loop {
        let normalized = candidate.to_lowercase();
        let available = taken.insert(normalized);
        if available {
            return candidate;
        }
        let suffix_text = suffix.to_string();
        candidate = [original, COPY_NAME_PREFIX, &suffix_text, COPY_NAME_SUFFIX].concat();
        suffix += COPY_SUFFIX_INCREMENT;
    }
}

#[derive(Deserialize)]
pub struct SharedAgentImport {
    key: String,
    draft: AgentDraft,
}

#[derive(Serialize)]
pub struct ImportedConfiguration {
    agents: Vec<WorkspaceAgent>,
    team: Option<Team>,
}

fn validate_repositories(conn: &Connection, workspace_id: &str, repositories: &[String]) -> Result<(), String> {
    for repository in repositories {
        let exists: bool = conn.query_row(REPOSITORY_EXISTS_SQL, params![repository, workspace_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !exists {
            return Err(INVALID_REPOSITORY.into());
        }
    }
    Ok(())
}

fn import_configuration(conn: &Connection, workspace_id: &str, agents: Vec<SharedAgentImport>, team: Option<Team>) -> Result<ImportedConfiguration, String> {
    let workspace_blank = workspace_id.trim().is_empty();
    let agents_empty = agents.is_empty();
    let team_absent = team.is_none();
    if workspace_blank || (agents_empty && team_absent) {
        return Err(INVALID_CONFIGURATION.into());
    }
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let existing_agents = queries::list_workspace_agents(&transaction, workspace_id).map_err(|error| error.to_string())?;
    let mut taken_agent_names: HashSet<String> = existing_agents.iter().map(|agent| agent.name.to_lowercase()).collect();
    let mut keys = HashSet::new();
    let mut agent_ids = HashMap::new();
    let mut saved_agents = Vec::new();
    for entry in agents {
        let key_blank = entry.key.trim().is_empty();
        let name_blank = entry.draft.name.trim().is_empty();
        let unique = keys.insert(entry.key.clone());
        if key_blank || name_blank || !unique {
            return Err(INVALID_CONFIGURATION.into());
        }
        let mut draft = entry.draft;
        draft.id = None;
        draft.workspace_id = workspace_id.into();
        draft.account_id = None;
        draft.template_id.clear();
        draft.template_version = i64::default();
        draft.overrides.clear();
        draft.name = unique_name(&draft.name, &mut taken_agent_names);
        validate_repositories(&transaction, workspace_id, &draft.repos)?;
        let saved = queries::save_workspace_agent(&transaction, &draft).map_err(|error| error.to_string())?;
        agent_ids.insert(entry.key, saved.id.clone());
        saved_agents.push(saved);
    }
    let saved_team = match team {
        None => None,
        Some(mut incoming) => {
            incoming.id.clear();
            incoming.created_at.clear();
            incoming.updated_at.clear();
            incoming.workspace_id = workspace_id.into();
            let existing_teams = team::list_teams(&transaction, workspace_id).map_err(|error| error.to_string())?;
            let mut taken_team_names: HashSet<String> = existing_teams.iter().map(|team| team.name.to_lowercase()).collect();
            incoming.name = unique_name(&incoming.name, &mut taken_team_names);
            let mut member_ids = HashMap::new();
            for member in &incoming.members {
                let new_id = Uuid::new_v4().to_string();
                let previous = member_ids.insert(member.id.clone(), new_id);
                let duplicate = previous.is_some();
                if duplicate {
                    return Err(INVALID_CONFIGURATION.into());
                }
            }
            let map_member = |id: &str| member_ids.get(id).cloned().unwrap_or_else(|| id.into());
            incoming.lead = map_member(&incoming.lead);
            for member in &mut incoming.members {
                let saved_id = agent_ids.get(&member.agent_id).ok_or(INVALID_CONFIGURATION)?;
                member.agent_id = saved_id.clone();
                member.id = map_member(&member.id);
                member.reports_to = map_member(&member.reports_to);
                member.escalate_to = map_member(&member.escalate_to);
                member.talks_to = member.talks_to.iter().map(|id| map_member(id)).collect();
                validate_repositories(&transaction, workspace_id, &member.repos)?;
            }
            for step in &mut incoming.plan {
                step.member = map_member(&step.member);
                let first_repository = step.repo.is_empty();
                if !first_repository && step.repo != ALL_REPOSITORIES {
                    let repositories = vec![step.repo.clone()];
                    validate_repositories(&transaction, workspace_id, &repositories)?;
                }
            }
            for check in &incoming.policy.checks {
                if check.repo != ALL_REPOSITORIES {
                    let repositories = vec![check.repo.clone()];
                    validate_repositories(&transaction, workspace_id, &repositories)?;
                }
            }
            incoming.policy.conflicts = map_member(&incoming.policy.conflicts);
            incoming.policy.review.reviewer = map_member(&incoming.policy.review.reviewer);
            incoming.policy.review.of = incoming.policy.review.of.iter().map(|id| map_member(id)).collect();
            let saved = team::save_team(&transaction, incoming)?;
            Some(saved)
        }
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ImportedConfiguration { agents: saved_agents, team: saved_team })
}

#[tauri::command]
pub fn crew_import_configuration(app: AppHandle, db: State<Db>, workspace_id: String, agents: Vec<SharedAgentImport>, team: Option<Team>) -> Result<ImportedConfiguration, String> {
    let imported = {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        import_configuration(&conn, &workspace_id, agents, team)?
    };
    let roster_payload = HashMap::from([(WORKSPACE_ID_FIELD, workspace_id.as_str())]);
    let _ = app.emit(ROSTER_EVENT, roster_payload);
    if let Some(team) = &imported.team {
        let _ = app.emit(TEAM_IMPORTED_EVENT, team);
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE_NAME: &str = "Destination";
    const AGENT_NAME: &str = "Shared agent";
    const TEAM_NAME: &str = "Shared team";
    const AGENT_KEY: &str = "shared-agent";
    const MEMBER_KEY: &str = "shared-member";
    const SECOND_MEMBER_KEY: &str = "second-member";
    const PRIVATE_ACCOUNT: &str = "private-account";
    const MISSING_REPOSITORY: &str = "missing-repository";
    const TEST_FAILURE: &str = "configuration test setup failed";
    const EMPTY_TEXT: &str = "";
    const EXPECTED_AGENT_COUNT: usize = 1;
    const NEXT_AGENT_NAME: &str = "Shared agent (2)";

    fn database() -> (Connection, String) {
        let conn = Connection::open_in_memory().expect(TEST_FAILURE);
        crate::db::migrate(&conn, None).expect(TEST_FAILURE);
        let workspace = queries::create_workspace(&conn, WORKSPACE_NAME, EMPTY_TEXT, EMPTY_TEXT).expect(TEST_FAILURE);
        (conn, workspace.id)
    }

    fn shared_agent() -> SharedAgentImport {
        SharedAgentImport {
            key: AGENT_KEY.into(),
            draft: AgentDraft {
                name: AGENT_NAME.into(),
                account_id: Some(PRIVATE_ACCOUNT.into()),
                ..Default::default()
            },
        }
    }

    fn shared_team() -> Team {
        let lead = team::Member { id: MEMBER_KEY.into(), agent_id: AGENT_KEY.into(), name: AGENT_NAME.into(), ..Default::default() };
        let developer = team::Member { id: SECOND_MEMBER_KEY.into(), agent_id: AGENT_KEY.into(), name: AGENT_NAME.into(), reports_to: MEMBER_KEY.into(), talks_to: vec![MEMBER_KEY.into()], ..Default::default() };
        Team { name: TEAM_NAME.into(), lead: MEMBER_KEY.into(), members: vec![lead, developer], ..Default::default() }
    }

    #[test]
    fn creates_independent_agents_without_private_accounts_or_overwrites() {
        let (conn, workspace_id) = database();
        let original_draft = shared_agent().draft;
        let original = queries::save_workspace_agent(&conn, &AgentDraft { workspace_id: workspace_id.clone(), ..original_draft }).expect(TEST_FAILURE);
        let mut incoming = shared_agent();
        incoming.draft.id = Some(original.id.clone());
        let result = import_configuration(&conn, &workspace_id, vec![incoming], None).expect(TEST_FAILURE);
        let imported = &result.agents[usize::default()];
        assert_ne!(imported.id, original.id);
        assert_eq!(imported.account_id, None);
        assert_eq!(imported.name, NEXT_AGENT_NAME);
        let stored = queries::list_workspace_agents(&conn, &workspace_id).expect(TEST_FAILURE);
        let preserved = stored.iter().find(|agent| agent.id == original.id).expect(TEST_FAILURE);
        assert_eq!(preserved.account_id, original.account_id);
    }

    #[test]
    fn remaps_shared_agents_and_member_relationships() {
        let (conn, workspace_id) = database();
        let incoming_team = shared_team();
        let incoming_agent = shared_agent();
        let result = import_configuration(&conn, &workspace_id, vec![incoming_agent], Some(incoming_team)).expect(TEST_FAILURE);
        let saved_team = result.team.expect(TEST_FAILURE);
        assert_eq!(result.agents.len(), EXPECTED_AGENT_COUNT);
        let lead = &saved_team.members[usize::default()];
        let developer = saved_team.members.last().expect(TEST_FAILURE);
        let agent = &result.agents[usize::default()];
        assert_ne!(lead.id, MEMBER_KEY);
        assert_eq!(lead.agent_id, agent.id);
        assert_eq!(developer.agent_id, agent.id);
        assert_eq!(saved_team.lead, lead.id);
        assert_eq!(developer.reports_to, lead.id);
        assert_eq!(developer.talks_to, vec![lead.id.clone()]);
    }

    #[test]
    fn rolls_back_agents_when_the_team_cannot_be_saved() {
        let (conn, workspace_id) = database();
        let before = queries::list_workspace_agents(&conn, &workspace_id).expect(TEST_FAILURE);
        let mut incoming_team = shared_team();
        incoming_team.name.clear();
        let incoming_agent = shared_agent();
        let result = import_configuration(&conn, &workspace_id, vec![incoming_agent], Some(incoming_team));
        let failed = result.is_err();
        assert!(failed);
        let after = queries::list_workspace_agents(&conn, &workspace_id).expect(TEST_FAILURE);
        assert_eq!(after.len(), before.len());
    }

    #[test]
    fn rolls_back_earlier_agents_when_a_later_repository_is_invalid() {
        let (conn, workspace_id) = database();
        let before = queries::list_workspace_agents(&conn, &workspace_id).expect(TEST_FAILURE);
        let first = shared_agent();
        let mut second = shared_agent();
        second.key = SECOND_MEMBER_KEY.into();
        second.draft.repos = vec![MISSING_REPOSITORY.into()];
        let result = import_configuration(&conn, &workspace_id, vec![first, second], None);
        let failed = result.is_err();
        assert!(failed);
        let after = queries::list_workspace_agents(&conn, &workspace_id).expect(TEST_FAILURE);
        assert_eq!(after.len(), before.len());
    }
}
