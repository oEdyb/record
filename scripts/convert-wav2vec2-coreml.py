#!/usr/bin/env python3
"""Convert torchaudio WAV2VEC2_ASR_BASE_960H to a Core ML package for Klippt's forced aligner.

Run with the retake-cutter uv environment (nothing is installed globally):

    cd /Users/olle/dev/retake-cutter && uv run --with coremltools python \
        /Users/olle/dev/screenrec-wt-cleancut/scripts/convert-wav2vec2-coreml.py

Output directory (default ~/Library/Application Support/Klippt/stt-models/wav2vec2-base-960h-coreml/):
  wav2vec2-base-960h.mlpackage   fp16 weights, flexible input length
  labels.json                    {"labels": [...], "blank": 0, "separator": "|", "sampleRate": 16000, ...}

Model contract:
  input   "audio"     float32 [1, N], 16 kHz mono, N in [1600, 336000] (0.1 s .. 21 s). Not normalised
                      (this bundle does not normalise), and not padded: the first conv layer uses a
                      group norm over time, so zero padding would change the result.
  output  "emission"  float32 [1, T, 29] log-softmax over the labels, T = floor((N - 400) / 320) + 1.

The weights come from the torchaudio checkpoint already cached in ~/.cache/torch/hub/checkpoints.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import coremltools as ct
import numpy as np
import torch
import torchaudio

SAMPLE_RATE = 16_000
MIN_SAMPLES = 1_600  # 0.1 s, the shortest chunk the Python reference aligns
MAX_SAMPLES = 336_000  # 21 s: WINDOW_MAX 20 s plus the 0.4 s margins on each side
DEFAULT_OUT = Path.home() / "Library/Application Support/Klippt/stt-models/wav2vec2-base-960h-coreml"
PACKAGE_NAME = "wav2vec2-base-960h.mlpackage"


class Emissions(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, audio: torch.Tensor) -> torch.Tensor:
        logits, _ = self.model(audio)
        return torch.log_softmax(logits, dim=-1)


def frames_for(samples: int) -> int:
    return (samples - 400) // 320 + 1


def convert(out_dir: Path, precision: str) -> Path:
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    assert bundle.sample_rate == SAMPLE_RATE
    model = bundle.get_model().eval()
    wrapper = Emissions(model).eval()
    example = torch.randn(1, 8 * SAMPLE_RATE) * 0.1
    with torch.inference_mode():
        traced = torch.jit.trace(wrapper, example, check_trace=False)

    if precision == "fp32":
        compute_precision = ct.precision.FLOAT32
    elif precision == "fp16":
        compute_precision = ct.precision.FLOAT16
    else:
        # fp16 everywhere except the output projection and the log-softmax, which stay fp32 so the
        # tail of the log-probabilities keeps its precision.
        def keep_fp16(op) -> bool:
            if op.op_type in {"softmax", "log", "reduce_log_sum_exp", "reduce_max"}:
                return False
            if op.op_type == "linear" and op.outputs[0].shape[-1] == 29:
                return False
            return True

        compute_precision = ct.transform.FP16ComputePrecision(op_selector=keep_fp16)

    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(
                name="audio",
                shape=ct.Shape(shape=(1, ct.RangeDim(MIN_SAMPLES, MAX_SAMPLES, default=8 * SAMPLE_RATE))),
                dtype=np.float32,
            )
        ],
        outputs=[ct.TensorType(name="emission", dtype=np.float32)],
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS14,
        # The Neural Engine compiler stalls for minutes on a flexible-length transformer; run on CPU and GPU.
        compute_units=ct.ComputeUnit.CPU_AND_GPU,
        compute_precision=compute_precision,
    )
    mlmodel.short_description = "torchaudio WAV2VEC2_ASR_BASE_960H CTC emissions (log-softmax) for forced alignment"
    mlmodel.user_defined_metadata["labels"] = "".join(bundle.get_labels())
    out_dir.mkdir(parents=True, exist_ok=True)
    package = out_dir / PACKAGE_NAME
    if package.exists():
        import shutil

        shutil.rmtree(package)
    mlmodel.save(str(package))

    labels = list(bundle.get_labels())
    (out_dir / "labels.json").write_text(
        json.dumps(
            {
                "model": "WAV2VEC2_ASR_BASE_960H",
                "labels": labels,
                "blank": labels.index("-"),
                "separator": "|",
                "sampleRate": SAMPLE_RATE,
                "minSamples": MIN_SAMPLES,
                "maxSamples": MAX_SAMPLES,
                "frameSamples": 320,
                "receptiveFieldSamples": 400,
                "input": "audio",
                "output": "emission",
            },
            indent=2,
        )
        + "\n"
    )
    return package


def check(package: Path) -> float:
    """Compare Core ML emissions with torch on real speech windows of different lengths."""
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model().eval()
    ml = ct.models.MLModel(str(package), compute_units=ct.ComputeUnit.CPU_AND_GPU)
    pcm_dir = Path.home() / ".cache/retake-cutter/pcm"
    sources = sorted(pcm_dir.glob("*.npy"), key=lambda p: p.stat().st_size, reverse=True)
    if sources:
        pcm = np.load(sources[0], mmap_mode="r")
        offset = 120 * SAMPLE_RATE
        print(f"parity source: {sources[0].name} ({len(pcm) / SAMPLE_RATE:.0f} s)")
    else:
        rng = np.random.default_rng(0)
        pcm = (rng.standard_normal(60 * SAMPLE_RATE) * 0.05).astype(np.float32)
        offset = 0
        print("parity source: noise (no cached PCM found)")
    worst = 0.0
    for seconds in (0.5, 3.3, 12.0, 20.8):
        n = int(seconds * SAMPLE_RATE)
        chunk = np.array(pcm[offset : offset + n], dtype=np.float32)[None]
        offset += n
        with torch.inference_mode():
            reference, _ = model(torch.from_numpy(chunk))
            reference = torch.log_softmax(reference, dim=-1).numpy()
        start = time.perf_counter()
        got = ml.predict({"audio": chunk})["emission"]
        took = time.perf_counter() - start
        assert got.shape == reference.shape == (1, frames_for(n), 29), (got.shape, reference.shape)
        diff = float(np.abs(got - reference).max())
        likely = reference > -10.0  # log-probabilities that can influence the alignment
        likely_diff = float(np.abs(got - reference)[likely].max())
        prob_diff = float(np.abs(np.exp(got) - np.exp(reference)).max())
        argmax_same = float((got.argmax(-1) == reference.argmax(-1)).mean())
        print(
            f"  {seconds:5.1f} s: frames={got.shape[1]} max|diff|={diff:.5f} "
            f"(logp>-10: {likely_diff:.5f}, prob: {prob_diff:.5f}) "
            f"argmax agreement={argmax_same:.4f} coreml {took * 1000:.0f} ms"
        )
        worst = max(worst, diff)
    print(f"max abs diff over sample windows: {worst:.5f}")
    return worst


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--precision",
        choices=["fp16", "fp32", "head32"],
        default="fp16",
        help="fp16 everywhere (default), fp32 everywhere, or fp16 with an fp32 output head",
    )
    parser.add_argument("--skip-check", action="store_true")
    args = parser.parse_args()
    package = convert(args.out, args.precision)
    print(f"wrote {package}")
    if not args.skip_check:
        check(package)
    return 0


if __name__ == "__main__":
    sys.exit(main())
