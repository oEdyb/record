//! klippt-parakeet-stt (Linux): Parakeet TDT v3 through sherpa-onnx.
//!
//! Protocol, shared with the macOS helper (see electron/transcript/parakeetProcess.ts):
//!   argv:   --models <dir with encoder/decoder/joiner .int8.onnx and tokens.txt>
//!   stdout: {"type":"ready"} once the model is loaded
//!   stdin:  one JSON request per line: {"id","audioPath","language"?}
//!   stdout: {"type":"result","id","segments":[{"text"}],"wordSegments":[{word,startSec,endSec,confidence}]}
//!           or {"type":"error","id","error"}
//! Forced alignment ("type":"align") is Core ML only; the app skips it when its model is absent.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, Wave};

const SR: usize = 16_000;
/// Parakeet's attention cost grows with input length, so long audio is decoded in pieces.
const PIECE_MIN: usize = SR * 20;
const PIECE_MAX: usize = SR * 28;
/// Energy frame used to find the quietest moment to cut at: 100 ms, 10 ms hop.
const FRAME: usize = SR / 10;
const HOP: usize = SR / 100;
/// A word whose last token has no duration ends at the next token, but never later than this.
const MAX_TAIL_SEC: f32 = 0.5;

struct Word {
    text: String,
    start: f32,
    end: f32,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let models = match args
        .iter()
        .position(|a| a == "--models")
        .and_then(|i| args.get(i + 1))
    {
        Some(dir) => PathBuf::from(dir),
        None => fail("usage: klippt-parakeet-stt --models <dir>"),
    };
    let recognizer = load(&models).unwrap_or_else(|e| fail(&e));

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    emit(&mut out, &json!({ "type": "ready" }));

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(
                    &mut out,
                    &json!({ "type": "error", "error": format!("bad request: {e}") }),
                );
                continue;
            }
        };
        let id = request["id"].as_str().unwrap_or_default().to_string();
        let reply = if request["type"].as_str() == Some("align") {
            Err("Forced alignment is not available on Linux.".to_string())
        } else {
            match request["audioPath"].as_str() {
                Some(path) => transcribe(&recognizer, path),
                None => Err("request has no audioPath".to_string()),
            }
        };
        let message = match reply {
            Ok(words) => {
                let text = join_text(&words);
                json!({
                    "type": "result",
                    "id": id,
                    "segments": [{ "text": text }],
                    "wordSegments": words.iter().map(|w| json!({
                        "word": w.text,
                        "startSec": w.start,
                        "endSec": w.end,
                        // sherpa-onnx reports no per-token probability; Clean cut does not read it.
                        "confidence": 1.0,
                    })).collect::<Vec<_>>(),
                    "detectedLanguage": request["language"].as_str().unwrap_or("en"),
                })
            }
            Err(error) => json!({ "type": "error", "id": id, "error": error }),
        };
        emit(&mut out, &message);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("klippt-parakeet-stt: {message}");
    std::process::exit(1);
}

fn emit(out: &mut impl Write, message: &Value) {
    // One line per message, flushed, so the reader never sees half a reply.
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn load(dir: &Path) -> Result<OfflineRecognizer, String> {
    let file = |name: &str| {
        let path = dir.join(name);
        if path.is_file() {
            Ok(path.to_string_lossy().into_owned())
        } else {
            Err(format!("model file missing: {}", path.display()))
        }
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(file("encoder.int8.onnx")?),
        decoder: Some(file("decoder.int8.onnx")?),
        joiner: Some(file("joiner.int8.onnx")?),
    };
    config.model_config.tokens = Some(file("tokens.txt")?);
    config.model_config.model_type = Some("nemo_transducer".to_string());
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.num_threads = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(1, 8) as i32)
        .unwrap_or(4);
    OfflineRecognizer::create(&config)
        .ok_or_else(|| "sherpa-onnx could not load the model".to_string())
}

fn transcribe(recognizer: &OfflineRecognizer, path: &str) -> Result<Vec<Word>, String> {
    let wave = Wave::read(path).ok_or_else(|| format!("could not read WAV: {path}"))?;
    if wave.sample_rate() != SR as i32 {
        return Err(format!(
            "expected 16 kHz audio, got {} Hz",
            wave.sample_rate()
        ));
    }
    let samples = wave.samples();
    let mut words = Vec::new();
    for (start, end) in pieces(samples) {
        let stream = recognizer.create_stream();
        stream.accept_waveform(SR as i32, &samples[start..end]);
        recognizer.decode(&stream);
        let Some(result) = stream.get_result() else {
            continue;
        };
        let offset = start as f32 / SR as f32;
        let piece_end = (end - start) as f32 / SR as f32;
        words.extend(
            group_words(
                &result.tokens,
                result.timestamps.as_deref(),
                result.durations.as_deref(),
                piece_end,
            )
            .into_iter()
            .map(|w| Word {
                start: w.start + offset,
                end: w.end + offset,
                ..w
            }),
        );
    }
    Ok(words)
}

/// Splits long audio at the quietest 100 ms between 20 and 28 seconds into each piece,
/// so a cut lands in a pause rather than through a word.
fn pieces(samples: &[f32]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    while samples.len() - start > PIECE_MAX {
        let mut best = (f32::MAX, start + PIECE_MIN);
        let mut at = start + PIECE_MIN;
        while at + FRAME <= start + PIECE_MAX {
            let energy: f32 = samples[at..at + FRAME].iter().map(|s| s * s).sum();
            if energy < best.0 {
                best = (energy, at + FRAME / 2);
            }
            at += HOP;
        }
        out.push((start, best.1));
        start = best.1;
    }
    if start < samples.len() {
        out.push((start, samples.len()));
    }
    out
}

/// SentencePiece marks a word's first token with a leading "▁" (or a space once decoded);
/// every other token, punctuation included, continues the current word.
fn group_words(
    tokens: &[String],
    starts: Option<&[f32]>,
    durations: Option<&[f32]>,
    piece_end: f32,
) -> Vec<Word> {
    let Some(starts) = starts else {
        return Vec::new();
    };
    let mut words: Vec<Word> = Vec::new();
    // A bare "▁" token starts the next word without carrying text of its own.
    let mut pending_start = false;
    for (i, token) in tokens.iter().enumerate() {
        let Some(&start) = starts.get(i) else { break };
        let next = starts.get(i + 1).copied().unwrap_or(piece_end);
        let end = match durations.and_then(|d| d.get(i)).copied() {
            Some(d) if d > 0.0 => start + d,
            _ => next.min(start + MAX_TAIL_SEC),
        };
        let begins = pending_start || token.starts_with('\u{2581}') || token.starts_with(' ');
        let piece = token.trim_start_matches(['\u{2581}', ' ']);
        if piece.is_empty() {
            pending_start = begins;
            continue;
        }
        pending_start = false;
        match words.last_mut() {
            Some(word) if !begins => {
                word.text.push_str(piece);
                word.end = end.max(word.end);
            }
            _ => words.push(Word {
                text: piece.to_string(),
                start,
                end,
            }),
        }
    }
    words
}

fn join_text(words: &[Word]) -> String {
    words
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}
