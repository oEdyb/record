import { memo, useEffect, useMemo, useRef } from "react";
import { useAudioPeaks } from "@/hooks/useAudioPeaks";
import styles from "./EditorShellV4.module.css";

const MAX_RENDER_COLUMNS = 8_192;
const MAX_CANVAS_EDGE = 16_384;
const REFERENCE_QUANTILE = 0.985;
const REFERENCE_HEIGHT = 0.88;
const MAX_REFERENCE_GAIN = 12;
const HISTOGRAM_BINS = 1_024;

export interface WaveformColumn {
	min: number;
	max: number;
}

interface WaveformRange {
	startBlock: number;
	endBlock: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function sourceBlockRange(
	peaks: Float32Array,
	assetDurationSec: number,
	sourceStartSec: number,
	sourceEndSec: number,
): WaveformRange | null {
	const totalBlocks = Math.floor(peaks.length / 2);
	if (totalBlocks === 0 || !Number.isFinite(assetDurationSec) || assetDurationSec <= 0) return null;
	const startSec = clamp(sourceStartSec, 0, assetDurationSec);
	const endSec = clamp(sourceEndSec, startSec, assetDurationSec);
	if (endSec <= startSec) return null;
	return {
		startBlock: Math.min(totalBlocks - 1, Math.floor((startSec / assetDurationSec) * totalBlocks)),
		endBlock: Math.min(totalBlocks, Math.ceil((endSec / assetDurationSec) * totalBlocks)),
	};
}

/**
 * Resample the source min/max envelope to the number of columns the clip can
 * physically display. Every source block contributes to exactly one column,
 * so a short transient is preserved instead of skipped at overview scale.
 */
export function buildWaveformColumns(
	peaks: Float32Array,
	assetDurationSec: number,
	sourceStartSec: number,
	sourceEndSec: number,
	pixelWidth: number,
): WaveformColumn[] {
	const range = sourceBlockRange(peaks, assetDurationSec, sourceStartSec, sourceEndSec);
	if (!range || !Number.isFinite(pixelWidth) || pixelWidth <= 0) return [];
	const rangeBlocks = range.endBlock - range.startBlock;
	const columnCount = Math.min(
		MAX_RENDER_COLUMNS,
		rangeBlocks,
		Math.max(1, Math.floor(pixelWidth)),
	);
	const columns = new Array<WaveformColumn>(columnCount);
	for (let column = 0; column < columnCount; column += 1) {
		const blockStart = range.startBlock + Math.floor((column / columnCount) * rangeBlocks);
		const blockEnd = range.startBlock + Math.floor(((column + 1) / columnCount) * rangeBlocks);
		let minimum = 0;
		let maximum = 0;
		for (let block = blockStart; block < blockEnd; block += 1) {
			const lo = peaks[block * 2] ?? 0;
			const hi = peaks[block * 2 + 1] ?? 0;
			if (Number.isFinite(lo) && lo < minimum) minimum = lo;
			if (Number.isFinite(hi) && hi > maximum) maximum = hi;
		}
		columns[column] = { min: minimum, max: maximum };
	}
	return columns;
}

/**
 * A robust reference gain makes quiet speech and room noise readable without
 * inventing signal in silent blocks. One rare click cannot flatten the entire
 * clip because the scale uses the 98.5th percentile, not the single maximum.
 */
export function computeReferenceWaveformGain(
	peaks: Float32Array,
	assetDurationSec: number,
	sourceStartSec: number,
	sourceEndSec: number,
): number {
	const range = sourceBlockRange(peaks, assetDurationSec, sourceStartSec, sourceEndSec);
	if (!range) return 1;
	const histogram = new Uint32Array(HISTOGRAM_BINS);
	let maximumAmplitude = 0;
	let signalBlockCount = 0;
	for (let block = range.startBlock; block < range.endBlock; block += 1) {
		const amplitude = clamp(
			Math.max(Math.abs(peaks[block * 2] ?? 0), Math.abs(peaks[block * 2 + 1] ?? 0)),
			0,
			1,
		);
		maximumAmplitude = Math.max(maximumAmplitude, amplitude);
		// Keep digital silence out of the reference percentile. Otherwise a short
		// spoken phrase in a mostly silent clip can fall below the percentile and
		// one transient becomes the scale for the whole waveform.
		if (amplitude > 0) {
			histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(amplitude * HISTOGRAM_BINS))] += 1;
			signalBlockCount += 1;
		}
	}
	if (maximumAmplitude === 0 || signalBlockCount === 0) return 1;
	const target = Math.ceil(signalBlockCount * REFERENCE_QUANTILE);
	let seen = 0;
	let referenceAmplitude = maximumAmplitude;
	for (let bin = 0; bin < histogram.length; bin += 1) {
		seen += histogram[bin] ?? 0;
		if (seen >= target) {
			referenceAmplitude = (bin + 1) / HISTOGRAM_BINS;
			break;
		}
	}
	return clamp(REFERENCE_HEIGHT / referenceAmplitude, 1, MAX_REFERENCE_GAIN);
}

function drawWaveform(
	canvas: HTMLCanvasElement,
	peaks: Float32Array,
	assetDurationSec: number,
	sourceStartSec: number,
	sourceEndSec: number,
	referenceGain: number,
): void {
	const bounds = canvas.getBoundingClientRect();
	const width = Math.floor(bounds.width);
	const height = Math.floor(bounds.height);
	if (width <= 0 || height <= 0) return;
	const requestedScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
	const bitmapWidth = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.round(width * requestedScale)));
	const bitmapHeight = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.round(height * requestedScale)));
	if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
	if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
	const context = canvas.getContext("2d");
	if (!context) return;
	context.setTransform(bitmapWidth / width, 0, 0, bitmapHeight / height, 0, 0);
	context.clearRect(0, 0, width, height);

	const columns = buildWaveformColumns(
		peaks,
		assetDurationSec,
		sourceStartSec,
		sourceEndSec,
		width,
	);
	if (columns.length === 0) return;
	const color = getComputedStyle(canvas).color;
	const center = height / 2;
	const halfHeight = Math.max(1, center - 3);
	context.strokeStyle = color;
	context.lineCap = "round";

	// A quiet center line keeps the clip coherent while true digital silence
	// remains flat. It replaces the old fake 8% minimum-height bars.
	context.globalAlpha = 0.16;
	context.lineWidth = 0.5;
	context.beginPath();
	context.moveTo(0, center);
	context.lineTo(width, center);
	context.stroke();

	const spacing = width / columns.length;
	context.globalAlpha = 0.78;
	context.lineWidth = Math.min(1.25, Math.max(0.7, spacing * 0.72));
	context.beginPath();
	for (let index = 0; index < columns.length; index += 1) {
		const column = columns[index];
		if (column.min === 0 && column.max === 0) continue;
		const top = center - clamp(column.max * referenceGain, 0, 1) * halfHeight;
		const bottom = center - clamp(column.min * referenceGain, -1, 0) * halfHeight;
		const x = (index + 0.5) * spacing;
		context.moveTo(x, top);
		context.lineTo(x, bottom);
	}
	context.stroke();
	context.globalAlpha = 1;
}

export const ClipWaveform = memo(function ClipWaveform({
	videoUrl,
	assetDurationSec,
	sourceStartSec,
	sourceEndSec,
}: {
	videoUrl: string | undefined;
	assetDurationSec: number | undefined;
	sourceStartSec: number;
	sourceEndSec: number;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const peaks = useAudioPeaks(videoUrl, assetDurationSec);
	const referenceGain = useMemo(
		() =>
			peaks && assetDurationSec
				? computeReferenceWaveformGain(peaks, assetDurationSec, sourceStartSec, sourceEndSec)
				: 1,
		[peaks, assetDurationSec, sourceStartSec, sourceEndSec],
	);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !peaks || !assetDurationSec) return;
		let frame = 0;
		const scheduleDraw = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() =>
				drawWaveform(canvas, peaks, assetDurationSec, sourceStartSec, sourceEndSec, referenceGain),
			);
		};
		const resizeObserver = new ResizeObserver(scheduleDraw);
		resizeObserver.observe(canvas);
		const themeObserver = new MutationObserver(scheduleDraw);
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		scheduleDraw();
		return () => {
			cancelAnimationFrame(frame);
			resizeObserver.disconnect();
			themeObserver.disconnect();
		};
	}, [peaks, assetDurationSec, sourceStartSec, sourceEndSec, referenceGain]);

	return <canvas ref={canvasRef} aria-hidden className={styles.tlWave} />;
});
