#![cfg(target_os = "macos")]

use openscreen_compositor::{d3d::Gpu, pipeline::Decoder};
use std::time::Instant;

#[test]
#[ignore = "real-media timing; run without concurrent playback or builds"]
fn compare_forward_decode_and_fresh_seek() {
    let source = std::env::var("OPENSCREEN_BENCH_SOURCE").expect("real source path");
    let start: f64 = std::env::var("OPENSCREEN_BENCH_START")
        .unwrap_or_else(|_| "3".into())
        .parse()
        .unwrap();
    let gpu = Gpu::create_auto(false).unwrap();
    for gap in [0.1, 0.3, 0.5, 1.0, 2.0] {
        for _ in 0..3 {
            unsafe {
                let mut forward = Decoder::open(&source, &gpu).unwrap();
                assert!(!forward.seek_to(start).unwrap().is_null());
                let timer = Instant::now();
                while forward.cur_time_sec() < start + gap {
                    assert!(!forward.next().unwrap().is_null());
                }
                let forward_ms = timer.elapsed().as_secs_f64() * 1000.0;
                let forward_pts = forward.cur_time_sec();
                let timer = Instant::now();
                let mut fresh = Decoder::open(&source, &gpu).unwrap();
                assert!(!fresh.seek_to(start + gap).unwrap().is_null());
                let fresh_ms = timer.elapsed().as_secs_f64() * 1000.0;
                assert!((fresh.cur_time_sec() - forward_pts).abs() < 1e-6);
                eprintln!("CUT_DECODE gap={gap} forward_ms={forward_ms:.3} open_seek_ms={fresh_ms:.3} pts={forward_pts:.6}");
            }
        }
    }
}
