//! Meetings: Teams transcripts found, saved into meeting folders and read back (spec
//! "Transcript states", "Folder and files"), and notes made from them (spec "Templates",
//! "Glossary and tags", "Tasks from notes"). The background round checks ended Teams meetings,
//! saves every transcript it finds and queues the notes rules ask for; people check now, save
//! again, import a file, name speakers and make notes through `meeting_*` operations.
//!
//! A meeting record (kind [`model::KIND`]) is account-bound like its event: same id, the event's
//! `calendar:` source, no workspace. So the snapshot shows it only with calendar reads on, and
//! signing out removes it; its folder is the person's and stays. Note templates and automatic
//! rules are local records of the active workspace.
//!
//! `model` holds the types and settings; `record` reads and stores the record; `round` is the
//! background look; `save` checks Teams and writes folders (`save_transcript` is shared with
//! the notes run); `ops` holds the person's transcript operations and the reads; `notes_job`
//! runs Claude for notes, `notes_ops` and `library_ops` hold the notes, template, rule and
//! glossary operations, `docs` the documents in a folder; `folder`, `folder_files`, `vtt`,
//! `transcripts`, `glossary`, `rules`, `templates` and `notes` are the pure parts.
mod docs;
pub(crate) mod folder;
mod folder_files;
pub(crate) mod glossary;
mod library_ops;
pub mod model;
mod notes;
mod notes_job;
mod notes_ops;
#[cfg(test)]
mod notes_tests;
mod ops;
mod record;
mod round;
pub(crate) mod rules;
mod save;
pub(crate) mod templates;
#[cfg(test)]
mod tests;
pub(crate) mod transcripts;
pub(crate) mod vtt;

pub(crate) use record::remember_removed_line;
pub(crate) use round::meetings_round_at;

use self::model::{MeAlias, MeetingSettings};
use crate::workspace::{models::*, paths, Core};
use std::path::PathBuf;

impl Core {
    /// Who "me" is in transcripts and tasks: the account's display name and e-mail, with the
    /// name and aliases of the glossary's `## Me` section when it has one. Reads the glossary
    /// file; takes no lock, so callers may hold the repository.
    pub(crate) fn me_alias(&self, c: &Connection, s: &MeetingSettings) -> MeAlias {
        let me = MeAlias::of(c);
        let Ok((root, _)) = self.meetings_root(s) else {
            return me;
        };
        let (path, _) = glossary::text_path(&root, s, glossary::Text::Glossary);
        let (text, _) = glossary::read_text(path.as_deref());
        if text.trim().is_empty() {
            return me;
        }
        glossary::me_with(me, &glossary::parse_glossary(&text))
    }

    /// The meetings root and whether it is the default one (which may be created).
    pub(crate) fn meetings_root(&self, s: &MeetingSettings) -> Result<(PathBuf, bool)> {
        match s.root.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            Some(root) => Ok((PathBuf::from(root), false)),
            None => self
                .home
                .as_deref()
                .map(|home| (paths::default_meetings_root(home), true))
                .ok_or_else(|| {
                    WorkspaceError::new(
                        "folder_unwritable",
                        "Connect can’t find your home folder. Choose the folder again in Settings › Meetings.",
                    )
                }),
        }
    }
}
