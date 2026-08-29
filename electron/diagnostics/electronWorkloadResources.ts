import fs from "node:fs/promises";
import { app, powerMonitor } from "electron";
import type { WorkloadResourceSample } from "./workloadTelemetry";

export interface ElectronWorkloadResourceState {
	getThermalState: () => WorkloadResourceSample["thermalState"];
	getCpuSpeedLimitPercent: () => number | undefined;
}

/**
 * Samples only numeric process/system state. The caller may supply a directory
 * for statfs, but the path itself never enters a workload report.
 */
export function createElectronWorkloadResourceSampler(state: ElectronWorkloadResourceState) {
	return async (diskDirectory?: string): Promise<Omit<WorkloadResourceSample, "elapsedMs">> => {
		const electronProcess = process as typeof process & {
			getProcessMemoryInfo: () => Promise<Electron.ProcessMemoryInfo>;
			getSystemMemoryInfo: () => Electron.SystemMemoryInfo;
		};
		const memoryPromise = electronProcess.getProcessMemoryInfo();
		const diskPromise = diskDirectory
			? fs.statfs(diskDirectory).catch(() => null)
			: Promise.resolve(null);
		const [mainMemory, disk] = await Promise.all([memoryPromise, diskPromise]);
		const appMetrics = app.getAppMetrics();
		const systemMemory = electronProcess.getSystemMemoryInfo();
		const appWorkingSetKb = appMetrics.reduce(
			(total, metric) => total + metric.memory.workingSetSize,
			0,
		);
		const appCpuPercent = appMetrics.reduce(
			(total, metric) => total + metric.cpu.percentCPUUsage,
			0,
		);
		const gpuMemoryEstimatedBytes =
			appMetrics
				.filter((metric) => metric.type === "GPU")
				.reduce((total, metric) => total + metric.memory.workingSetSize, 0) * 1_024;
		const diskAvailableBytes = disk ? disk.bavail * disk.bsize : undefined;

		return {
			mainPrivateMemoryKb: mainMemory.private,
			appWorkingSetKb,
			appCpuPercent,
			systemAvailableMemoryKb: systemMemory.free,
			gpuMemoryEstimatedBytes,
			...(diskAvailableBytes !== undefined ? { diskAvailableBytes } : {}),
			thermalState: state.getThermalState() ?? "unknown",
			onBatteryPower: powerMonitor.isOnBatteryPower(),
			...(state.getCpuSpeedLimitPercent() !== undefined
				? { cpuSpeedLimitPercent: state.getCpuSpeedLimitPercent() }
				: {}),
		};
	};
}
