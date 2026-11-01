//! What Huginn and Muninn agree on: who the user is, how one app points at a
//! record in the other, and what a health check says. Both servers and
//! (through serde JSON) both web clients speak these shapes.

use serde::{Deserialize, Serialize};

/// The two ravens. Serialized lowercase, which is also each app's URL base
/// (`/huginn`, `/muninn`) and its compose service name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RavenApp {
    Huginn,
    Muninn,
}

impl RavenApp {
    pub fn name(self) -> &'static str {
        match self {
            RavenApp::Huginn => "huginn",
            RavenApp::Muninn => "muninn",
        }
    }

    /// The path both apps are served under on the shared origin.
    pub fn base(self) -> &'static str {
        match self {
            RavenApp::Huginn => "/huginn",
            RavenApp::Muninn => "/muninn",
        }
    }
}

impl std::fmt::Display for RavenApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// The signed-in person, as the Tailscale identity headers describe them.
/// `login` is the stable key everything is owned by (an email-shaped string
/// such as `turbine.bmw@gmail.com`); `name` is for display only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A pointer from a record in one app to a record in the other: a Muninn
/// reminder remembers the Huginn note (and block) it was made from, and
/// Huginn asks Muninn which reminders point at a note. `fragment` narrows the
/// target inside the record (a checklist item, a paragraph, a stroke group).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkTarget {
    pub app: RavenApp,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
}

impl LinkTarget {
    /// The deep link that opens the target in its app, relative to the shared
    /// origin: `/huginn/n/<id>#<fragment>` or `/muninn/t/<id>`.
    pub fn href(&self) -> String {
        let kind = match self.app {
            RavenApp::Huginn => "n",
            RavenApp::Muninn => "t",
        };
        let mut s = format!("{}/{}/{}", self.app.base(), kind, self.id);
        if let Some(fragment) = &self.fragment {
            s.push('#');
            s.push_str(fragment);
        }
        s
    }
}

/// `GET /v1/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub app: RavenApp,
    pub version: String,
    /// SQLite `user_version` after migrations.
    pub schema: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_open_in_their_app() {
        let link = LinkTarget {
            app: RavenApp::Huginn,
            id: "abc".into(),
            fragment: Some("item-3".into()),
        };
        assert_eq!(link.href(), "/huginn/n/abc#item-3");
        let link = LinkTarget {
            app: RavenApp::Muninn,
            id: "xyz".into(),
            fragment: None,
        };
        assert_eq!(link.href(), "/muninn/t/xyz");
    }

    #[test]
    fn apps_serialize_as_their_base_name() {
        assert_eq!(
            serde_json::to_string(&RavenApp::Muninn).unwrap(),
            "\"muninn\""
        );
    }
}
