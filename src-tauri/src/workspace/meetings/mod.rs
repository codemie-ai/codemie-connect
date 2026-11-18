//! Meetings: Teams transcripts found, saved into meeting folders and read back (spec
//! "Transcript states", "Folder and files"). The background round checks ended Teams meetings and
//! saves every transcript it finds; people check now, save again, import a file and name speakers
//! through `meeting_*` operations.
//!
//! A meeting record (kind [`model::KIND`]) is account-bound like its event: same id, the event's
//! `calendar:` source, no workspace. So the snapshot shows it only with calendar reads on, and
//! signing out removes it; its folder is the person's and stays.
//!
//! `model` holds the types and settings; `record` reads and stores the record; `round` is the
//! background look; `save` checks Teams and writes folders (`save_transcript` is shared with
//! the notes run); `ops` holds the person's operations and the reads; `folder`, `folder_files`,
//! `vtt` and `transcripts` are the pure parts.
pub(crate) mod folder;
mod folder_files;
pub mod model;
mod ops;
mod record;
mod round;
mod save;
#[cfg(test)]
mod tests;
pub(crate) mod transcripts;
pub(crate) mod vtt;

pub(crate) use round::meetings_round_at;
// The notes run (Task 3) saves an `available` meeting's transcript first through this.
#[allow(unused_imports)]
pub(crate) use save::save_transcript;

use self::model::{MeAlias, MeetingSettings};
use crate::workspace::{models::*, paths, Core};
use std::path::PathBuf;

impl Core {
    /// Who "me" is in transcripts. Task 3 reads the glossary's `## Me` section here; until then
    /// it is the account's display name with no aliases.
    pub(crate) fn me_alias(&self, c: &Connection) -> MeAlias {
        MeAlias {
            name: c.display_name.clone(),
            aliases: Vec::new(),
        }
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
