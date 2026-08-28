use std::{
    env,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    time::Instant,
};

use anyhow::{bail, Context, Result};
use df::tract::{DfParams, DfTract, RuntimeParams};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use ndarray::Array2;
use serde::Serialize;
use tempfile::NamedTempFile;

const ENGINE_ID: &str = "deepfilternet3-libdf-v0.5.6-klippt-silence-grace-v1";
const ENGINE_COMMIT: &str = "b0fa238a331fb5cc39c5555d3538008dd88c0aef";
const MODEL_SHA256: &str = "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616";
const REQUIRED_SAMPLE_RATE: u32 = 48_000;
const SPEAKER_FRONT_CENTER: u32 = 0x4;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
const IEEE_FLOAT_SUBFORMAT: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

#[derive(Debug)]
struct Args {
    input: PathBuf,
    output: PathBuf,
    attenuation_limit_db: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    engine_id: &'static str,
    engine_commit: &'static str,
    model_sha256: &'static str,
    sample_rate: u32,
    input_samples: usize,
    output_samples: usize,
    delay_samples: usize,
    attenuation_limit_db: f32,
    input_peak: f32,
    output_peak: f32,
    wall_seconds: f64,
    real_time_factor: f64,
}

fn usage() -> &'static str {
    "Usage: klippt-clean-voice --input INPUT.wav --output OUTPUT.wav [--attenuation-limit-db 6]"
}

fn parse_args() -> Result<Args> {
    let mut input = None;
    let mut output = None;
    // Natural is deliberately conservative. Stronger cleanup remains available to the
    // development lab, but it must pass the creator speech corpus before it becomes a
    // product preset.
    let mut attenuation_limit_db: f32 = 6.0;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => input = args.next().map(PathBuf::from),
            "--output" => output = args.next().map(PathBuf::from),
            "--attenuation-limit-db" => {
                let value = args.next().context("missing attenuation limit")?;
                attenuation_limit_db = value.parse().context("invalid attenuation limit")?;
            }
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => bail!("unknown argument {other}\n{}", usage()),
        }
    }
    if !attenuation_limit_db.is_finite()
        || attenuation_limit_db <= 0.0
        || attenuation_limit_db > 30.0
    {
        bail!("attenuation limit must be greater than 0 and no more than 30 dB");
    }
    Ok(Args {
        input: input.with_context(usage)?,
        output: output.with_context(usage)?,
        attenuation_limit_db,
    })
}

trait InputSample {
    fn to_float(self) -> f32;
}

impl InputSample for i16 {
    fn to_float(self) -> f32 {
        self as f32 / 32_768.0
    }
}

impl InputSample for f32 {
    fn to_float(self) -> f32 {
        self
    }
}

fn process_samples<S, I>(
    samples: I,
    input_samples: usize,
    args: &Args,
    temp_file: File,
) -> Result<Report>
where
    S: InputSample,
    I: Iterator<Item = hound::Result<S>>,
{
    let started = Instant::now();
    let mut runtime = RuntimeParams::default().with_atten_lim(args.attenuation_limit_db);
    runtime.n_ch = 1;
    let params = DfParams::default();
    let mut model =
        DfTract::new(params, &runtime).context("failed to initialize DeepFilterNet3")?;
    if model.sr as u32 != REQUIRED_SAMPLE_RATE {
        bail!(
            "embedded model uses an unexpected {} Hz sample rate",
            model.sr
        );
    }

    let hop = model.hop_size;
    let delay = model.fft_size - model.hop_size + model.lookahead * model.hop_size;
    let frames = (input_samples + delay).div_ceil(hop);
    let output_spec = WavSpec {
        channels: 1,
        sample_rate: REQUIRED_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::new(BufWriter::new(temp_file), output_spec)
        .context("failed to create output WAV")?;
    let mut samples = samples;
    let mut input = Array2::<f32>::zeros((1, hop));
    let mut output = Array2::<f32>::zeros((1, hop));
    let mut input_read = 0usize;
    let mut output_written = 0usize;
    let mut generated = 0usize;
    let mut input_peak = 0.0f32;
    let mut output_peak = 0.0f32;
    // DeepFilterNet 3 has a 1,440-sample file delay. The pinned silence-grace patch guarantees
    // that at least three low-energy hops advance the model, so the three zero hops appended here
    // flush the complete tail without injecting a synthetic tone.
    for _ in 0..frames {
        input.fill(0.0);
        for index in 0..hop {
            if input_read >= input_samples {
                break;
            }
            let value = samples
                .next()
                .context("input ended before its WAV header length")??
                .to_float();
            if !value.is_finite() {
                bail!("input contains a non-finite sample");
            }
            input[(0, index)] = value;
            input_peak = input_peak.max(value.abs());
            input_read += 1;
        }
        output.fill(0.0);
        model
            .process(input.view(), output.view_mut())
            .context("DeepFilterNet3 inference failed")?;
        for index in 0..hop {
            let position = generated + index;
            if position < delay || output_written >= input_samples {
                continue;
            }
            let value = output[(0, index)];
            if !value.is_finite() {
                bail!("enhancer produced a non-finite sample");
            }
            output_peak = output_peak.max(value.abs());
            writer
                .write_sample(value)
                .context("failed to write enhanced sample")?;
            output_written += 1;
        }
        generated += hop;
    }

    if input_read != input_samples || output_written != input_samples {
        bail!(
            "sample count mismatch: input {input_read}/{input_samples}, output {output_written}/{input_samples}"
        );
    }
    if output_peak > input_peak.max(1.0) + 0.01 {
        bail!(
            "enhancer created an unexpected peak: input {input_peak:.6}, output {output_peak:.6}"
        );
    }
    writer.finalize().context("failed to finalize output WAV")?;

    let wall_seconds = started.elapsed().as_secs_f64();
    let audio_seconds = input_samples as f64 / REQUIRED_SAMPLE_RATE as f64;
    Ok(Report {
        engine_id: ENGINE_ID,
        engine_commit: ENGINE_COMMIT,
        model_sha256: MODEL_SHA256,
        sample_rate: REQUIRED_SAMPLE_RATE,
        input_samples,
        output_samples: output_written,
        delay_samples: delay,
        attenuation_limit_db: args.attenuation_limit_db,
        input_peak,
        output_peak,
        wall_seconds,
        real_time_factor: if audio_seconds > 0.0 {
            wall_seconds / audio_seconds
        } else {
            0.0
        },
    })
}

fn center_mono_wave_channel(file: &mut File) -> Result<()> {
    file.seek(SeekFrom::Start(0))?;
    let mut riff_header = [0u8; 12];
    file.read_exact(&mut riff_header)?;
    if &riff_header[0..4] != b"RIFF" || &riff_header[8..12] != b"WAVE" {
        bail!("enhancer output is not a RIFF/WAVE file");
    }

    loop {
        let mut chunk_header = [0u8; 8];
        file.read_exact(&mut chunk_header)
            .context("enhancer output has no WAVE format chunk")?;
        let chunk_size = u32::from_le_bytes(chunk_header[4..8].try_into()?) as u64;
        let chunk_start = file.stream_position()?;
        if &chunk_header[0..4] == b"fmt " {
            if chunk_size < 40 {
                bail!("enhancer output has an unexpected WAVE format chunk");
            }
            let mut format = [0u8; 40];
            file.read_exact(&mut format)?;
            let format_tag = u16::from_le_bytes(format[0..2].try_into()?);
            let channels = u16::from_le_bytes(format[2..4].try_into()?);
            let sample_rate = u32::from_le_bytes(format[4..8].try_into()?);
            let bits_per_sample = u16::from_le_bytes(format[14..16].try_into()?);
            if format_tag != WAVE_FORMAT_EXTENSIBLE
                || channels != 1
                || sample_rate != REQUIRED_SAMPLE_RATE
                || bits_per_sample != 32
                || format[24..40] != IEEE_FLOAT_SUBFORMAT
            {
                bail!("enhancer output has an unexpected mono Float32 WAVE format");
            }
            file.seek(SeekFrom::Start(chunk_start + 20))?;
            file.write_all(&SPEAKER_FRONT_CENTER.to_le_bytes())?;
            return Ok(());
        }
        file.seek(SeekFrom::Start(chunk_start + chunk_size + chunk_size % 2))?;
    }
}

fn run(args: &Args) -> Result<Report> {
    let parent = args.output.parent().context("output path has no parent")?;
    fs::create_dir_all(parent).context("failed to create output directory")?;
    let input_path = fs::canonicalize(&args.input).context("failed to resolve input WAV")?;
    let output_name = args
        .output
        .file_name()
        .context("output path has no file name")?;
    let output_path = match fs::canonicalize(&args.output) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::canonicalize(parent)
            .context("failed to resolve output directory")?
            .join(output_name),
        Err(error) => return Err(error).context("failed to resolve output WAV"),
    };
    if input_path == output_path {
        bail!("input and output must be different files; the raw microphone is immutable");
    }
    let mut temp = NamedTempFile::new_in(parent).context("failed to create temporary output")?;
    let result = (|| {
        let reader = WavReader::new(BufReader::new(
            File::open(&args.input).context("failed to open input WAV")?,
        ))
        .context("failed to read input WAV")?;
        let spec = reader.spec();
        if spec.channels != 1 || spec.sample_rate != REQUIRED_SAMPLE_RATE {
            bail!(
                "input must be mono 48 kHz WAV; got {} channel(s) at {} Hz",
                spec.channels,
                spec.sample_rate
            );
        }
        let input_samples = reader.len() as usize;
        match (spec.sample_format, spec.bits_per_sample) {
            (SampleFormat::Int, 16) => process_samples::<i16, _>(
                reader.into_samples::<i16>(),
                input_samples,
                args,
                temp.reopen().context("failed to reopen temporary output")?,
            ),
            (SampleFormat::Float, 32) => process_samples::<f32, _>(
                reader.into_samples::<f32>(),
                input_samples,
                args,
                temp.reopen().context("failed to reopen temporary output")?,
            ),
            _ => bail!("input must use 16-bit PCM or 32-bit float samples"),
        }
    })();

    match result {
        Ok(report) => {
            center_mono_wave_channel(temp.as_file_mut())
                .context("failed to mark mono output as front center")?;
            temp.as_file()
                .sync_all()
                .context("failed to sync output WAV")?;
            temp.persist(&args.output)
                .map_err(|error| error.error)
                .context("failed to publish output WAV")?;
            if let Ok(directory) = File::open(parent) {
                let _ = directory.sync_all();
            }
            Ok(report)
        }
        Err(error) => Err(error),
    }
}

fn main() {
    let result = parse_args().and_then(|args| run(&args));
    match result {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string(&report).expect("report serialization")
            );
        }
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "{error:#}");
            std::process::exit(1);
        }
    }
}
