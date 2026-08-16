/**
 * Task 9: tmux-subagent loader smoke — loads extensions/tmux-subagent/index.ts
 * exactly the way pi's loader.js does in built-Node mode (createJiti with the
 * @earendil-works/pi-coding-agent alias mapped to pi's own index, then
 * jiti.import(path, { default: true })), wires the factory with a minimal fake
 * ExtensionAPI, and asserts registration of the run_subagents tool plus the
 * session_info_changed and session_shutdown event handlers.
 *
 * Distinct from tests/smoke-load.ts (the auto-compact smoke): this one targets
 * the tmux-subagent factory and asserts its specific registration surface.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_ROOT =
	"/home/pirackr/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const extensionPath = path.join(
	repoRoot,
	"extensions/tmux-subagent/index.ts",
);

const piRequire = createRequire(`${PI_ROOT}/package.json`);
const jitiPkg = piRequire("jiti") as {
	createJiti?: (
		id: string,
		opts?: object,
	) => {
		import: (id: string, opts?: object) => Promise<unknown>;
	};
	default?: {
		createJiti?: (
			id: string,
			opts?: object,
		) => {
			import: (id: string, opts?: object) => Promise<unknown>;
		};
	};
};
const createJiti =
	jitiPkg.createJiti ?? jitiPkg.default?.createJiti ?? jitiPkg.default;
if (typeof createJiti !== "function") {
	throw new Error("jiti.createJiti not found in pi's bundled jiti");
}

const jiti = createJiti(pathToFileURL(import.meta.url).href, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
	},
});

describe("tmux-subagent factory loader smoke", () => {
	let factory: ((pi: unknown) => void) | undefined;
	let registeredTools: string[];
	let handlers: Record<string, unknown>;

	beforeAll(async () => {
		// pi's loader.js: `jiti.import(path, { default: true })` returns the
		// default export (the factory function) directly.
		const loaded = (await jiti.import(extensionPath, {
			default: true,
		})) as (pi: unknown) => void;
		if (typeof loaded !== "function") {
			throw new Error("default export is not a function");
		}
		factory = loaded;

		// Exercise the factory with a minimal fake ExtensionAPI.
		registeredTools = [];
		handlers = {};
		const fakePi = {
			registerTool: (def: { name: string }) => {
				registeredTools.push(def.name);
			},
			on: (name: string, handler: unknown) => {
				handlers[name] = handler;
			},
		};
		factory(fakePi as never);
	});

	it("loads the factory via jiti (pi loader path)", () => {
		expect(typeof factory).toBe("function");
	});

	it("registers the run_subagents tool", () => {
		expect(registeredTools).toContain("run_subagents");
	});

	it("registers the session_info_changed event handler", () => {
		expect(handlers).toHaveProperty("session_info_changed");
		expect(typeof handlers.session_info_changed).toBe("function");
	});

	it("registers the session_shutdown event handler", () => {
		expect(handlers).toHaveProperty("session_shutdown");
		expect(typeof handlers.session_shutdown).toBe("function");
	});
});
