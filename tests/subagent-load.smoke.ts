import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_ROOT =
	"/home/pirackr/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "extensions/subagent/index.ts");
const piRequire = createRequire(`${PI_ROOT}/package.json`);
const jitiPkg = piRequire("jiti") as {
	createJiti?: (id: string, options?: object) => { import(id: string, options?: object): Promise<unknown> };
	default?: { createJiti?: (id: string, options?: object) => { import(id: string, options?: object): Promise<unknown> } };
};
const createJiti = jitiPkg.createJiti ?? jitiPkg.default?.createJiti;
if (!createJiti) throw new Error("jiti.createJiti not found in Pi installation");
const jiti = createJiti(pathToFileURL(import.meta.url).href, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
	},
});

describe("subagent extension loader smoke", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const renderers: string[] = [];
	const handlers: string[] = [];
	let factory: ((pi: unknown) => void) | undefined;

	beforeAll(async () => {
		factory = await jiti.import(extensionPath, { default: true }) as (pi: unknown) => void;
		factory({
			registerTool(tool: { name: string }) { tools.push(tool.name); },
			registerCommand(name: string) { commands.push(name); },
			registerMessageRenderer(name: string) { renderers.push(name); },
			on(name: string) { handlers.push(name); },
			sendMessage() {},
			events: { emit() {}, on() {} },
		});
	});

	it("loads a default extension factory through Pi's jiti path", () => {
		expect(typeof factory).toBe("function");
	});

	it("registers the exact public tool and command surface without startup side effects", () => {
		expect(tools).toEqual(["Agent", "get_subagent_result", "stop_subagent"]);
		expect(commands).toEqual(["agents"]);
		expect(renderers).toEqual(["subagent-notification"]);
		for (const event of ["session_start", "turn_start", "turn_end", "input", "session_shutdown"]) {
			expect(handlers).toContain(event);
		}
	});
});
