//! Who answers to whom inside a team.
//!
//! A team used to be flat: one lead and everyone else. Now every member has a manager
//! (`reports_to`, the lead when empty), a member who `leads` is a sub-lead that plans and delegates
//! inside its own branch, and `talks_to` / the policy's `comms` say who may message whom. All of it
//! is optional and defaults to the old behaviour: a team saved before this has every member
//! reporting to the lead, nobody leading but the lead, and open communication.
//!
//! Pure functions over the member list, so the rules are tested without a run.

use std::collections::{HashMap, HashSet};

use super::Member;

/// Lead → sub-lead → sub-sub-lead → member. Deeper trees are refused: past this, a question takes
/// more turns climbing than it saves.
pub const MAX_DEPTH: usize = 3;

/// The member a member answers to, `None` for the lead (who answers to the user) and for a team
/// with no lead (a fixed plan, where everyone answers to the user).
pub fn manager<'a>(members: &'a [Member], lead: &str, id: &str) -> Option<&'a str> {
    if id == lead || lead.is_empty() {
        return None;
    }
    let member = members.iter().find(|m| m.id == id)?;
    let boss = member.reports_to.as_str();
    if !boss.is_empty() && boss != id && members.iter().any(|m| m.id == boss) {
        Some(boss)
    } else {
        members.iter().find(|m| m.id == lead).map(|m| m.id.as_str())
    }
}

/// Everyone under `id`, at any depth, in breadth-first order — never `id` itself.
pub fn subtree(members: &[Member], lead: &str, id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut frontier = vec![id.to_string()];
    while let Some(current) = frontier.pop() {
        for m in members {
            if m.id != current && manager(members, lead, &m.id) == Some(current.as_str()) && !out.contains(&m.id) && m.id != id {
                out.push(m.id.clone());
                frontier.push(m.id.clone());
            }
        }
    }
    out
}

/// The managers above `id`, nearest first, ending at the lead.
pub fn chain_up(members: &[Member], lead: &str, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = id.to_string();
    while let Some(boss) = manager(members, lead, &current) {
        if out.iter().any(|b: &String| b == boss) || boss == id {
            break;
        }
        out.push(boss.to_string());
        current = boss.to_string();
    }
    out
}

/// How deep a member sits: the lead is 0.
pub fn depth(members: &[Member], lead: &str, id: &str) -> usize {
    chain_up(members, lead, id).len()
}

/// Whether a member plans for others: the lead, or a member marked as a sub-lead that has someone
/// under it.
pub fn is_planner(members: &[Member], lead: &str, id: &str) -> bool {
    if id == lead {
        return true;
    }
    members.iter().any(|m| m.id == id && m.leads) && !subtree(members, lead, id).is_empty()
}

/// Cleans a team's hierarchy before it is saved. Dangling and self `reports_to` are cleared, the
/// lead reports to nobody, `talks_to` only names members, and an advisor never leads. A cycle or a
/// tree deeper than [`MAX_DEPTH`] is refused, naming the members, because both would make a
/// question climb forever or a plan nobody reads.
pub fn normalize(members: &mut [Member], lead: &str) -> Result<(), String> {
    let ids: HashSet<String> = members.iter().map(|m| m.id.clone()).collect();
    for m in members.iter_mut() {
        if m.id == lead || !ids.contains(&m.reports_to) || m.reports_to == m.id {
            m.reports_to.clear();
        }
        m.talks_to.retain(|t| ids.contains(t) && *t != m.id);
        if m.advisor {
            m.leads = false;
        }
    }
    // Cycles: follow `reports_to` raw (not through `manager`, which falls back to the lead).
    let boss: HashMap<&str, &str> = members.iter().filter(|m| !m.reports_to.is_empty()).map(|m| (m.id.as_str(), m.reports_to.as_str())).collect();
    for m in members.iter() {
        let mut seen: Vec<&str> = vec![m.id.as_str()];
        let mut current = m.id.as_str();
        while let Some(next) = boss.get(current) {
            if seen.contains(next) {
                let names: Vec<String> = seen.iter().filter_map(|id| members.iter().find(|x| x.id == *id)).map(|x| if x.name.is_empty() { x.id.clone() } else { x.name.clone() }).collect();
                return Err(format!("La jerarquía tiene un ciclo: {}.", names.join(" → ")));
            }
            seen.push(next);
            current = next;
        }
    }
    if !lead.is_empty() {
        for m in members.iter() {
            if depth(members, lead, &m.id) > MAX_DEPTH {
                let name = if m.name.is_empty() { m.id.clone() } else { m.name.clone() };
                return Err(format!("«{name}» queda a más de {MAX_DEPTH} niveles del líder."));
            }
        }
    }
    Ok(())
}

/// `open` (anyone), `tree` (one's manager and direct reports) or `tree_siblings` (also those with
/// the same manager). A member's `talks_to` adds explicit exceptions; the user, the lead and `all`
/// stay reachable whatever the mode, so nobody can be cut off from asking.
pub fn may_message(members: &[Member], lead: &str, comms: &str, from: &str, to: &str) -> bool {
    if comms == "open" || comms.is_empty() || to == "user" || to == "all" || to == "lead" || to == lead || from == to {
        return true;
    }
    if members.iter().any(|m| m.id == from && m.talks_to.iter().any(|t| t == to)) {
        return true;
    }
    let from_boss = manager(members, lead, from);
    let to_boss = manager(members, lead, to);
    if from_boss == Some(to) || to_boss == Some(from) {
        return true;
    }
    comms == "tree_siblings" && from_boss.is_some() && from_boss == to_boss
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, reports_to: &str, leads: bool) -> Member {
        Member { id: id.into(), name: id.into(), reports_to: reports_to.into(), leads, agent_id: id.into(), ..Default::default() }
    }

    fn tree() -> Vec<Member> {
        // L → A, S(sub-lead) ; S → B, C ; C → D
        vec![m("L", "", false), m("A", "L", false), m("S", "L", true), m("B", "S", false), m("C", "S", true), m("D", "C", false)]
    }

    #[test]
    fn managers_subtrees_and_depth() {
        let t = tree();
        assert_eq!(manager(&t, "L", "B"), Some("S"));
        assert_eq!(manager(&t, "L", "L"), None);
        let mut sub = subtree(&t, "L", "S");
        sub.sort();
        assert_eq!(sub, vec!["B", "C", "D"]);
        assert_eq!(chain_up(&t, "L", "D"), vec!["C", "S", "L"]);
        assert_eq!(depth(&t, "L", "D"), 3);
        assert!(is_planner(&t, "L", "S"));
        assert!(!is_planner(&t, "L", "B"));
    }

    #[test]
    fn old_flat_teams_report_to_the_lead() {
        let t = vec![m("L", "", false), m("A", "", false), m("B", "", false)];
        assert_eq!(manager(&t, "L", "A"), Some("L"));
        assert_eq!(subtree(&t, "L", "L").len(), 2);
        assert!(may_message(&t, "L", "", "A", "B"));
    }

    #[test]
    fn normalize_clears_dangling_and_refuses_cycles_and_depth() {
        let mut t = vec![m("L", "X", false), m("A", "A", false), m("B", "ghost", false)];
        normalize(&mut t, "L").unwrap();
        assert!(t.iter().all(|x| x.reports_to.is_empty()));

        let mut cycle = vec![m("L", "", false), m("A", "B", false), m("B", "A", false)];
        assert!(normalize(&mut cycle, "L").unwrap_err().contains("ciclo"));

        let mut deep = vec![m("L", "", false), m("A", "L", true), m("B", "A", true), m("C", "B", true), m("D", "C", false)];
        assert!(normalize(&mut deep, "L").unwrap_err().contains("niveles"));
    }

    #[test]
    fn comms_modes() {
        let t = tree();
        // tree: B ↔ S (manager), S ↔ L; B ↛ A
        assert!(may_message(&t, "L", "tree", "B", "S"));
        assert!(may_message(&t, "L", "tree", "S", "B"));
        assert!(!may_message(&t, "L", "tree", "B", "A"));
        assert!(!may_message(&t, "L", "tree", "B", "C"));
        // siblings: B ↔ C share S
        assert!(may_message(&t, "L", "tree_siblings", "B", "C"));
        // the lead, the user and everyone stay reachable
        assert!(may_message(&t, "L", "tree", "D", "L"));
        assert!(may_message(&t, "L", "tree", "D", "user"));
        // an explicit exception
        let mut t2 = t.clone();
        t2[3].talks_to = vec!["A".into()];
        assert!(may_message(&t2, "L", "tree", "B", "A"));
    }
}
