import { createHash } from "node:crypto";
import { version } from "../../package.json";
import { AGENT_API_VERSION } from "./agentContracts";
import content from "./skill/SKILL.md?raw";

export function agentSkill() {
	return {
		api_version: AGENT_API_VERSION,
		app_version: version,
		name: "klippt-edit",
		format: "markdown",
		content_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
		content,
	};
}
