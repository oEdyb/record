//! Read-only planned composition from the same geometry function used by every renderer.
//! No media decoding, GPU allocation, filesystem access or pixel-visibility claim.

use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{config::Cfg, frame_geometry, regions, scene::Scene};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    scene: Value,
    clip_index: usize,
    source_time_sec: f64,
    screen_size: [u32; 2],
    webcam_size: Option<[u32; 2]>,
}

fn dimensions(size: [u32; 2]) -> bool {
    size.iter().all(|v| (1..=32768).contains(v))
}

fn bounded_numbers(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_some_and(|v| v.is_finite() && v.abs() <= 1e9),
        Value::Array(a) => a.iter().all(bounded_numbers),
        Value::Object(o) => o.values().all(bounded_numbers),
        _ => true,
    }
}

fn rectangle(dst: [f32; 4], output: [f32; 2]) -> Value {
    let [x, y, width, height] = [
        dst[0] * output[0],
        dst[1] * output[1],
        dst[2] * output[0],
        dst[3] * output[1],
    ];
    json!({"x": x, "y": y, "width": width, "height": height})
}

/// JSON request: scene, clipIndex, sourceTimeSec, screenSize [w,h], webcamSize [w,h]|null.
/// Missing auto-follow evidence returns unavailable, never a guessed manual focus.
pub fn evaluate_json(input: &str) -> Result<String> {
    ensure!(
        input.len() <= 16 * 1024 * 1024,
        "Geometry request exceeds 16 MiB"
    );
    let request: Request = serde_json::from_str(input)?;
    ensure!(
        bounded_numbers(&request.scene),
        "Scene contains an unsupported numeric magnitude"
    );
    let scene: Scene = serde_json::from_value(request.scene)?;
    let clip = scene
        .clips
        .get(request.clip_index)
        .ok_or_else(|| anyhow::anyhow!("clipIndex out of range"))?;
    ensure!(
        request.source_time_sec.is_finite()
            && request.source_time_sec >= clip.source_start_sec
            && request.source_time_sec <= clip.source_end_sec,
        "sourceTimeSec outside clip window"
    );
    ensure!(dimensions(request.screen_size), "Invalid screenSize");
    ensure!(
        dimensions([scene.output.width, scene.output.height]),
        "Invalid output dimensions"
    );
    let has_camera = frame_geometry::webcam_is_real(&clip.webcam_path, &clip.screen_path);
    if has_camera {
        ensure!(
            request.webcam_size.is_some_and(dimensions),
            "Real camera requires valid webcamSize"
        );
    }
    let scene = scene.for_clip_window(
        request.clip_index,
        clip.source_start_sec,
        clip.source_end_sec,
    );
    // Auto-follow can influence connected transitions outside a region's own interval.
    // Until the bridge carries the renderer's exact CursorTrack, refuse the whole clip.
    if scene
        .zoom_regions
        .iter()
        .any(|r| r.focus_mode.as_deref() == Some("auto"))
    {
        return Ok(json!({"status":"unavailable", "reason":"cursor-evidence-required", "scope":"planned-composition"}).to_string());
    }
    for rect in [scene.layout.screen_rect, scene.layout.webcam_rect]
        .into_iter()
        .flatten()
    {
        ensure!(
            rect.width > 0.0 && rect.height > 0.0,
            "Resolved layout dimensions must be positive"
        );
    }
    let output = [scene.output.width as f32, scene.output.height as f32];
    let screen = request.screen_size.map(|v| v as f32);
    let webcam = request.webcam_size.unwrap_or([1, 1]).map(|v| v as f32);
    let mut cfg = Cfg::c8();
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    let mut live = frame_geometry::live_params_from_scene(&scene);
    live.has_webcam = has_camera;
    let g = frame_geometry::plan_frame(&frame_geometry::FrameGeometryInput {
        render_px: output,
        screen_tex_px: screen,
        screen_visible_px: screen,
        webcam_visible_px: webcam,
        u_max: 1.0,
        v_max: 1.0,
        frame: 0.0,
        cfg: &cfg,
        live,
        scene: Some(&scene),
        cursor: None,
        timeline_t_override: Some(request.source_time_sec as f32),
    });
    let center = [
        (g.s_dst[0] + g.s_dst[2] * 0.5) * output[0],
        (g.s_dst[1] + g.s_dst[3] * 0.5) * output[1],
    ];
    let quad = regions::rotated_quad_corners_px(
        g.s_dst[2] * output[0],
        g.s_dst[3] * output[1],
        g.zoom_rotation,
    );
    let corners = quad.corners.map(|(x, y)| [x + center[0], y + center[1]]);
    ensure!(
        corners
            .iter()
            .flatten()
            .chain(g.s_dst.iter())
            .chain(g.w_dst.iter())
            .chain(g.cut.iter())
            .all(|v| v.is_finite()),
        "Compositor produced non-finite geometry"
    );
    Ok(json!({
        "status":"resolved", "scope":"planned-composition", "units":"output-pixels", "origin":"top-left",
        "clipIndex":request.clip_index, "sourceTimeSec":request.source_time_sec, "evaluatedSourceTimeSec":g.source_t,
        "output":{"width":scene.output.width,"height":scene.output.height},
        "screen":{"destination":rectangle(g.s_dst,output),"projectedCorners":corners,"radiusPx":g.s_radius,"sourceUv":g.cut,"rotation":g.zoom_rotation},
        "annotationContainer":rectangle(g.s_ann,output),
        "camera":if has_camera {json!({"destination":rectangle(g.w_dst,output),"radiusPx":g.w_radius,"baseShape":scene.layout.webcam_shape,"shapeFade":g.shape_fade})} else {Value::Null},
        "limitations":["No decoded-frame or media-availability verification", "Bounds exclude shadows, transparency and occlusion", "Source UV uses visible source dimensions, not backend texture padding", "Source time is evaluated at native f32 precision"]
    }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Value {
        json!({"clipIndex":0,"sourceTimeSec":2.0,"screenSize":[1920,1080],"webcamSize":[1280,720],"scene":{
            "clips":[{"screenPath":"/screen.mp4","webcamPath":"/camera.mp4","sourceStartSec":0.0,"sourceEndSec":10.0,"webcamOffsetSec":0.0}],
            "layout":{"preset":"picture-in-picture","webcamSize":0.25,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,"screenRect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"webcamRect":{"x":0.75,"y":0.75,"width":0.2,"height":0.2}},
            "effects":{"padding":0.0,"blur":false,"shadow":0.0,"roundnessFrac":0.0,"motionBlur":0.0},
            "background":{"kind":"color","color":"#000000"},"zoomRegions":[],"cameraFullscreenRegions":[],"speedRegions":[],"annotations":[],"cropByClip":[null],
            "cursor":{"show":false,"size":1.0,"smoothing":0.5,"motionBlur":0.0,"clickBounce":0.0,"clipToBounds":false,"theme":"default"},
            "output":{"width":1920,"height":1080,"fps":30.0}
        }})
    }

    fn query(value: &Value) -> Value {
        serde_json::from_str(&evaluate_json(&value.to_string()).expect("valid request"))
            .expect("JSON response")
    }

    #[test]
    fn base_matches_explicit_renderer_placement() {
        let result = query(&request());
        assert_eq!(
            result["screen"]["destination"],
            json!({"x":0.0,"y":0.0,"width":1920.0,"height":1080.0})
        );
        assert_eq!(result["scope"], "planned-composition");
    }

    #[test]
    fn portrait_uses_output_pixels() {
        let mut r = request();
        r["scene"]["output"] = json!({"width":1080,"height":1920,"fps":30.0});
        assert_eq!(query(&r)["camera"]["destination"]["x"], 810.0);
    }

    #[test]
    fn manual_zoom_changes_actual_screen_destination() {
        let mut r = request();
        r["scene"]["zoomRegions"] = json!([{"id":"z","clipIndex":0,"startSec":0.0,"endSec":8.0,"scale":2.0,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":null}]);
        assert!(
            query(&r)["screen"]["destination"]["width"]
                .as_f64()
                .expect("width")
                > 1920.0
        );
        r["scene"]["zoomRegions"][0]["focusMode"] = json!("auto");
        assert_eq!(query(&r)["reason"], "cursor-evidence-required");
    }

    #[test]
    fn full_camera_uses_renderer_region_evaluation() {
        let mut r = request();
        r["scene"]["cameraFullscreenRegions"] =
            json!([{"clipIndex":0,"startSec":0.0,"endSec":8.0}]);
        assert_eq!(
            query(&r)["camera"]["destination"],
            json!({"x":0.0,"y":0.0,"width":1920.0,"height":1080.0})
        );
    }

    #[test]
    fn invalid_requests_return_errors() {
        assert!(evaluate_json("invalid").is_err());
        let mut r = request();
        r["sourceTimeSec"] = json!(11.0);
        assert!(evaluate_json(&r.to_string()).is_err());
        r["sourceTimeSec"] = json!(2.0);
        r["screenSize"] = json!([0, 1080]);
        assert!(evaluate_json(&r.to_string()).is_err());
        r["screenSize"] = json!([1920, 1080]);
        r["webcamSize"] = Value::Null;
        assert!(evaluate_json(&r.to_string()).is_err());
    }

    #[test]
    fn tilted_screen_reports_projected_corners() {
        let mut r = request();
        r["scene"]["zoomRegions"] = json!([{"id":"z","clipIndex":0,"startSec":0.0,"endSec":8.0,"scale":2.0,"focusX":0.5,"focusY":0.5,"rotation":"iso"}]);
        let result = query(&r);
        let corners = &result["screen"]["projectedCorners"];
        assert_ne!(corners[0][1], corners[1][1]);
    }

    #[test]
    fn no_camera_does_not_invent_a_visible_layer() {
        let mut r = request();
        r["scene"]["clips"][0]["webcamPath"] = json!("");
        r["webcamSize"] = Value::Null;
        assert_eq!(query(&r)["camera"], Value::Null);
    }
}
