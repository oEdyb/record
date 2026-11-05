//! Remove only a provably incomplete final fragment from a failed writer's own file.
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn retain_complete_fragments(path: &Path) -> std::io::Result<()> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let length = file.metadata()?.len();
    let mut offset = 0u64;
    let mut pending_fragment = None;
    let mut last_complete_fragment = None;
    while offset < length {
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0u8; 8];
        if length - offset < 8 {
            if let Some(start) = pending_fragment.or(last_complete_fragment) {
                file.set_len(start)?;
                file.sync_all()?;
            }
            break;
        }
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let kind = &header[4..];
        if kind == b"moof" {
            pending_fragment = Some(offset);
        }
        let header_size = if size == 1 {
            let mut large = [0u8; 8];
            if length - offset < 16 {
                if let Some(start) = pending_fragment {
                    file.set_len(start)?;
                    file.sync_all()?;
                }
                return Ok(());
            }
            file.read_exact(&mut large)?;
            size = u64::from_be_bytes(large);
            16
        } else {
            8
        };
        // An EOF-sized box or malformed header is not proof of a cut fragment.
        if size == 0 || size < header_size {
            return Ok(());
        }
        if kind == b"moof" {
            pending_fragment = Some(offset);
        }
        if size > length - offset {
            if let Some(start) = pending_fragment {
                file.set_len(start)?;
                file.sync_all()?;
            }
            break;
        }
        if kind == b"mdat" && pending_fragment.is_some() {
            last_complete_fragment = Some(offset + size);
            pending_fragment = None;
        }
        offset += size;
    }
    if let Some(start) = pending_fragment {
        file.set_len(start)?;
        file.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    fn check(bytes: &[u8], expected: &[u8]) {
        let path = std::env::temp_dir().join(format!(
            "mp4-tail-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).unwrap();
        retain_complete_fragments(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        std::fs::remove_file(path).unwrap();
    }
    const COMPLETE: &[u8] = b"\0\0\0\x08ftyp\0\0\0\x08moov\0\0\0\x08moof\0\0\0\x0cmdatgood";
    #[test]
    fn leaves_complete_recordings_unchanged() {
        check(COMPLETE, COMPLETE);
    }
    #[test]
    fn removes_only_the_last_fragment_when_its_media_is_incomplete() {
        let mut bytes = COMPLETE.to_vec();
        bytes.extend_from_slice(b"\0\0\0\x08moof\0\0\0\x20mdatcut");
        check(&bytes, COMPLETE);
    }
    #[test]
    fn retains_the_prefix_at_every_interrupted_fragment_header_boundary() {
        let next = b"\0\0\0\x08moof\0\0\0\x0cmdatmore";
        for length in 1..next.len() {
            let mut bytes = COMPLETE.to_vec();
            bytes.extend_from_slice(&next[..length]);
            check(&bytes, COMPLETE);
        }
    }
    #[test]
    fn does_not_guess_at_unknown_or_eof_sized_boxes() {
        let mut bytes = COMPLETE.to_vec();
        bytes.extend_from_slice(b"\0\0\0\0mdatcut");
        check(&bytes, &bytes);
    }
}
