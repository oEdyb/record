//! Reducing the recording (padding, or a 1440p source in a 1080p export) must not skip
//! source pixels. The video texture has no mips, so a single linear fetch reads only 2
//! texels per axis: below 1:1 fine text comes out with uneven stroke weight, which is the
//! loss measured in `docs/blur-investigation-2026-11-03.md`.
//!
//! A 1px black/white grating is the worst case. Averaged over the footprint of an output
//! pixel it stays near mid-grey; undersampled it beats between dark and light bands.

#![cfg(target_os = "linux")]

use std::path::PathBuf;
use std::process::Command;

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::Decoder;
use openscreen_compositor::scene::Scene;

const OUT_W: u32 = 960;
const OUT_H: u32 = 540;

fn grating_video(tag: &str) -> Option<PathBuf> {
    let path = std::env::temp_dir().join(format!(
        "klippt-grating-{}-{tag}.mp4",
        std::process::id()
    ));
    let made = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
        .arg(format!("color=white:s={OUT_W}x{OUT_H}:r=30:d=1"))
        .args([
            "-vf",
            "format=yuv420p,geq=lum='mod(X\\,2)*255':cb=128:cr=128",
        ])
        .args(["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast"])
        .arg(&path)
        .status()
        .ok()?;
    made.success().then_some(path)
}

/// Luma spread of output columns across the middle of the screen layer.
fn column_spread(padding: f32, tag: &str) -> Option<f32> {
    let Some(video) = grating_video(tag) else {
        eprintln!("downscale_sharpness: ffmpeg with libx264 unavailable. Skip.");
        return None;
    };
    let gpu = match Gpu::create(false) {
        Ok(gpu) => gpu,
        Err(error) => {
            eprintln!("downscale_sharpness: no GPU ({error:#}). Skip.");
            return None;
        }
    };
    let comp = Compositor::new_sized(&gpu, OUT_W, OUT_H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(video.to_str().expect("utf-8 path"), &gpu).expect("Decoder::open");
    let scene = format!(
        r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":{padding},"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#808080"}},"zoomRegions":[],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":{OUT_W},"height":{OUT_H},"fps":30}}}}"##
    );
    comp.set_scene(Some(Scene::from_json(&scene).expect("scene json")));
    let (w, h, rgba) = unsafe {
        let frame = dec.seek_to(0.5).expect("Decoder::seek_to");
        let cfg = Cfg::c8();
        comp.compose_frame(frame, frame, 0.0, &cfg, std::ptr::null(), None)
            .expect("compose_frame");
        comp.readback_direct().expect("readback_direct")
    };
    let _ = std::fs::remove_file(&video);
    let row = (h / 2) as usize;
    let luma: Vec<f32> = (w as usize / 4..w as usize * 3 / 4)
        .map(|x| rgba[(row * w as usize + x) * 4] as f32)
        .collect();
    let max = luma.iter().copied().fold(f32::MIN, f32::max);
    let min = luma.iter().copied().fold(f32::MAX, f32::min);
    Some(max - min)
}

#[test]
fn reduced_video_averages_source_pixels_instead_of_skipping_them() {
    // Padding 0.5 is Klippt's default: the screen is drawn at 0.8x.
    let Some(spread) = column_spread(0.5, "reduced") else {
        return;
    };
    println!("0.8x grating spread: {spread}");
    assert!(
        spread < 150.0,
        "a 0.8x reduction beats through the 1px grating, spread {spread}: source pixels are skipped"
    );
}

#[test]
fn unscaled_video_keeps_its_one_pixel_lines() {
    let Some(spread) = column_spread(0.0, "unscaled") else {
        return;
    };
    println!("1:1 grating spread: {spread}");
    assert!(
        spread > 180.0,
        "a 1:1 video must stay unfiltered, but the 1px grating dropped to spread {spread}"
    );
}
