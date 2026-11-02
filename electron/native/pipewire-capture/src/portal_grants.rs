//! A portal token is single-use and belongs to one source and cursor mode.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::portal::CursorMode;

#[derive(Clone)]
pub enum SelectionRequest {
    Reuse(PathBuf),
    Choose(PathBuf),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    cursor_mode: CursorMode,
    restore_token: String,
}

pub struct PendingGrant {
    path: PathBuf,
    receipt: Receipt,
}

fn unique_sibling(path: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_extension(format!("{}-{nonce}.pending", std::process::id()))
}

fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path.parent().unwrap_or(Path::new(".")))?.sync_all()
}

impl SelectionRequest {
    fn path(&self) -> &Path {
        match self {
            Self::Reuse(path) | Self::Choose(path) => path,
        }
    }

    /// Claim before contacting the portal. Even cancellation cannot replay a
    /// consumed token, and a failed cache write cannot leave an older source.
    pub fn claim(&self, mode: CursorMode) -> io::Result<Option<String>> {
        let claimed = unique_sibling(self.path());
        match fs::rename(self.path(), &claimed) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
        let contents = fs::metadata(&claimed).and_then(|metadata| {
            if metadata.len() > 65_536 {
                Ok(Vec::new())
            } else {
                fs::read(&claimed)
            }
        });
        fs::remove_file(claimed)?;
        sync_directory(self.path())?;
        if matches!(self, Self::Choose(_)) {
            return Ok(None);
        }
        let contents = contents?;
        let Ok(receipt) = serde_json::from_slice::<Receipt>(&contents) else {
            eprintln!("discarded invalid remembered screen-source metadata");
            return Ok(None);
        };
        Ok((receipt.version == 1
            && receipt.cursor_mode == mode
            && !receipt.restore_token.is_empty())
        .then_some(receipt.restore_token))
    }

    pub fn granted(self, mode: CursorMode, token: String) -> PendingGrant {
        PendingGrant {
            path: self.path().to_owned(),
            receipt: Receipt {
                version: 1,
                cursor_mode: mode,
                restore_token: token,
            },
        }
    }
}

impl PendingGrant {
    /// Called only after the source is accepted. Dropped candidates never save.
    pub fn commit(self) -> io::Result<()> {
        let temporary = unique_sibling(&self.path);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            serde_json::to_writer(&mut file, &self.receipt)?;
            file.flush()?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            sync_directory(&self.path)
        })();
        if result.is_err() && temporary.exists() {
            fs::remove_file(temporary)?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn token_is_single_use_rotates_and_is_private() {
        let path = unique_sibling(&std::env::temp_dir().join("klippt-grant"));
        let request = SelectionRequest::Reuse(path.clone());
        assert_eq!(request.claim(CursorMode::Embedded).unwrap(), None);
        request
            .clone()
            .granted(CursorMode::Embedded, "first".into())
            .commit()
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            request.claim(CursorMode::Embedded).unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(request.claim(CursorMode::Embedded).unwrap(), None);
        request
            .clone()
            .granted(CursorMode::Embedded, "second".into())
            .commit()
            .unwrap();
        assert_eq!(
            request.claim(CursorMode::Embedded).unwrap().as_deref(),
            Some("second")
        );
    }

    #[test]
    fn concurrent_helpers_cannot_replay_the_same_grant() {
        let path = unique_sibling(&std::env::temp_dir().join("klippt-concurrent-grant"));
        let request = SelectionRequest::Reuse(path);
        request
            .clone()
            .granted(CursorMode::Embedded, "single-use".into())
            .commit()
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let request = request.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    request.claim(CursorMode::Embedded).unwrap()
                })
            })
            .collect();
        let claimed = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(claimed, ["single-use"]);
    }

    #[test]
    fn explicit_choice_mode_changes_and_unadopted_candidates_cannot_reuse_old_sources() {
        let path = unique_sibling(&std::env::temp_dir().join("klippt-grant-choice"));
        let request = SelectionRequest::Reuse(path.clone());
        request
            .clone()
            .granted(CursorMode::Embedded, "monitor".into())
            .commit()
            .unwrap();
        assert_eq!(
            SelectionRequest::Choose(path.clone())
                .claim(CursorMode::Embedded)
                .unwrap(),
            None
        );
        drop(
            request
                .clone()
                .granted(CursorMode::Embedded, "cancelled-window".into()),
        );
        assert_eq!(request.claim(CursorMode::Embedded).unwrap(), None);
        request
            .clone()
            .granted(CursorMode::Embedded, "monitor".into())
            .commit()
            .unwrap();
        assert_eq!(request.claim(CursorMode::Metadata).unwrap(), None);
        fs::write(&path, b"invalid metadata").unwrap();
        assert_eq!(request.claim(CursorMode::Embedded).unwrap(), None);
    }
}
