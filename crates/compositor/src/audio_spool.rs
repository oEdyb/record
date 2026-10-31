//! Disposable lossless PCM storage for native export. All processing reads bounded blocks;
//! only clip metadata scales with project length. Source files are always read-only.
use super::*;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const BLOCK: usize = 4096;
static NEXT_SPOOL: AtomicU64 = AtomicU64::new(0);

pub(crate) struct PcmSpool {
    file: Option<File>,
    path: PathBuf,
    pub samples: usize,
}

impl PcmSpool {
    pub fn new() -> Result<Self> {
        loop {
            let path = std::env::temp_dir().join(format!(
                "klippt-audio-{}-{}.pcm",
                std::process::id(),
                NEXT_SPOOL.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        path,
                        samples: 0,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn file(&mut self) -> Result<&mut File> {
        if self.file.is_none() {
            self.file = Some(OpenOptions::new().read(true).write(true).open(&self.path)?);
        }
        self.file
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("PCM spool is closed"))
    }

    fn close(&mut self) {
        self.file.take();
    }

    pub fn resize(&mut self, samples: usize) -> Result<()> {
        self.file()?.set_len(
            (samples as u64)
                .checked_mul(8)
                .ok_or_else(|| anyhow::anyhow!("PCM length overflow"))?,
        )?;
        self.samples = samples;
        Ok(())
    }

    pub fn append(&mut self, pcm: &PlanarPcm) -> Result<()> {
        self.write(self.samples, pcm)
    }

    pub(super) fn write(&mut self, offset: usize, pcm: &PlanarPcm) -> Result<()> {
        let samples = pcm.first().map_or(0, Vec::len);
        anyhow::ensure!(
            pcm.len() == 2
                && pcm
                    .iter()
                    .all(|p| p.len() == samples && p.iter().all(|s| s.is_finite())),
            "Invalid stereo PCM block"
        );
        self.file()?.seek(SeekFrom::Start(offset as u64 * 8))?;
        // Serialize in bounded pieces even if a caller supplies a larger codec frame.
        for start in (0..samples).step_by(BLOCK) {
            let count = BLOCK.min(samples - start);
            let mut bytes = Vec::with_capacity(count * 8);
            for i in start..start + count {
                for plane in pcm.iter().take(2) {
                    bytes.extend_from_slice(&plane[i].to_le_bytes());
                }
            }
            self.file()?.write_all(&bytes)?;
        }
        self.samples = self.samples.max(offset + samples);
        Ok(())
    }

    pub(super) fn read(&mut self, offset: usize, count: usize) -> Result<PlanarPcm> {
        anyhow::ensure!(
            count <= BLOCK + AUDIO_BOUNDARY_FADE_SAMPLES,
            "PCM read exceeds bounded block"
        );
        let mut pcm = vec![vec![0.0; count]; 2];
        let available = self.samples.saturating_sub(offset).min(count);
        let mut bytes = vec![0; available * 8];
        self.file()?.seek(SeekFrom::Start(offset as u64 * 8))?;
        self.file()?.read_exact(&mut bytes)?;
        for (i, frame) in bytes.chunks_exact(8).enumerate() {
            pcm[0][i] = f32::from_le_bytes(frame[..4].try_into()?);
            pcm[1][i] = f32::from_le_bytes(frame[4..].try_into()?);
        }
        Ok(pcm)
    }
}

impl Drop for PcmSpool {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) struct SpoolClip {
    pub(super) bed: Option<PcmSpool>,
    pub(super) microphone: Option<PcmSpool>,
}

impl SpoolClip {
    pub fn into_memory(mut self) -> Result<DecodedClipAudio> {
        fn read_all(spool: &mut PcmSpool) -> Result<PlanarPcm> {
            let mut pcm = vec![Vec::new(); 2];
            for offset in (0..spool.samples).step_by(BLOCK) {
                let block = spool.read(offset, BLOCK.min(spool.samples - offset))?;
                for ch in 0..2 {
                    pcm[ch].extend_from_slice(&block[ch]);
                }
            }
            Ok(pcm)
        }
        Ok(DecodedClipAudio {
            bed: self.bed.as_mut().map(read_all).transpose()?,
            microphone: self.microphone.as_mut().map(read_all).transpose()?,
        })
    }
}

pub(super) fn align_tracks(
    tracks: &mut [AudioTrackDecoder],
    start: f64,
    samples: usize,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<SpoolClip> {
    let mut clip = SpoolClip {
        bed: None,
        microphone: None,
    };
    for microphone in [false, true] {
        if !tracks.iter().any(|track| track.microphone == microphone) {
            continue;
        }
        let mut output = PcmSpool::new()?;
        for offset in (0..samples).step_by(BLOCK) {
            check()?;
            let count = BLOCK.min(samples - offset);
            let mut mixed = vec![vec![0.0; count]; 2];
            for track in tracks
                .iter_mut()
                .filter(|track| track.microphone == microphone)
            {
                let shift = ((start - track.origin_sec.unwrap_or(start))
                    * AUDIO_OUTPUT_SAMPLE_RATE as f64)
                    .round() as i64;
                let source = offset as i64 + shift;
                let pad = (-source).max(0).min(count as i64) as usize;
                let block = track.decoded.read(source.max(0) as usize, count - pad)?;
                for ch in 0..2 {
                    for i in pad..count {
                        mixed[ch][i] += block[ch][i - pad];
                    }
                }
            }
            if tracks
                .iter()
                .filter(|track| track.microphone == microphone)
                .count()
                > 1
            {
                for plane in &mut mixed {
                    for sample in plane {
                        *sample = sample.clamp(-1.0, 1.0);
                    }
                }
            }
            output.append(&mixed)?;
        }
        if microphone {
            clip.microphone = Some(output);
        } else {
            clip.bed = Some(output);
        }
    }
    Ok(clip)
}

// Keep the upstream atempo path bounded in memory: read and drain one block at a time.
fn atempo_spool(
    source: &mut PcmSpool,
    start: usize,
    input: usize,
    target: usize,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Option<PcmSpool>> {
    let speed = input as f64 / target as f64;
    let Some(factors) = atempo_factors(speed) else {
        return Ok(None);
    };
    let tail = atempo_prime_tail(&factors, speed);
    let mut run = |factors: &[f64], tail: usize| -> Result<Option<(PcmSpool, usize)>> {
        let mut output = PcmSpool::new()?;
        let failure = std::cell::RefCell::new(None);
        let produced = unsafe {
            atempo_stream_pass(
                input,
                &mut |offset, count| match check().and_then(|()| source.read(start + offset, count))
                {
                    Ok(block) => Some(block),
                    Err(error) => {
                        *failure.borrow_mut() = Some(error);
                        None
                    }
                },
                &mut |block| match output.append(&block) {
                    Ok(()) => Some(()),
                    Err(error) => {
                        *failure.borrow_mut() = Some(error);
                        None
                    }
                },
                factors,
                tail,
                target,
            )
        };
        if let Some(error) = failure.into_inner() {
            return Err(error);
        }
        Ok(produced.map(|n| (output, n)))
    };
    let Some((mut output, produced)) = run(&factors, tail)? else {
        return Ok(None);
    };
    let shortfall = (((input + tail) as f64 / speed).round() as usize).saturating_sub(produced);
    if shortfall > 0 {
        let corrected_speed = input as f64 / (target + shortfall + ATEMPO_LENGTH_GUARD) as f64;
        let Some(corrected) = atempo_factors(corrected_speed) else {
            return Ok(None);
        };
        if let Some((candidate, _)) =
            run(&corrected, atempo_prime_tail(&corrected, corrected_speed))?
        {
            if candidate.samples >= target {
                output = candidate;
            }
        }
    }
    Ok((output.samples >= target).then_some(output))
}

fn stretch(
    mut source: PcmSpool,
    segments: &[SpeedSegment],
    fps: f64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<PcmSpool> {
    let mut output = PcmSpool::new()?;
    let mut source_cursor = 0;
    for segment in segments {
        let requested = ((segment.end_sec - segment.start_sec) * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        let input = requested.min(source.samples.saturating_sub(source_cursor));
        let target = (segment.frame_count as f64 / fps * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        let base = output.samples;
        if input > 0 && target > 0 {
            let speed = input as f64 / target as f64;
            let passthrough =
                input.abs_diff(target) <= 1 || (speed - 1.0).abs() < PASSTHROUGH_EPSILON;
            if !passthrough {
                if let Some(mut processed) =
                    atempo_spool(&mut source, source_cursor, input, target, check)?
                {
                    for offset in (0..target).step_by(BLOCK) {
                        check()?;
                        output.append(&processed.read(offset, BLOCK.min(target - offset))?)?;
                    }
                    source_cursor += requested;
                    continue;
                }
                eprintln!("[audio] atempo unavailable; using WSOLA");
            }
            let mut stretcher = WsolaTimeStretcher::new(AUDIO_OUTPUT_SAMPLE_RATE, 2, speed, target);
            for offset in (0..input).step_by(BLOCK) {
                check()?;
                let block = source.read(source_cursor + offset, BLOCK.min(input - offset))?;
                let mut processed = if passthrough {
                    block
                } else {
                    stretcher.push(&block)
                };
                let remaining = (base + target).saturating_sub(output.samples);
                for plane in &mut processed {
                    plane.truncate(remaining);
                }
                output.append(&processed)?;
            }
            if !passthrough {
                let mut tail = stretcher.flush();
                let remaining = (base + target).saturating_sub(output.samples);
                for plane in &mut tail {
                    plane.truncate(remaining);
                }
                output.append(&tail)?;
            }
        }
        output.resize(base + target)?;
        source_cursor += requested;
    }
    Ok(output)
}

pub(crate) fn decode(
    path: &str,
    clean: Option<&str>,
    start: f64,
    end: f64,
    segments: &[SpeedSegment],
    fps: f64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Option<SpoolClip>> {
    let Some(mut raw) = (unsafe { decode_clip_audio_inner(path, start, end, check)? }) else {
        return Ok(None);
    };
    if let Some(path) = clean {
        match unsafe { decode_clip_audio_inner(path, start, end, check) } {
            Ok(Some(clean)) => {
                if let Some(stem) = clean.microphone.or(clean.bed) {
                    raw.microphone = Some(stem);
                }
            }
            result => {
                check()?; // A cancellation is never downgraded into a raw fallback.
                eprintln!(
                    "[audio] Clean Voice unavailable; complete raw microphone retained ({})",
                    if result.is_err() {
                        "decode failed"
                    } else {
                        "no audio"
                    }
                );
            }
        }
    }
    raw.bed = raw
        .bed
        .map(|s| stretch(s, segments, fps, check))
        .transpose()?;
    raw.microphone = raw
        .microphone
        .map(|s| stretch(s, segments, fps, check))
        .transpose()?;
    if let Some(stem) = raw.bed.as_mut() {
        stem.close();
    }
    if let Some(stem) = raw.microphone.as_mut() {
        stem.close();
    }
    Ok(Some(raw))
}

fn measure(
    pcm: &mut PcmSpool,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Option<AudioMeasurement>> {
    if pcm.samples < AUDIO_OUTPUT_SAMPLE_RATE as usize * 4 / 10 {
        return Ok(None);
    }
    // HISTOGRAM bounds the integrated-loudness gate history independently of duration.
    // https://docs.rs/ebur128/0.1.10/ebur128/struct.Mode.html
    let mut analyzer = EbuR128::new(
        2,
        AUDIO_OUTPUT_SAMPLE_RATE as u32,
        Mode::I | Mode::TRUE_PEAK | Mode::HISTOGRAM,
    )?;
    for offset in (0..pcm.samples).step_by(BLOCK) {
        check()?;
        let block = pcm.read(offset, BLOCK.min(pcm.samples - offset))?;
        analyzer.add_frames_planar_f32(&[&block[0], &block[1]])?;
    }
    let integrated_lufs = analyzer.loudness_global()?;
    if !integrated_lufs.is_finite() {
        return Ok(None);
    }
    let peak = analyzer.true_peak(0)?.max(analyzer.true_peak(1)?);
    Ok(Some(AudioMeasurement {
        integrated_lufs,
        true_peak_dbtp: 20.0 * peak.log10(),
    }))
}

fn gain(pcm: &mut PcmSpool, db: f64, check: &mut dyn FnMut() -> Result<()>) -> Result<()> {
    if db.abs() < 0.01 {
        return Ok(());
    }
    for offset in (0..pcm.samples).step_by(BLOCK) {
        check()?;
        let mut block = pcm.read(offset, BLOCK.min(pcm.samples - offset))?;
        apply_uniform_gain(&mut block, db);
        pcm.write(offset, &block)?;
    }
    Ok(())
}

fn limit(
    pcm: &mut PcmSpool,
    ceiling_db: f64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<bool> {
    let lookahead = (LIMITER_LOOKAHEAD_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()
        .max(1.0) as usize;
    let attack =
        (1.0 - (-1.0 / (LIMITER_ATTACK_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)).exp()) as f32;
    let release = (1.0
        - (-1.0 / (LIMITER_RELEASE_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)).exp())
        as f32;
    let ceiling = 10.0_f32.powf((ceiling_db / 20.0) as f32);
    let mut minima = VecDeque::new();
    let mut applied = None;
    let mut engaged = false;
    for offset in (0..pcm.samples).step_by(BLOCK) {
        check()?;
        let count = BLOCK.min(pcm.samples - offset);
        let mut block = pcm.read(offset, (count + lookahead).min(pcm.samples - offset))?;
        // The future tail has not been modified; carry the envelope across blocks.
        minima.clear();
        for i in 0..block[0].len().min(lookahead + 1) {
            let required = required_limiter_gain(&block, i, ceiling);
            engaged |= required < 1.0;
            enqueue_limiter_gain(&mut minima, i, required);
        }
        let mut value = applied.unwrap_or_else(|| minima.front().map_or(1.0, |(_, g)| *g));
        for i in 0..count {
            while minima.front().is_some_and(|(frame, _)| *frame < i) {
                minima.pop_front();
            }
            let required = minima.front().map_or(1.0, |(_, g)| *g);
            value = if required < value - f32::EPSILON {
                value + (required - value) * attack
            } else if required > value + f32::EPSILON {
                value + (1.0 - value) * release
            } else {
                value
            };
            for plane in &mut block {
                plane[i] *= value;
            }
            let next = i + lookahead + 1;
            if next < block[0].len() {
                let required = required_limiter_gain(&block, next, ceiling);
                engaged |= required < 1.0;
                enqueue_limiter_gain(&mut minima, next, required);
            }
        }
        applied = Some(value);
        for plane in &mut block {
            plane.truncate(count);
        }
        pcm.write(offset, &block)?;
    }
    Ok(engaged)
}

pub(crate) fn assemble(
    mut clips: Vec<Option<SpoolClip>>,
    plan: &AudioConcatPlan,
    even_volume: bool,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<PcmSpool> {
    let mut levels = vec![None; clips.len()];
    if even_volume {
        for (index, clip) in clips.iter_mut().enumerate() {
            if let Some(mic) = clip.as_mut().and_then(|c| c.microphone.as_mut()) {
                levels[index] =
                    measure(mic, check)?.filter(|m| m.integrated_lufs >= MIN_DIALOGUE_LUFS);
                mic.close();
            }
        }
    }
    let mut loudness: Vec<f64> = levels.iter().flatten().map(|m| m.integrated_lufs).collect();
    loudness.sort_by(f64::total_cmp);
    let reference = if loudness.len() < 2 {
        None
    } else {
        let mid = loudness.len() / 2;
        Some(if loudness.len() % 2 == 0 {
            (loudness[mid - 1] + loudness[mid]) / 2.0
        } else {
            loudness[mid]
        })
    };
    let mut output = PcmSpool::new()?;
    for (index, segment) in plan.segments.iter().enumerate() {
        let mut clip = clips.get_mut(index).and_then(Option::take);
        let mic_gain =
            reference
                .zip(levels.get(index).copied().flatten())
                .map_or(0.0, |(reference, m)| {
                    let db = (reference - m.integrated_lufs)
                        .clamp(-MAX_CLIP_DIALOGUE_GAIN_DB, MAX_CLIP_DIALOGUE_GAIN_DB);
                    if db > 0.0 {
                        db.min((CLIP_DIALOGUE_TRUE_PEAK_HEADROOM_DBTP - m.true_peak_dbtp).max(0.0))
                    } else {
                        db
                    }
                });
        for offset in (0..segment.sample_count).step_by(BLOCK) {
            check()?;
            let count = BLOCK.min(segment.sample_count - offset);
            let mut mixed = vec![vec![0.0; count]; 2];
            if !segment.silence {
                if let Some(clip) = clip.as_mut() {
                    if let Some(bed) = clip.bed.as_mut() {
                        mixed = bed.read(offset, count)?;
                    }
                    if let Some(mic) = clip.microphone.as_mut() {
                        let mut block = mic.read(offset, count)?;
                        apply_uniform_gain(&mut block, mic_gain);
                        for ch in 0..2 {
                            for i in 0..count {
                                mixed[ch][i] += block[ch][i];
                            }
                        }
                    }
                }
            }
            if clip
                .as_ref()
                .is_some_and(|clip| clip.bed.is_some() && clip.microphone.is_some())
            {
                for plane in &mut mixed {
                    for sample in plane {
                        *sample = sample.clamp(-1.0, 1.0);
                    }
                }
            }
            output.append(&mixed)?;
        }
    }
    for pair in plan.segments.windows(2) {
        let fade = AUDIO_BOUNDARY_FADE_SAMPLES
            .min(pair[0].sample_count / 2)
            .min(pair[1].sample_count / 2);
        if fade == 0 {
            continue;
        }
        check()?;
        let tail = pair[0].start_sample + pair[0].sample_count - fade;
        let head = pair[1].start_sample;
        let mut before = output.read(tail, fade)?;
        let mut after = output.read(head, fade)?;
        for ch in 0..2 {
            for k in 0..fade {
                let phase = k as f32 / fade as f32 * PI * 0.5;
                before[ch][k] *= phase.cos();
                after[ch][k] *= phase.sin();
            }
        }
        output.write(tail, &before)?;
        output.write(head, &after)?;
    }
    Ok(output)
}

pub(crate) fn master(
    pcm: &mut PcmSpool,
    settings: AudioMasteringSettings,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<AudioMasteringStats> {
    if !settings.enabled {
        return Ok(AudioMasteringStats::disabled());
    }
    let Some(input) = measure(pcm, check)? else {
        return Ok(AudioMasteringStats::skipped(
            "Audio is silent or shorter than the 400 ms EBU R128 analysis window.".to_owned(),
        ));
    };

    let requested_gain_db = settings.target_lufs - input.integrated_lufs;
    let mut applied_gain_db = requested_gain_db.min(MAX_AUTOMATIC_GAIN_DB);
    gain(pcm, applied_gain_db, check)?;

    let mut limiter_engaged = limit(pcm, settings.true_peak_ceiling_dbtp, check)?;
    let mut after_limiter = measure(pcm, check)?.unwrap_or(input);
    for _ in 0..2 {
        let remaining_gain_db = MAX_AUTOMATIC_GAIN_DB - applied_gain_db;
        let residual_gain_db = (settings.target_lufs - after_limiter.integrated_lufs)
            .max(0.0)
            .min(remaining_gain_db);
        if residual_gain_db < 0.05 {
            break;
        }
        gain(pcm, residual_gain_db, check)?;
        applied_gain_db += residual_gain_db;
        limiter_engaged |= limit(pcm, settings.true_peak_ceiling_dbtp, check)?;
        after_limiter = measure(pcm, check)?.unwrap_or(after_limiter);
    }
    let true_peak_trim_db = if after_limiter.true_peak_dbtp > settings.true_peak_ceiling_dbtp {
        settings.true_peak_ceiling_dbtp - after_limiter.true_peak_dbtp
    } else {
        0.0
    };
    if true_peak_trim_db < -0.01 {
        gain(pcm, true_peak_trim_db, check)?;
    }

    let output = measure(pcm, check)?.unwrap_or(input);
    let limited_by_true_peak = limiter_engaged || true_peak_trim_db < -0.01;
    let missed_target = output.integrated_lufs < settings.target_lufs - 0.5;
    let limited_by_gain_cap = missed_target && applied_gain_db >= MAX_AUTOMATIC_GAIN_DB - 0.01;
    let warning = if limited_by_gain_cap && missed_target {
        Some(format!(
            "Normalization stopped at the {MAX_AUTOMATIC_GAIN_DB:.0} dB automatic gain limit."
        ))
    } else if limited_by_true_peak && missed_target {
        Some(format!(
            "Normalization stopped below {:.1} LUFS to keep pre-encode true peaks at or below {:.1} dBTP.",
            settings.target_lufs, settings.true_peak_ceiling_dbtp
        ))
    } else {
        None
    };

    Ok(AudioMasteringStats {
        enabled: true,
        analyzed: true,
        applied_gain_db,
        input_lufs: Some(input.integrated_lufs),
        output_lufs: Some(output.integrated_lufs),
        input_true_peak_dbtp: input
            .true_peak_dbtp
            .is_finite()
            .then_some(input.true_peak_dbtp),
        output_true_peak_dbtp: output
            .true_peak_dbtp
            .is_finite()
            .then_some(output.true_peak_dbtp),
        limited_by_true_peak,
        limited_by_gain_cap,
        warning,
    })
}

pub(crate) unsafe fn encode(
    pcm: &mut PcmSpool,
    encoder: &mut AacEncoder,
    output: *mut AVFormatContext,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    let frame_size = if (*encoder.context).frame_size > 0 {
        (*encoder.context).frame_size as usize
    } else {
        1024
    };
    anyhow::ensure!(frame_size <= BLOCK, "AAC frame exceeds PCM block size");
    for offset in (0..pcm.samples).step_by(frame_size) {
        check()?;
        encoder.encode_block(
            &pcm.read(offset, frame_size.min(pcm.samples - offset))?,
            output,
        )?;
    }
    encoder.finish(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_pcm(pcm: &PlanarPcm) -> PcmSpool {
        let mut spool = PcmSpool::new().unwrap();
        spool.append(pcm).unwrap();
        spool
    }

    fn all(spool: PcmSpool) -> PlanarPcm {
        SpoolClip {
            bed: Some(spool),
            microphone: None,
        }
        .into_memory()
        .unwrap()
        .into_mixed()
    }

    fn signal(samples: usize, amplitude: f32) -> PlanarPcm {
        let plane = (0..samples)
            .map(|i| amplitude * (2.0 * PI * 317.0 * i as f32 / 48000.0).sin())
            .collect::<Vec<_>>();
        vec![plane.clone(), plane]
    }

    #[test]
    fn streaming_speed_matches_existing_wsola_and_exact_rounding() {
        for speed in [0.5, 1.0, 2.0] {
            for source_samples in [47_999, 48_000, 48_001] {
                let pcm = signal(source_samples, 0.2);
                let segments = vec![SpeedSegment {
                    start_sec: 0.0,
                    end_sec: source_samples as f64 / 48000.0,
                    speed,
                    output_start_sec: 0.0,
                    first_frame: 0,
                    frame_count: (30.0 / speed) as u64,
                }];
                let expected = stretch_clip_pcm_by_speed(&pcm, &segments, 30.0);
                let actual = all(stretch(from_pcm(&pcm), &segments, 30.0, &mut || Ok(())).unwrap());
                assert_eq!(actual, expected, "speed={speed}, input={source_samples}");
            }
        }
    }

    #[test]
    fn block_limiter_preserves_envelope_at_block_boundaries() {
        let mut pcm = signal(BLOCK * 4 + 19, 0.8);
        for i in [BLOCK - 1, BLOCK, BLOCK + 239, BLOCK * 2] {
            pcm[0][i] = 1.5;
        }
        let mut spool = from_pcm(&pcm);
        let expected_engaged = apply_peak_limiter(&mut pcm, -2.0);
        let actual_engaged = limit(&mut spool, -2.0, &mut || Ok(())).unwrap();
        assert_eq!(actual_engaged, expected_engaged);
        assert_eq!(all(spool), pcm);
    }

    #[test]
    fn spool_mix_preserves_roles_and_ten_ms_cut_samples() {
        let make = || {
            vec![
                Some(DecodedClipAudio {
                    bed: Some(signal(48_000, 0.1)),
                    microphone: Some(signal(48_000, 0.02)),
                }),
                Some(DecodedClipAudio {
                    bed: Some(signal(48_000, 0.1)),
                    microphone: Some(signal(48_000, 0.1)),
                }),
            ]
        };
        let plan = build_audio_concat_plan(&[30, 30], &[true, true], 30.0);
        for even in [false, true] {
            let expected =
                assemble_concatenated_pcm(&finalize_decoded_clip_audio(make(), even), &plan);
            let clips = make()
                .into_iter()
                .map(|clip| {
                    clip.map(|clip| SpoolClip {
                        bed: clip.bed.map(|p| from_pcm(&p)),
                        microphone: clip.microphone.map(|p| from_pcm(&p)),
                    })
                })
                .collect();
            let actual = all(assemble(clips, &plan, even, &mut || Ok(())).unwrap());
            assert_eq!(actual[0].len(), 96_000);
            let max_error = actual
                .iter()
                .flatten()
                .zip(expected.iter().flatten())
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(max_error < 0.002, "even={even}, error={max_error}");
            if !even {
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn whole_program_mastering_matches_reference_with_histogram_tolerance() {
        let mut pcm = signal(96_000, 0.03);
        pcm[0][BLOCK * 5] = 0.85;
        let mut spool = from_pcm(&pcm);
        let settings = AudioMasteringSettings::default();
        let expected = master_program_audio(&mut pcm, settings);
        let actual = master(&mut spool, settings, &mut || Ok(())).unwrap();
        assert!((actual.output_lufs.unwrap() - expected.output_lufs.unwrap()).abs() < 0.15);
        assert!(actual.output_true_peak_dbtp.unwrap() <= settings.true_peak_ceiling_dbtp + 0.01);
        assert_eq!(all(spool)[0].len(), pcm[0].len());
    }

    #[test]
    fn ninety_minute_silent_spool_stays_sparse_and_cancelable() {
        let mut spool = PcmSpool::new().unwrap();
        let samples = 90 * 60 * 48000;
        spool.resize(samples).unwrap();
        assert_eq!(
            spool.read(samples - BLOCK, BLOCK).unwrap(),
            vec![vec![0.0; BLOCK]; 2]
        );
        let path = spool.path.clone();
        let mut blocks = 0;
        let result = measure(&mut spool, &mut || {
            blocks += 1;
            if blocks == 20 {
                bail!("cancelled")
            }
            Ok(())
        });
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        drop(spool);
        assert!(!path.exists());
    }

    #[test]
    fn zero_frame_clips_and_silence_keep_exact_concat_length() {
        let plan = build_audio_concat_plan(&[1, 0, 2, 1], &[false; 4], 29.97);
        let result = assemble(vec![None, None, None, None], &plan, false, &mut || Ok(())).unwrap();
        assert_eq!(result.samples, plan.total_samples);
        assert!(all(result).iter().flatten().all(|s| *s == 0.0));
    }

    #[test]
    fn wav_decode_streams_and_cancellation_releases_resources() {
        let samples = 48_001usize;
        let mut fixture = PcmSpool::new().unwrap();
        let path = fixture.path.clone();
        let data_bytes = (samples * 2) as u32;
        let mut header = b"RIFF".to_vec();
        header.extend((36 + data_bytes).to_le_bytes());
        header.extend(b"WAVEfmt ");
        header.extend(16u32.to_le_bytes());
        header.extend(1u16.to_le_bytes());
        header.extend(1u16.to_le_bytes());
        header.extend(48000u32.to_le_bytes());
        header.extend(96000u32.to_le_bytes());
        header.extend(2u16.to_le_bytes());
        header.extend(16u16.to_le_bytes());
        header.extend(b"data");
        header.extend(data_bytes.to_le_bytes());
        for i in 0..samples {
            header.extend(((i % 100) as i16 * 100).to_le_bytes());
        }
        fixture.file().unwrap().write_all(&header).unwrap();
        fixture.close();
        let mut check = || Ok(());
        let decoded = unsafe {
            decode_clip_audio_inner(
                path.to_str().unwrap(),
                0.0,
                samples as f64 / 48000.0,
                &mut check,
            )
        }
        .unwrap()
        .unwrap();
        assert_eq!(decoded.bed.as_ref().unwrap().samples, samples);
        let mut calls = 0;
        let result = unsafe {
            decode_clip_audio_inner(path.to_str().unwrap(), 0.0, 2.0, &mut || {
                calls += 1;
                bail!("cancelled")
            })
        };
        assert!(result.is_err());
        assert_eq!(calls, 1);
        drop(fixture);
        assert!(!path.exists());
    }
}
