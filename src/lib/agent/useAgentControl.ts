import { useEffect, useRef } from "react";

export type AgentMethod = (params: Record<string, unknown>) => unknown;
export type AgentMethods = Record<string, AgentMethod>;

/**
 * Answers the local agent's requests (electron/agent/agentServer.ts) in this window. Methods
 * are read through a ref, so each request runs against the latest render's handlers.
 */
export function useAgentControl(methods: AgentMethods) {
	const methodsRef = useRef(methods);
	methodsRef.current = methods;
	useEffect(() => {
		const agent = window.electronAPI?.agent;
		if (!agent) return;
		return agent.onRequest(async ({ id, method, params }) => {
			const run = methodsRef.current[method];
			if (!run) {
				const known = Object.keys(methodsRef.current).sort().join(", ");
				agent.reply(id, undefined, `Unknown method "${method}". Review methods: ${known}.`);
				return;
			}
			try {
				agent.reply(id, await run(params ?? {}));
			} catch (error) {
				agent.reply(id, undefined, error instanceof Error ? error.message : String(error));
			}
		});
	}, []);
}
