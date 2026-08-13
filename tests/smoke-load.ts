/**
 * Smoke test: load the auto-compact extension exactly the way pi's
 * loader.js does in built-Node mode — createJiti(import.meta.url, { alias })
 * where the alias maps @earendil-works/pi-coding-agent to pi's own index,
 * then jiti.import(path, { default: true }) — and wire the factory with a
 * fake ExtensionAPI, asserting all event handlers + /auto-compact register.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PI_ROOT =
	"/home/pirackr/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent";

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

// pi's loader.js: `jiti.import(path, { default: true })` returns the default
// export (the factory function) directly.
const factory = (await jiti.import(
	"/home/pirackr/Working/grinder/pi-extensions/extensions/auto-compact/index.ts",
	{ default: true },
)) as (pi: unknown) => void;

if (typeof factory !== "function") {
	throw new Error("default export is not a function");
}

// Second (non-unwrapped) import to inspect named exports.
const ns = (await jiti.import(
	"/home/pirackr/Working/grinder/pi-extensions/extensions/auto-compact/index.ts",
)) as {
	controller?: unknown;
	resetExtensionState?: () => void;
};
if (!ns.controller) {
	throw new Error("controller export missing");
}
if (typeof ns.resetExtensionState !== "function") {
	throw new Error("resetExtensionState export missing");
}

// Exercise the factory with a minimal fake ExtensionAPI.
const registered: string[] = [];
const handlers: Record<string, unknown> = {};
const fakePi = {
	on: (name: string, handler: unknown) => {
		handlers[name] = handler;
	},
	registerCommand: (name: string, _def: unknown) => {
		registered.push(name);
	},
};
factory(fakePi as never);

const expected = [
	"session_start",
	"model_select",
	"turn_end",
	"session_before_compact",
	"session_compact",
];
for (const name of expected) {
	if (!(name in handlers)) throw new Error(`handler not registered: ${name}`);
}
if (!registered.includes("auto-compact")) {
	throw new Error("command /auto-compact not registered");
}

console.log("SMOKE OK");
console.log("  default export: function");
console.log("  events:", expected.join(", "));
console.log("  commands:", registered.join(", "));
