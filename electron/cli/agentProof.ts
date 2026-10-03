import type { CommandPolicy, EvidenceRequirement } from "./agentCommandPolicy";

export const recordValue = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};

export interface ProofEvidence {
	requirement: EvidenceRequirement;
	status: "passed" | "failed" | "unavailable";
	source: "live" | "saved" | "export" | "source_audio";
	revision: string;
	sha256: string;
	time_base: string;
	requested_time: number;
	observed_time: number;
	freshness: "settled" | "possibly_stale" | "unknown";
	artifacts: string[];
	attestation?: { reviewer: string; reviewed: true };
}

export function assessProof(
	requirements: readonly EvidenceRequirement[],
	evidence: readonly ProofEvidence[],
	identity: { revision?: string; sha256?: string },
) {
	const checks = requirements.map((requirement) => {
		const proof = evidence.find((item) => item.requirement === requirement);
		const live = requirement === "live_seek" || requirement === "live_playback";
		const human =
			requirement === "listening" || requirement === "changed_span" || requirement === "boundaries";
		let status: "pending" | "passed" | "failed" | "unavailable" = "pending";
		if (proof) {
			if (proof.status !== "passed") status = proof.status;
			else if (
				identity.revision &&
				identity.sha256 &&
				proof.revision === identity.revision &&
				proof.sha256 === identity.sha256 &&
				proof.artifacts.length &&
				proof.time_base &&
				Number.isFinite(proof.requested_time) &&
				Number.isFinite(proof.observed_time) &&
				(!live ||
					(proof.source === "live" &&
						proof.freshness === "settled" &&
						Math.abs(proof.requested_time - proof.observed_time) <= 1 / 30)) &&
				(requirement !== "span_export" || proof.source === "export") &&
				((requirement !== "isolated_audio" && requirement !== "listening") ||
					proof.source === "source_audio") &&
				(!human || Boolean(proof.attestation?.reviewed && proof.attestation.reviewer))
			)
				status = "passed";
		}
		return { requirement, status, evidence: proof ?? null };
	});
	return {
		status: checks.some((c) => c.status === "failed")
			? "failed"
			: checks.some((c) => c.status === "unavailable")
				? "unavailable"
				: checks.some((c) => c.status === "pending")
					? "pending"
					: "passed",
		checks,
	};
}

export function attachVerification(reply: Record<string, unknown>, policy: CommandPolicy) {
	if (!policy.verification.length) return reply;
	const data = recordValue(reply.data);
	const receipt = recordValue(data.receipt ?? reply.receipt);
	const hashes = recordValue(receipt.contentHashes);
	const verify = recordValue(data.verify);
	const commit =
		reply.commit_status ?? data.commit_status ?? (receipt.revision ? "committed" : "unknown");
	const assessment = assessProof(policy.verification, [], {
		revision: typeof receipt.revision === "string" ? receipt.revision : undefined,
		sha256: typeof hashes.sha256_after === "string" ? hashes.sha256_after : undefined,
	});
	const checks = recordValue(verify.checks);
	const content = recordValue(verify.content_verification);
	const counts = recordValue(content.counts);
	if (verify.status === "failed" || checks.status === "error" || content.status === "failed")
		assessment.status = "failed";
	else if (verify.status === "unavailable" || content.status === "unavailable")
		assessment.status = "unavailable";
	else if (typeof counts.error === "number" && counts.error > 0) assessment.status = "failed";
	return {
		...reply,
		commit_status: commit,
		verification: {
			...assessment,
			revision: receipt.revision ?? null,
			hashes: receipt.contentHashes ?? null,
			time_base: "edited_seconds",
			range: verify.range ?? null,
			note: "Command completion and structural checks do not prove visual review or listening. Keep the receipt; do not repeat a committed edit to obtain proof.",
		},
	};
}
