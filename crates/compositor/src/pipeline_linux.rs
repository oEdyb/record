//! Pipeline Linux (PR #183) : decode software (`linux_decode::SwDecoder`) +
//! upload NV12-split (`linux_frames::CpuFrames`).
//!
//! Equivalent Linux de `pipeline_windows.rs` / `pipeline_macos.rs` : meme
//! surface publique consommee par le code partage (`Decoder`, `ClipSource`,
//! `ExportCodec`, `ExportParams`, `Stats`, `run_composited_multi`).
//!
//! **Export (WP6).** `run_composited_multi` encode + mux un MP4 **vidéo** :
//! encodeur SOFTWARE (`libopenh264` H264 / `libkvazaar` H265 -- les seuls du
//! build LGPL BtbN qui marchent sans device HW, VAAPI/Vulkan-encode = suivi),
//! la frame composée est relue en RGBA (ring de staging à 2, cf.
//! `Compositor::set_readback_depth`) puis convertie
//! YUV420P par `sws_scale`. La marche de timeline est PARTAGÉE
//! (`timeline_walk::walk_composited_timeline`) et le muxer passe par le shim C
//! `sn_fmt_set_pb` (comme Windows/macOS). **L'audio AAC n'est pas encore muxé**
//! (increment suivant : `audio.rs` + `AacEncoder` sont déjà partagés).
//!
//! **Le débit demandé n'est pas un contrat sur ce chemin.** `libopenh264` n'a pas
//! de contrôle de débit utilisable — la cause est en amont, pas ici, et elle est
//! documentée avec ce qui a été mesuré dans `VideoEncoder::tune_openh264`. À lire
//! avant de toucher au calcul de `bit_rate` ou d'ajouter une option d'encodage :
//! la moitié des réglages qui semblent évidents ont été essayés et ne font rien.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::ffi::CString;
use std::ptr;

use crate::audio::{
    build_audio_concat_plan, spool, AacEncoder, AudioMasteringSettings, AudioMasteringStats,
    DEFAULT_TARGET_LUFS, DEFAULT_TRUE_PEAK_CEILING_DBTP,
};
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use crate::linux_decode::SwDecoder;
use crate::linux_frames::CpuFrames;
use crate::timeline_walk::NextFrameTime;

/// `SWS_POINT` (plus proche voisin). Bindgen ne genere pas les `SWS_*` (macros),
/// valeur figee par l'ABI de libswscale -- comme `linux_frames::SWS_POINT`.
const SWS_POINT: i32 = 0x10;

/// Bilan d'un run d'export. Memes champs que `pipeline_macos::Stats`.
pub struct Stats {
    pub frames: u64,
    pub wall_s: f64,
    pub fps: f64,
    pub video_duration_s: f64,
    pub audio_mastering: AudioMasteringStats,
    pub encoder_name: String,
    pub encoder_hardware: bool,
    pub encoder_fallback: bool,
    pub decoder_path: String,
    pub compositor_backend: String,
}

/// Un clip de la timeline. Memes champs que `pipeline_macos::ClipSource`.
pub struct ClipSource {
    pub screen: String,
    pub webcam: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub webcam_offset_sec: f64,
    pub has_audio: bool,
    pub clean_microphone: Option<String>,
}

/// Codec cible. Memes variantes que `pipeline_macos::ExportCodec`.
#[derive(Clone, Copy, Debug)]
pub enum ExportCodec {
    H264,
    H265,
}

/// Params d'export. Memes champs que `pipeline_macos::ExportParams`.
pub struct ExportParams {
    pub width: u32,
    pub height: u32,
    pub fps: Option<u32>,
    pub codec: ExportCodec,
    pub bitrate: Option<u32>,
    pub normalize_audio: bool,
    pub even_volume: bool,
    pub target_lufs: f64,
    pub peak_ceiling_dbtp: f64,
}

impl Default for ExportParams {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: None,
            codec: ExportCodec::H264,
            bitrate: None,
            normalize_audio: true,
            even_volume: true,
            target_lufs: DEFAULT_TARGET_LUFS,
            peak_ceiling_dbtp: DEFAULT_TRUE_PEAK_CEILING_DBTP,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: i32 = 320;
    const H: i32 = 180;

    /// Sortie d'un encodage de test : les drapeaux « image clé » paquet par paquet,
    /// et l'extradata (le SPS, en Annex-B, puisque `try_open` pose
    /// `AV_CODEC_FLAG_GLOBAL_HEADER`).
    struct Encoded {
        keyframes: Vec<bool>,
        extradata: Vec<u8>,
        qmin: i32,
        qmax: i32,
        gop_size: i32,
        /// Primaires, transfert, matrice, plage de `codecpar`, ce que le muxer écrit.
        color: (i32, i32, i32, i32),
    }

    /// Encode `n` images 320x180 par le chemin RÉEL de l'export — `VideoEncoder::open`,
    /// donc `try_open`, donc toute la configuration que ce fichier pose. Un contexte
    /// monté à la main dans le test ne prouverait rien.
    ///
    /// Rend `None` quand l'encodeur n'est pas ouvrable (build ffmpeg sans
    /// `libopenh264`), pour que le test se saute proprement au lieu d'échouer sur
    /// l'environnement.
    fn encode(fps: i32, n: usize) -> Option<Encoded> {
        // Un dev qui force un autre encodeur ne doit pas voir ce test rougir : il ne
        // décrit que `libopenh264`.
        match std::env::var("OPENSCREEN_EXPORT_ENCODER") {
            Ok(name) if name != "libopenh264" => return None,
            _ => {}
        }
        let mut enc =
            unsafe { VideoEncoder::try_open("libopenh264", W, H, fps, 1_000_000) }.ok()?;

        let mut out = Encoded {
            keyframes: Vec::new(),
            extradata: Vec::new(),
            qmin: 0,
            qmax: 0,
            gop_size: 0,
            color: (0, 0, 0, 0),
        };
        unsafe {
            use crate::ffi::*;
            out.qmin = (*enc.ctx).qmin;
            out.qmax = (*enc.ctx).qmax;
            out.gop_size = (*enc.ctx).gop_size;
            let mut par = avcodec_parameters_alloc();
            avcodec_parameters_from_context(par, enc.ctx);
            out.color = (
                (*par).color_primaries as i32,
                (*par).color_trc as i32,
                (*par).color_space as i32,
                (*par).color_range as i32,
            );
            avcodec_parameters_free(&mut par);
            let (ptr, len) = ((*enc.ctx).extradata, (*enc.ctx).extradata_size);
            if !ptr.is_null() && len > 0 {
                out.extradata = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            }

            let pkt = av_packet_alloc();
            let mut rgba = vec![0u8; (W * H * 4) as usize];
            // Copie du pointeur AVANT la closure : la capturer via `enc.ctx`
            // emprunterait `enc` en lecture pour toute la durée du drain, et
            // `send_rgba` en veut un emprunt mutable juste après.
            let ectx = enc.ctx;
            let drain = |pkt: *mut AVPacket, out: &mut Encoded| loop {
                let r = avcodec_receive_packet(ectx, pkt);
                if r == AVERROR_EOF || r == AVERROR_EAGAIN {
                    return;
                }
                out.keyframes
                    .push((*pkt).flags & AV_PKT_FLAG_KEY as i32 != 0);
                av_packet_unref(pkt);
            };
            for i in 0..n {
                // Un dégradé qui glisse : de quoi donner du résidu à coder, sans quoi
                // l'encodeur travaille sur une image morte.
                for (p, px) in rgba.chunks_exact_mut(4).enumerate() {
                    px[0] = ((p + i * 7) % 251) as u8;
                    px[1] = ((p / W as usize + i * 3) % 253) as u8;
                    px[2] = (i * 5 % 257) as u8;
                    px[3] = 255;
                }
                enc.send_rgba(&rgba, W, H, i as i64).expect("send_rgba");
                drain(pkt, &mut out);
            }
            enc.flush().expect("flush");
            drain(pkt, &mut out);
            let mut pkt = pkt;
            av_packet_free(&mut pkt);
        }
        Some(out)
    }

    /// `profile_idc` porté par le SPS de l'extradata (Annex-B : `00 00 00 01 67 <idc>`).
    fn profile_idc(extradata: &[u8]) -> Option<u8> {
        extradata
            .windows(6)
            .find(|w| w[..4] == [0, 0, 0, 1] && w[4] & 0x1f == 7)
            .map(|w| w[5])
    }

    /// L'export doit porter des images clés PÉRIODIQUES.
    ///
    /// Sans `(*ctx).gop_size`, le wrapper ffmpeg de `libopenh264` pose `g = -1` dans
    /// ses `FFCodecDefault`, openh264 reçoit `uiIntraPeriod = 0` et n'émet qu'UNE
    /// image clé pour tout le fichier — mesuré 1 image I sur 300 avant ce correctif.
    /// Le MP4 reste lisible, mais tout seek redécode depuis le début et un paquet
    /// abîmé emporte le reste. C'est le test qui aurait attrapé ça.
    /// Le MP4 dit sa matrice : BT.601, celle de la conversion `sws_getContext`.
    /// Sans étiquette un lecteur qui suppose BT.709 décale les couleurs saturées.
    #[test]
    fn l_export_h264_porte_son_etiquette_couleur() {
        let Some(enc) = encode(10, 5) else {
            eprintln!("libopenh264 indisponible — test sauté");
            return;
        };
        use crate::ffi::*;
        assert_eq!(
            enc.color,
            (
                AVColorPrimaries::AVCOL_PRI_BT709 as i32,
                AVColorTransferCharacteristic::AVCOL_TRC_BT709 as i32,
                AVColorSpace::AVCOL_SPC_SMPTE170M as i32,
                AVColorRange::AVCOL_RANGE_MPEG as i32,
            )
        );
    }

    #[test]
    fn l_export_h264_emet_des_images_cles_periodiques() {
        let Some(enc) = encode(10, 45) else {
            eprintln!("libopenh264 indisponible — test sauté");
            return;
        };
        assert_eq!(enc.gop_size, 20, "gop_size doit valoir fps * 2");
        let keys: Vec<usize> = enc
            .keyframes
            .iter()
            .enumerate()
            .filter(|(_, k)| **k)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            keys,
            vec![0, 20, 40],
            "images clés attendues toutes les {} frames, obtenu {keys:?} sur {} paquets",
            enc.gop_size,
            enc.keyframes.len()
        );
    }

    /// `tune_openh264` doit atteindre l'encodeur : fenêtre de QP explicite (sans quoi
    /// openh264 remplace la sienne par (12, 42), cf. la doc de la fonction) et profil
    /// High dans le SPS (sans quoi on expédie du Constrained Baseline en CAVLC).
    #[test]
    fn l_export_h264_configure_openh264() {
        let Some(enc) = encode(10, 3) else {
            eprintln!("libopenh264 indisponible — test sauté");
            return;
        };
        assert_eq!((enc.qmin, enc.qmax), (1, 51), "fenêtre de QP non transmise");
        assert_eq!(
            profile_idc(&enc.extradata),
            Some(100),
            "le SPS doit annoncer le profil High (100) ; 66 = Constrained Baseline, \
             le défaut du wrapper. extradata={:02x?}",
            &enc.extradata[..enc.extradata.len().min(12)]
        );
    }
}

/// Decodeur Linux : software decode (`SwDecoder`) + upload NV12-split
/// (`CpuFrames`). Meme surface que `pipeline_macos::Decoder`
/// (`open`/`seek_to`/`next`/`cur_frame`/`cur_time_sec`/`fps`) pour que `live.rs`
/// le pilote sans connaitre la plateforme.
pub struct Decoder {
    sw: SwDecoder,
    frames: CpuFrames,
    cur: *mut AVFrame,
    /// Index de la prochaine frame a decoder (sequentiel).
    next_idx: u32,
    fps: f64,
}

// SAFETY : les pointeurs FFI n'ont pas d'affinite thread ; le caller uphold la
// regle « un thread a la fois » (idem `pipeline_macos::Decoder`).
unsafe impl Send for Decoder {}

impl Decoder {
    pub(crate) fn uses_hardware(&self) -> bool {
        false
    }

    pub fn open(path: &str, gpu: &Gpu) -> Result<Decoder> {
        let sw = SwDecoder::open(path)?;
        let fps = sw.fps();
        let frames = CpuFrames::new(gpu)?;
        Ok(Decoder {
            sw,
            frames,
            cur: ptr::null_mut(),
            next_idx: 0,
            fps,
        })
    }

    /// Decode la frame a `seconds` (seek), la presente en carrier, la retourne.
    pub unsafe fn seek_to(&mut self, seconds: f64) -> Result<*mut AVFrame> {
        let idx = (seconds.max(0.0) * self.fps).round() as u32;
        self.decode_present(idx)
    }

    /// Decode la frame SEQUENTIELLE suivante — pompage `next_frame`, PAS de seek.
    /// La frame rendue appartient au decodeur (valide jusqu'au prochain appel),
    /// donc elle ne se libere pas ici, contrairement au chemin `decode_at`.
    pub unsafe fn next(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.next_frame()?;
        if raw.is_null() {
            self.cur = ptr::null_mut();
            return Ok(ptr::null_mut());
        }
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    unsafe fn decode_present(&mut self, idx: u32) -> Result<*mut AVFrame> {
        let raw = self.sw.decode_at(idx)?;
        let carrier = self.frames.present(raw)?;
        SwDecoder::free_frame(raw);
        self.cur = carrier;
        self.next_idx = idx + 1;
        Ok(carrier)
    }

    /// Décode la prochaine frame dans le buffer de lookahead du décodeur sous-jacent et
    /// renvoie son temps, sans la présenter (donc sans toucher `self.cur`).
    /// Cf. `pipeline_macos::Decoder::peek_next_time_sec` pour la sémantique "hold".
    pub(crate) unsafe fn peek_next_time_sec(&mut self) -> Result<NextFrameTime> {
        self.sw.peek_next_time_sec()
    }

    /// Promeut la frame de lookahead au rang de frame courante ET la présente (upload NV12
    /// vers la texture carrier), contrairement au chemin macOS/Windows où la promotion est
    /// un pur échange de pointeurs — ici la présentation est le pas qui manque.
    pub(crate) unsafe fn commit_peek(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.commit_peek()?;
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    pub unsafe fn cur_frame(&self) -> *mut AVFrame {
        self.cur
    }

    /// Temps source (secondes) de la frame courante — pts REEL du decodeur, avec
    /// repli sur le compteur d'index si le flux ne porte pas de pts.
    pub unsafe fn cur_time_sec(&self) -> f64 {
        if let Some(t) = self.sw.cur_time_sec() {
            return t.max(0.0);
        }
        if self.next_idx == 0 || self.fps <= 0.0 {
            0.0
        } else {
            (self.next_idx as f64 - 1.0) / self.fps
        }
    }

    pub unsafe fn fps(&self) -> f64 {
        self.fps
    }

    /// Duree du flux (secondes). Pendant de
    /// `pipeline_macos::Decoder::available_duration_sec` ; consomme par
    /// `timeline_walk` pour borner la marche d'export.
    pub unsafe fn available_duration_sec(&self) -> Option<f64> {
        self.sw.duration_sec()
    }
}

/// Encodeur video NVENC, avec repli LGPL (`libopenh264` / `libkvazaar`).
/// Pas de zero-copy : la frame composee est relue RGBA par
/// l'appelant puis convertie YUV420P par `sws_scale`. Surface
/// `open`/`send_rgba`/`flush` alignee sur le chemin software de
/// `pipeline_macos::VideoEncoder`.
pub struct VideoEncoder {
    ctx: *mut crate::ffi::AVCodecContext,
    /// AVFrame YUV420P envoyee a l'encodeur.
    sw: *mut AVFrame,
    /// RGBA (sortie compositeur) -> YUV420P. Cree paresseusement (dims du readback).
    sws: *mut crate::ffi::SwsContext,
    w: i32,
    h: i32,
    name: String,
    hardware: bool,
    fallback: bool,
}

// SAFETY : pointeurs FFI sans affinite thread ; caller mono-thread (idem Decoder).
unsafe impl Send for VideoEncoder {}

impl VideoEncoder {
    /// Encodeurs candidats du build LGPL, par codec. La premiere qui
    /// ouvre gagne ; `OPENSCREEN_EXPORT_ENCODER=<name>` force un choix.
    fn candidate_names(codec: &ExportCodec) -> &'static [&'static str] {
        match codec {
            ExportCodec::H264 => &["h264_nvenc", "libopenh264"],
            ExportCodec::H265 => &["hevc_nvenc", "libkvazaar"],
        }
    }

    pub fn open(
        codec: &ExportCodec,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
    ) -> Result<VideoEncoder> {
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let mut refused: Vec<String> = Vec::new();
        // Liste par defaut, plus l'encodeur force s'il n'y figure pas (ex. h264_vaapi).
        let defaults = Self::candidate_names(codec);
        let extra: Vec<&str> = forced
            .as_deref()
            .filter(|f| !defaults.contains(f))
            .into_iter()
            .collect();
        for &name in defaults.iter().chain(extra.iter()) {
            if forced.as_deref().is_some_and(|f| f != name) {
                continue;
            }
            match unsafe { Self::try_open(name, w, h, fps, bit_rate) } {
                Ok(mut enc) => {
                    enc.fallback = !refused.is_empty();
                    eprintln!("[pipeline] encodeur video : {name} (hardware={}, fallback={}, CPU YUV420P input)", enc.hardware, enc.fallback);
                    return Ok(enc);
                }
                Err(e) => refused.push(format!("{name}: {e}")),
            }
        }
        match forced {
            Some(name) => bail!(
                "OPENSCREEN_EXPORT_ENCODER={name} inutilisable : {}",
                refused.join(" ; ")
            ),
            None => bail!("aucun encodeur video utilisable : {}", refused.join(" ; ")),
        }
    }

    unsafe fn try_open(
        name: &str,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
    ) -> Result<VideoEncoder> {
        use crate::ffi::*;
        let cname = CString::new(name)?;
        let enc = avcodec_find_encoder_by_name(cname.as_ptr());
        if enc.is_null() {
            bail!("absent de ce build ffmpeg");
        }
        let mut ctx = avcodec_alloc_context3(enc);
        if ctx.is_null() {
            bail!("avcodec_alloc_context3");
        }
        (*ctx).width = w;
        (*ctx).height = h;
        (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_YUV420P;
        (*ctx).time_base = AVRational { num: 1, den: fps };
        (*ctx).framerate = AVRational { num: fps, den: 1 };
        (*ctx).bit_rate = bit_rate;
        (*ctx).gop_size = (fps * 2).max(1);
        Self::tune_openh264(ctx, name);
        // MP4 : header global dans l'extradata (pas par-paquet).
        (*ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        // `sws_getContext` RGBA -> YUV420P sans `sws_setColorspaceDetails` : BT.601 limité.
        tag_export_color(ctx, AVColorSpace::AVCOL_SPC_SMPTE170M);
        if let Err(e) = averr(
            avcodec_open2(ctx, enc, ptr::null_mut()),
            "avcodec_open2(enc)",
        ) {
            avcodec_free_context(&mut ctx);
            return Err(e);
        }
        match alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_YUV420P, w, h) {
            Ok(sw) => Ok(VideoEncoder {
                ctx,
                sw,
                sws: ptr::null_mut(),
                w,
                h,
                name: name.to_owned(),
                hardware: !matches!(name, "libopenh264" | "libkvazaar"),
                fallback: false,
            }),
            Err(e) => {
                avcodec_free_context(&mut ctx);
                Err(e)
            }
        }
    }

    /// Réglages propres à `libopenh264`, à poser AVANT `avcodec_open2` (openh264 fige
    /// ses `SEncParamExt` à l'ouverture). No-op pour tout autre encodeur.
    ///
    /// **`libopenh264` n'a pas de contrôle de débit utilisable, et ce n'est pas
    /// réparable ici** (issue #572). Le wrapper ffmpeg laisse `bEnableFrameSkip = 0`,
    /// et openh264 le dit lui-même à l'ouverture :
    ///
    /// > `bEnableFrameSkip = 0, bitrate can't be controlled for RC_QUALITY_MODE,`
    /// > `RC_BITRATE_MODE and RC_TIMESTAMP_MODE without enabling skip frame.`
    ///
    /// La seule option qui rétablit un vrai plafond est `allow_skip_frames`, et elle
    /// le paie en frames jetées — mesuré 3 frames sur 120 conservées sur du contenu
    /// incompressible. Inacceptable pour un export, donc on n'y touche pas. Sont
    /// aussi des impasses vérifiées à la mesure : `rc_max_rate` et `rc_buffer_size`
    /// (que ce wrapper ne lit pas, ou dont openh264 ne se sert que dans le chemin
    /// frame-skip), `rc_mode`, `max_nal_size` et `level`.
    ///
    /// Restent deux réglages qui, eux, se mesurent :
    ///
    /// 1. **Ouvrir la fenêtre de QP.** Le wrapper ne transmet `iMinQp`/`iMaxQp` que
    ///    si `qmin`/`qmax` sont >= 0, et ses `FFCodecDefault` les posent à -1.
    ///    openh264 part alors sur ses propres défauts (0, 51) — puis sa
    ///    `ParamValidation()` juge `iMinQp = 0` invalide et REMPLACE toute la fenêtre
    ///    par (12, 42) (`GOM_MIN_QP_MODE`, `MAX_LOW_BR_QP`). Un `qmin` >= 1 évite la
    ///    substitution et rend le QP 51 atteignable. La borne basse, elle, reste
    ///    clampée à 12 quoi qu'on demande, donc `qmin = 1` ne fait qu'éviter le piège.
    ///
    ///    L'intérêt premier est de ne plus subir une fenêtre qu'on n'a pas choisie :
    ///    (12, 42) n'est pas une décision, c'est ce qu'openh264 substitue en silence.
    ///
    ///    Sur les quatre classes de contenu réel essayées, le changement est INERTE —
    ///    sortie identique à l'octet sur un écran statique, sur une capture dense, sur
    ///    du mixte (UI + fenêtre vidéo sur un tiers de l'image) et sur de la webcam
    ///    plein cadre. Sur ces mêmes clips le débit demandé est d'ailleurs plutôt bien
    ///    suivi (mixte 1080p30 : 1 -> 0,98, 2 -> 1,94, 4 -> 3,67 Mbps ; webcam :
    ///    2 -> 1,99, 8 -> 7,51), ce qui vaut d'être su avant de conclure du titre de
    ///    #572 que l'export Linux serait à l'abandon.
    ///
    ///    La fenêtre ne mord que sur du contenu que l'encodeur ne sait pas comprimer,
    ///    et là elle échange de la qualité contre de la taille : sur 120 frames de
    ///    bruit incompressible 720p30 à 2 Mbps demandés, 113,2 -> 65,5 Mbps mais
    ///    SSIM 0,949 -> 0,652. C'est le bon sens de l'échange pour un export (le
    ///    fichier restait 56x au-dessus de la cible), mais si on le regrettait,
    ///    `qmin = 12 ; qmax = 42` fige exactement le comportement d'avant tout en
    ///    gardant le réglage explicite.
    /// 2. **Profil High.** Par défaut ce wrapper produit du Constrained Baseline en
    ///    CAVLC (`profile_idc = 66`, `entropy_coding_mode_flag = 0`). Le profil High
    ///    active CABAC. Mesuré à qualité égale sur un vrai enregistrement 1080p60
    ///    (VMAF 96,2 dans les deux cas) : -3,8 % de débit sur du contenu dense,
    ///    -8,0 % sur un écran statique.
    ///
    /// Ce qu'il reste de cassé après ça, et qui ne se règle pas depuis l'application :
    /// le débit demandé n'est qu'une entrée faible d'un modèle complexité -> QP, borné
    /// à [12, 51]. Sur un écran statique l'encodeur se colle à QP 12 et ne dépense pas
    /// plus, quel que soit le `bit_rate` (mesuré 0,68 Mbps pour 8 comme pour 40 Mbps
    /// demandés) ; sur du contenu qu'il ne sait pas comprimer il dépasse la cible sans
    /// borne. Le mode `SCREEN_CONTENT_REAL_TIME` d'openh264 — celui qui conviendrait à
    /// un enregistreur d'écran — n'est atteignable par aucune option ffmpeg.
    /// Suivi en amont : cisco/openh264#3259 (fermé sans correctif).
    unsafe fn tune_openh264(ctx: *mut crate::ffi::AVCodecContext, name: &str) {
        use crate::ffi::*;
        if name != "libopenh264" {
            return;
        }
        (*ctx).qmin = 1;
        (*ctx).qmax = 51;
        // L'encodeur expose AUSSI `profile` en option privée, mais le wrapper lit
        // `avctx->profile` quand la privée vaut `AV_PROFILE_UNKNOWN` (son défaut,
        // -99). Les deux chemins produisent le même SPS — vérifié, `profile_idc`
        // passe à 100 dans les deux cas — donc on prend le champ : il est typé,
        // vérifié à la compilation, et n'a pas besoin d'une `CString` ni d'une
        // branche d'erreur, contrairement à `av_opt_set` sur `priv_data`.
        (*ctx).profile = AV_PROFILE_H264_HIGH as i32;
    }

    /// Envoie une frame composee DEJA RELUE (RGBA) a l'encodeur, en YUV420P.
    ///
    /// La relecture est sortie d'ici : avec la ring de staging, la frame rendue
    /// par `readback_submit` n'est pas celle qui vient d'etre composee mais la
    /// precedente, donc l'appelant doit apparier lui-meme la frame et son pts
    /// (cf. `run_composited_multi`).
    pub unsafe fn send_rgba(&mut self, rgba: &[u8], rw: i32, rh: i32, pts: i64) -> Result<()> {
        use crate::ffi::*;
        if self.sws.is_null() {
            self.sws = sws_getContext(
                rw,
                rh,
                AVPixelFormat::AV_PIX_FMT_RGBA,
                self.w,
                self.h,
                AVPixelFormat::AV_PIX_FMT_YUV420P,
                // POINT : le compositeur est dimensionne a la sortie -> pas de
                // mise a l'echelle, donc echantillonnage exact (cf. mac_frames).
                SWS_POINT,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            if self.sws.is_null() {
                bail!(
                    "sws_getContext {rw}x{rh} RGBA -> {}x{} YUV420P",
                    self.w,
                    self.h
                );
            }
        }
        averr(av_frame_make_writable(self.sw), "make_writable")?;
        // RGBA est un plan unique : data[0] + stride rw*4, les autres nuls.
        let src_data: [*const u8; 4] = [rgba.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
        let src_stride: [i32; 4] = [rw * 4, 0, 0, 0];
        let converted = sws_scale(
            self.sws,
            src_data.as_ptr(),
            src_stride.as_ptr(),
            0,
            rh,
            (*self.sw).data.as_ptr() as *const *mut u8,
            (*self.sw).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale RGBA->YUV420P : {converted} lignes");
        }
        (*self.sw).pts = pts;
        averr(avcodec_send_frame(self.ctx, self.sw), "send_frame")
    }

    /// Flush : une frame nulle finalise le bitstream de l'encodeur.
    pub unsafe fn flush(&mut self) -> Result<()> {
        crate::ffi::averr(
            crate::ffi::avcodec_send_frame(self.ctx, ptr::null_mut()),
            "send_frame_flush",
        )
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::avcodec_free_context(&mut self.ctx);
            if !self.sw.is_null() {
                crate::ffi::av_frame_free(&mut self.sw);
            }
            if !self.sws.is_null() {
                crate::ffi::sws_freeContext(self.sws);
            }
        }
    }
}

/// Alloue une AVFrame systeme au format demande. Symetrique de
/// `pipeline_macos::alloc_sw_frame`.
unsafe fn alloc_sw_frame(
    pix_fmt: crate::ffi::AVPixelFormat::Type,
    w: i32,
    h: i32,
) -> Result<*mut AVFrame> {
    let mut frame = crate::ffi::av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (encodeur)");
    }
    (*frame).format = pix_fmt as i32;
    (*frame).width = w;
    (*frame).height = h;
    if crate::ffi::av_frame_get_buffer(frame, 32) < 0 {
        crate::ffi::av_frame_free(&mut frame);
        bail!("av_frame_get_buffer {w}x{h} pix_fmt={pix_fmt}");
    }
    Ok(frame)
}

/// Draine les paquets de l'encodeur vers le muxer. Symetrique de
/// `pipeline_macos::drain_encoder`.
unsafe fn drain_encoder(
    ectx: *mut crate::ffi::AVCodecContext,
    octx: *mut crate::ffi::AVFormatContext,
    ostream: *mut crate::ffi::AVStream,
    opkt: *mut crate::ffi::AVPacket,
) -> Result<()> {
    use crate::ffi::*;
    loop {
        let r = avcodec_receive_packet(ectx, opkt);
        if r == AVERROR_EOF || r == AVERROR_EAGAIN {
            return Ok(());
        }
        averr(r, "receive_packet")?;
        // One CFR encoder tick keeps MP4 from discarding the final sample
        // when NVENC leaves its packet duration unknown.
        if (*opkt).duration <= 0 {
            (*opkt).duration = 1;
        }
        av_packet_rescale_ts(opkt, (*ectx).time_base, (*ostream).time_base);
        averr(
            av_interleaved_write_frame(octx, opkt),
            "interleaved_write_frame",
        )?;
        av_packet_unref(opkt);
    }
}

/// Export multiclip VIDEO (WP6). Encode software + mux MP4. Audio AAC = suivi
/// (`audio.rs`/`AacEncoder` partages, il ne manque que le branchement du 2e flux
/// + l'assemblage PCM par clip, cf. `pipeline_macos::run_composited_multi`).
///
/// La marche de timeline est PARTAGEE (`walk_composited_timeline`) : elle compose
/// chaque frame de sortie (vitesse/fenetrage/curseur inclus) puis appelle
/// `on_frame(n)`, ou on relit + encode + draine.
pub fn run_composited_multi(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &crate::compositor::Compositor,
    cfg: &Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(crate::ExportProgress) -> Result<()>,
) -> Result<Stats> {
    if clips.is_empty() {
        bail!("run_composited_multi: aucun clip a exporter");
    }
    let (out_w, out_h) = (params.width, params.height);
    let out_fps = params.fps.unwrap_or(30) as i32;
    let bit_rate = crate::export_settings::resolve_video_bitrate(out_w, out_h, params.bitrate);
    eprintln!(
        "[pipeline] export video: {}x{} @ {} fps, bitrate={} bits/s",
        out_w, out_h, out_fps, bit_rate
    );
    let t0 = std::time::Instant::now();

    let mut enc = VideoEncoder::open(&params.codec, out_w as i32, out_h as i32, out_fps, bit_rate)?;
    let ectx = enc.ctx;

    let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
    let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();

    // ---- muxer MP4 (flux video + flux AAC) ----
    let outc = CString::new(out)?;
    let mut mux = crate::export_settings::MuxOutputGuard::new();
    let ostream;
    let mut audio_encoder;
    let audio_mastering;
    unsafe {
        crate::ffi::averr(
            crate::ffi::avformat_alloc_output_context2(
                mux.context_mut(),
                ptr::null(),
                ptr::null(),
                outc.as_ptr(),
            ),
            "alloc_output_context2",
        )?;
        let octx = mux.context();
        if octx.is_null() {
            bail!("avformat_alloc_output_context2 returned null");
        }
        ostream = crate::ffi::avformat_new_stream(octx, ptr::null());
        if ostream.is_null() {
            bail!("avformat_new_stream");
        }
        crate::ffi::averr(
            crate::ffi::avcodec_parameters_from_context((*ostream).codecpar, ectx),
            "params_from_ctx",
        )?;
        (*ostream).time_base = (*ectx).time_base;
        crate::ffi::averr(
            crate::ffi::avio_open(
                mux.io_mut(),
                outc.as_ptr(),
                crate::ffi::AVIO_FLAG_WRITE as i32,
            ),
            "avio_open",
        )?;
        mux.bind_io();
        // Le flux AAC doit exister AVANT l'en-tete (le muxer y fige sa table de flux).
        // Meme si aucun clip n'a d'audio, on ecrit une piste silencieuse -- parite
        // avec Windows/macOS, qui muxent toujours l'AAC.
        audio_encoder = AacEncoder::open(octx)?;
        crate::export_settings::write_mp4_header(octx)?;
        *mux.packet_mut() = crate::ffi::av_packet_alloc();
    }
    let octx = mux.context();
    let opkt = mux.packet();
    if opkt.is_null() {
        bail!("av_packet_alloc (export packet)");
    }

    // Un PCM par clip, assemble apres la marche video (elle seule dit combien de
    // frames chaque clip a produit, donc combien d'audio lui revient).
    let mut audio_windows = vec![None; clips.len()];
    let mut clip_frame_counts: Vec<u64> = vec![0; clips.len()];

    let scene = comp.scene_snapshot();
    // Ring de staging a 2 : l'export ne veut que du debit, une frame de latence
    // ne se voit pas dans un fichier. Voir `Compositor::set_readback_depth` pour
    // la raison pour laquelle la preview, elle, reste a 1.
    comp.set_readback_depth(2)?;
    // pts d'encodage : DECOUPLE de l'index de marche `n`, puisque la frame
    // recoltee a l'iteration n est celle composee a n-1. Il reste contigu (les
    // frames sortent de la ring dans l'ordre de composition), donc le fichier
    // produit est identique a celui du chemin synchrone.
    let mut encoded_pts: i64 = 0;
    let frames = unsafe {
        crate::timeline_walk::walk_composited_timeline(
            clips,
            gpu,
            comp,
            cfg,
            out_fps,
            &scene,
            &mut screen_decs,
            &mut webcam_decs,
            &mut |n| {
                // Soumet la copie de la frame n SANS l'attendre et recolte la
                // precedente : c'est tout le pipelining. Pendant que le CPU
                // passe ses ~12,6 ms dans sws_scale + avcodec_send_frame sur la
                // frame n-1, le GPU finit la composition et la copie de n.
                if let Some((rw, rh, rgba)) = comp.readback_submit()? {
                    enc.send_rgba(&rgba, rw as i32, rh as i32, encoded_pts)?;
                    encoded_pts += 1;
                    drain_encoder(ectx, octx, ostream, opkt)?;
                }
                // Progression = frames COMPOSEES (inchangee) : la barre ne doit
                // pas reculer d'une frame parce que l'encodage a un tour de
                // retard.
                progress(crate::ExportProgress::Frame(n + 1))?;
                Ok(())
            },
            &mut |clip_index, source_end_sec, frames_in_clip, speed_segments| {
                clip_frame_counts[clip_index] = frames_in_clip;
                let clip = &clips[clip_index];
                if clip.has_audio && frames_in_clip > 0 {
                    audio_windows[clip_index] = Some((source_end_sec, speed_segments.to_vec()));
                }
                Ok(())
            },
        )?
        .frames
    };

    unsafe {
        // Drain de la ring AVANT le flush de l'encodeur : les `depth - 1`
        // dernieres copies sont encore en vol, et sans ce drain la derniere
        // frame composee ne serait jamais encodee (video amputee d'une frame).
        while let Some((rw, rh, rgba)) = comp.readback_take()? {
            enc.send_rgba(&rgba, rw as i32, rh as i32, encoded_pts)?;
            encoded_pts += 1;
            drain_encoder(ectx, octx, ostream, opkt)?;
        }
        // Le compositeur peut survivre a l'export (l'appelant le possede) : on
        // lui rend sa profondeur par defaut plutot que de lui laisser une ring
        // a 2 et le buffer de 8 Mo qui va avec.
        comp.set_readback_depth(1)?;
        enc.flush()?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        progress(crate::ExportProgress::VideoFlushed(frames))?;
        // Audio : le plan part des frames REELLEMENT produites par clip (un clip
        // raccourci voit son audio raccourci d'autant), puis un seul encode AAC.
        let declared_audio: Vec<bool> = clips.iter().map(|c| c.has_audio).collect();
        let plan = build_audio_concat_plan(&clip_frame_counts, &declared_audio, out_fps as f64);
        let mut check = || progress(crate::ExportProgress::AudioEncoding(frames));
        let mut clip_audio = Vec::with_capacity(clips.len());
        for (clip, window) in clips.iter().zip(audio_windows) {
            check()?;
            clip_audio.push(match window {
                Some((end, segments)) => spool::decode(
                    &clip.screen,
                    clip.clean_microphone.as_deref(),
                    clip.source_start_sec,
                    end,
                    &segments,
                    out_fps as f64,
                    &mut check,
                )?,
                None => None,
            });
        }
        let mut assembled_audio =
            spool::assemble(clip_audio, &plan, params.even_volume, &mut check)?;
        if let Some(scene) = scene.as_ref() {
            crate::audio::overlays::mix_into_program(
                &mut assembled_audio,
                &scene.audio_overlays,
                &mut check,
            )?;
        }
        audio_mastering = spool::master(
            &mut assembled_audio,
            AudioMasteringSettings::new(
                params.normalize_audio,
                params.target_lufs,
                params.peak_ceiling_dbtp,
            ),
            &mut check,
        )?;
        spool::encode(&mut assembled_audio, &mut audio_encoder, octx, &mut check)?;
        progress(crate::ExportProgress::AudioFlushed(frames))?;
        progress(crate::ExportProgress::Trailer(frames))?;
        crate::ffi::averr(crate::ffi::av_write_trailer(octx), "write_trailer")?;
    }

    let wall_s = t0.elapsed().as_secs_f64();
    Ok(Stats {
        frames,
        wall_s,
        fps: if wall_s > 0.0 {
            frames as f64 / wall_s
        } else {
            0.0
        },
        video_duration_s: frames as f64 / out_fps as f64,
        audio_mastering,
        encoder_name: enc.name.clone(),
        encoder_hardware: enc.hardware,
        encoder_fallback: enc.fallback,
        decoder_path: "software".to_owned(),
        compositor_backend: "vulkan".to_owned(),
    })
}
