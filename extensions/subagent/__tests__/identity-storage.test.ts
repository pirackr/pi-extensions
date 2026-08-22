import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, symlink, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	projectSlug,
	allocateShortId,
	resolveParentIdentity,
	type ParentIdentity,
	type ResolveParentIdentityOptions,
} from "../identity.ts";
import {
	createArtifactStore,
	type ArtifactStore,
	type ArtifactStoreDeps,
} from "../storage.ts";
import {
	type AgentManifest,
	type DeliveryRecord,
	type TerminalResult,
	type ResolvedProfile,
	TaskStatus,
} from "../types.ts";

// ---------------------------------------------------------------------------
// projectSlug — canonical basename plus a short hash of the canonical path
// ---------------------------------------------------------------------------

describe("projectSlug", () => {
	it("is a sanitized basename followed by a four-character hash", () => {
		const slug = projectSlug("/tmp/My Cool Project/");
		// basename "My Cool Project" -> "mycoolproject", then a 4-char base36 hash
		expect(slug).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/);
		const [base, hash] = slug.split("-");
		expect(base).toBe("mycoolproject");
		expect(hash.length).toBe(4);
	});

	it("is deterministic for the same canonical path", () => {
		expect(projectSlug("/home/pirackr/grinder")).toBe(
			projectSlug("/home/pirackr/grinder"),
		);
	});

	it("differs between two projects that share a basename", () => {
		const a = projectSlug("/home/a/work");
		const b = projectSlug("/home/b/work");
		const [baseA] = a.split("-");
		const [baseB] = b.split("-");
		expect(baseA).toBe("work");
		expect(baseB).toBe("work");
		expect(a).not.toBe(b);
	});

	it("tolerates a trailing slash", () => {
		expect(projectSlug("/tmp/work/")).toMatch(/^work-/);
		expect(projectSlug("/tmp/work/").split("-")[0]).toBe("work");
	});
});

// ---------------------------------------------------------------------------
// allocateShortId — collision retries against both tmux and artifact paths
// ---------------------------------------------------------------------------

describe("allocateShortId", () => {
  // `randomShortId` derives each id character from `BASE36[byte % 36]`, so to
  // make a deterministic candidate we emit the base36 *index* of each desired
  // id character. Non-alphabet input (used only to prove the alphabet bound)
  // clamps into the bucket rather than escaping the a-z0-9 range.
  const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  const fixedRandom = (inputs: string[]) => {
    let i = 0;
    return () => {
      const id = inputs[i++ % inputs.length];
      const out = new Uint8Array(4);
      for (let k = 0; k < 4; k++) {
        const idx = ALPHABET.indexOf(id[k]);
        out[k] = idx === -1 ? ALPHABET.length - 1 : idx;
      }
      return out;
    };
  };

	it("returns the first non-colliding candidate", async () => {
		// candidate order: aa00, bb11, cc22
		const randomBytes = fixedRandom(["aa00", "bb11", "cc22"]);
		const seen: string[] = [];
		const checkCollision = async (id: string) => {
			seen.push(id);
			return id === "aa00" || id === "bb11";
		};
		const id = await allocateShortId(checkCollision, randomBytes, 8);
		expect(id).toBe("cc22");
		expect(seen).toEqual(["aa00", "bb11", "cc22"]);
	});

	it("retries against both tmux and artifact checks until unique", async () => {
		// every candidate is considered colliding in tmux; only cc22 is free in artifacts
		const randomBytes = fixedRandom(["aa00", "bb11", "cc22"]);
		const tmux = new Set<string>();
		const artifacts = new Set<string>(["aa00", "bb11"]);
		const checkCollision = async (id: string) =>
			tmux.has(id) || artifacts.has(id);
		const id = await allocateShortId(checkCollision, randomBytes, 8);
		expect(id).toBe("cc22");
	});

	it("fails with a clear error once attempts are exhausted", async () => {
		const randomBytes = fixedRandom(["0"]);
		const checkCollision = async () => true;
		await expect(
			allocateShortId(checkCollision, randomBytes, 3),
		).rejects.toThrow(/attempts/);
	});

	it("never yields an id outside the lowercase a-z0-9 alphabet", async () => {
		const randomBytes = fixedRandom(["a", "Z", "9", "_"]);
		for (let n = 0; n < 20; n++) {
			const id = await allocateShortId(async () => false, randomBytes, 8);
			expect(id).toMatch(/^[a-z0-9]{4}$/);
		}
	});
});

// ---------------------------------------------------------------------------
// resolveParentIdentity — PI_SESSION_ID resolution order
// ---------------------------------------------------------------------------

const FAKE_TMP = "/tmp/subagent-fake-tmp";

function baseOptions(overrides: Partial<ResolveParentIdentityOptions> = {}): ResolveParentIdentityOptions {
	return {
		cwd: resolve("/tmp/CoolProject"),
		tmpRoot: FAKE_TMP,
		...overrides,
	};
}

describe("resolveParentIdentity", () => {
	it("prefers a running pi-xxxx tmux session suffix", async () => {
		const identity = await resolveParentIdentity(
			baseOptions({
				tmuxCurrentSession: () => "pi-q9xm",
				readSessionId: () => "a7k2",
			}),
		);
		expect(identity.id).toBe("q9xm");
		expect(identity.tmuxSession).toBe("pi-q9xm");
		expect(identity.artifactRoot).toBe(
			`${FAKE_TMP}/${projectSlug(resolve("/tmp/CoolProject"))}/pi-q9xm`,
		);
	});

	it("falls back to a valid PI_SESSION_ID when no tmux session matches", async () => {
		const identity = await resolveParentIdentity(
			baseOptions({
				tmuxCurrentSession: () => "other-session",
				readSessionId: () => "a7k2",
			}),
		);
		expect(identity.id).toBe("a7k2");
		expect(identity.tmuxSession).toBe("pi-a7k2");
	});

	it("allocates a fresh collision-checked id when neither is present", async () => {
		const allocated: string[] = [];
		const identity = await resolveParentIdentity(
			baseOptions({
				tmuxCurrentSession: () => null,
				readSessionId: () => null,
				allocateShortId: async (checkCollision, randomBytes, max) => {
					const id = await allocateShortId(checkCollision, randomBytes, max);
					allocated.push(id);
					return id;
				},
				collisionFor: async () => false,
			}),
		);
		expect(identity.id).toMatch(/^[a-z0-9]{4}$/);
		expect(allocated[0]).toBe(identity.id);
		expect(process.env.PI_SESSION_ID).toBe(identity.id);
	});

	it("rejects a malformed PI_SESSION_ID by allocating a fresh id", async () => {
		const identity = await resolveParentIdentity(
			baseOptions({
				tmuxCurrentSession: () => null,
				readSessionId: () => "NOT_AN_ID",
				collisionFor: async () => false,
			}),
		);
		expect(identity.id).toMatch(/^[a-z0-9]{4}$/);
		expect(identity.id).not.toBe("NOT_AN_ID");
	});
});

// ---------------------------------------------------------------------------
// ArtifactStore — exact root layout, modes, ordering, security
// ---------------------------------------------------------------------------

const SAMPLE_PROFILE: ResolvedProfile = {
	name: "worker",
	description: "A worker agent",
	model: "Qwen3.6-35B-A3B-MTP-GGUF",
	thinking: "high",
	tools: ["read", "edit", "grep"],
	access: "write",
	timeoutSeconds: 900,
	systemPrompt: "You are a worker.",
	source: "bundled",
};

function makeManifest(agentId: string, revision: number, state: TaskStatus, sequence: number): AgentManifest {
	return {
		schema: 1,
		generation: "g0000000",
		revision,
		parentId: "a7k2",
		agentId,
		parentAgentId: null,
		origin: "00000000-0000-0000-0000-000000000000",
		groupId: null,
		description: "worker",
		prompt: "do abc",
		profile: SAMPLE_PROFILE,
		state,
		sequence,
		queuedAt: 1_700_000_000_000,
		startedAt: null,
		heartbeatAt: null,
		finishedAt: null,
		runnerPid: null,
		processStart: "39182",
		tmuxSession: "pi-a7k2",
		tmuxWindow: null,
		timeoutSeconds: 900,
		terminalReason: null,
	};
}

let root: string;
let store: ArtifactStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "subagent-store-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
});

describe("ArtifactStore layout and modes", () => {
	it("creates the exact parent root layout with 0700 dirs and 0600 files", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();

		// parent.json exists and is a 0600 file
		const parentStat = await stat(join(identity.artifactRoot, "parent.json"));
		expect(parentStat.isFile()).toBe(true);
		expect(parentStat.mode & 0o777).toBe(0o600);

		// the documented directories exist as 0700 directories
		for (const rel of ["subagents", "groups"]) {
			const s = await stat(join(identity.artifactRoot, rel));
			expect(s.isDirectory()).toBe(true);
			expect(s.mode & 0o777).toBe(0o700);
		}
	});

	it("writes a status.json with 0600 mode during enqueue", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();

		const manifest = makeManifest("q9xm", 1, "queued", 0);
		const agentId = await store.enqueue(manifest, { model: "Qwen" });
		expect(agentId).toBe("q9xm");

		const status = join(store.artifactRoot, "subagents", "q9xm", "status.json");
		const s = await stat(status);
		expect(s.isFile()).toBe(true);
		expect(s.mode & 0o777).toBe(0o600);

		// request.json and profile.json also exist for the enqueued task
		expect(
			(await stat(join(store.artifactRoot, "subagents", "q9xm", "request.json")))
				.isFile(),
		).toBe(true);
		expect(
			(await stat(join(store.artifactRoot, "subagents", "q9xm", "profile.json")))
				.isFile(),
		).toBe(true);
	});

	it("rejects an existing symlink at a path it would create", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();

		const link = join(store.artifactRoot, "subagents", "q9xm");
		await mkdir(join(store.artifactRoot, "subagents"), { recursive: true });
		await symlink("/etc", link);

		await expect(
			store.enqueue(makeManifest("q9xm", 1, "queued", 0), {}),
		).rejects.toThrow(/symlink/i);
	});

	it("rejects reading through a symlinked status.json", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();

		const dir = join(store.artifactRoot, "subagents", "q9xm");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "real.json"), "{}", { mode: 0o600 });
		await symlink(join(dir, "real.json"), join(dir, "status.json"));

		await expect(store.readTask("q9xm")).rejects.toThrow(/symlink/i);
	});
});

describe("ArtifactStore scan and readTask", () => {
	beforeEach(async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();
	});

	it("reads a task manifest back atomically", async () => {
		const manifest = makeManifest("q9xm", 1, "queued", 0);
		await store.enqueue(manifest, {});
		const read = await store.readTask("q9xm");
		expect(read?.agentId).toBe("q9xm");
		expect(read?.state).toBe("queued");
	});

	it("returns null for an unknown agent id", async () => {
		expect(await store.readTask("nope")).toBeNull();
	});

	it("scans queued manifests ordered by sequence", async () => {
		await store.enqueue(makeManifest("q9xm", 1, "queued", 5), {});
		await store.enqueue(makeManifest("4vnr", 1, "queued", 2), {});
		await store.enqueue(makeManifest("k2pd", 1, "succeeded", 9), {});
		const queued = await store.scan();
		expect(queued.map((m) => m.agentId)).toEqual(["4vnr", "q9xm"]);
	});
});

describe("ArtifactStore monotonic revisions", () => {
	it("bumps revision on each write and keeps it monotonic", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();

		const base = makeManifest("q9xm", 1, "queued", 0);
		await store.enqueue(base, {});

		const s2 = await store.writeStatus({ ...base, revision: 2, startedAt: 1 });
		expect(s2.revision).toBe(2);
		const read2 = await store.readTask("q9xm");
		expect(read2?.revision).toBe(2);

		const s3 = await store.writeStatus({ ...base, revision: 3, heartbeatAt: 2 });
		expect(s3.revision).toBe(3);
		const read3 = await store.readTask("q9xm");
		expect(read3?.revision).toBe(3);
		expect(read3?.heartbeatAt).toBe(2);
	});
});

describe("ArtifactStore terminal publication order", () => {
	it("publishes result.json before terminal status.json", async () => {
		const writes: Array<{ op: string; path: string }> = [];
		const deps: ArtifactStoreDeps = {
			now: () => 1_700_000_004_100,
			recordWrites: writes,
		};
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity, deps);
		await store.initializeParent();
		await store.enqueue(makeManifest("q9xm", 1, "queued", 0), {});

		const result: TerminalResult = {
			agentId: "q9xm",
			state: "succeeded",
			output: "done",
			usage: { totalTokens: 10, toolUses: 1, durationMs: 4000 },
			finishedAt: 1_700_000_004_100,
			terminalReason: null,
		};
		await store.publishTerminal("q9xm", result);

		const resultPath = join(store.artifactRoot, "subagents", "q9xm", "result.json");
		const statusPath = join(store.artifactRoot, "subagents", "q9xm", "status.json");
		const resultIdx = writes.findIndex((w) => w.path === resultPath);
		const statusIdx = writes.map((w) => w.path).lastIndexOf(statusPath);
		expect(resultIdx).toBeGreaterThan(-1);
		expect(statusIdx).toBeGreaterThan(-1);
		expect(resultIdx).toBeLessThan(statusIdx);

		// the terminal status reflects the settled state and finishedAt
		const status = JSON.parse(await readFile(statusPath, "utf8"));
		expect(status.state).toBe("succeeded");
		expect(status.finishedAt).toBe(1_700_000_004_100);
	});

	it("flushes (retains) append-only logs before publishing terminal state", async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();
		await store.enqueue(makeManifest("q9xm", 1, "queued", 0), {});

		const events = join(store.artifactRoot, "subagents", "q9xm", "events.jsonl");
		await writeFile(events, '{"e":"start"}\n', { mode: 0o600 });

		await store.publishTerminal("q9xm", {
			agentId: "q9xm",
			state: "failed",
			output: "boom",
			usage: { totalTokens: 1, toolUses: 0, durationMs: 10 },
			finishedAt: 5,
			terminalReason: "error",
		});

		// logs are retained (no completed-artifact cleanup) and still readable
		const content = await readFile(events, "utf8");
		expect(content).toContain('"e":"start"');
	});
});

describe("ArtifactStore cancellation and delivery", () => {
	beforeEach(async () => {
		const identity: ParentIdentity = {
			id: "a7k2",
			tmuxSession: "pi-a7k2",
			tmpRoot: root,
			projectSlug: "coolproject",
			artifactRoot: join(root, "coolproject", "pi-a7k2"),
		};
		store = createArtifactStore(identity);
		await store.initializeParent();
		await store.enqueue(makeManifest("q9xm", 1, "queued", 0), {});
	});

	it("writes a cancellation control marker", async () => {
		const written = await store.requestCancellation("q9xm");
		expect(written).toBe(true);
		const control = join(store.artifactRoot, "subagents", "q9xm", "control", "cancel");
		await stat(control);
		const s = await stat(control);
		expect(s.mode & 0o777).toBe(0o600);
	});

	it("reads and updates a delivery record", async () => {
		const pending: DeliveryRecord = {
			groupId: "g1",
			agentIds: ["q9xm"],
			state: "pending",
			notificationId: "n1",
			createdAt: 1_700_000_000_000,
			dispatchedAt: null,
			consumedAt: null,
		};
		// seed delivery.json directly to exercise updateDelivery merge semantics
		const dir = join(store.artifactRoot, "subagents", "q9xm");
		await writeFile(join(dir, "delivery.json"), JSON.stringify(pending), { mode: 0o600 });

		const read = await store.readDelivery("q9xm");
		expect(read?.state).toBe("pending");

		const updated = await store.updateDelivery("q9xm", {
			state: "delivered",
			dispatchedAt: 1_700_000_001_000,
		});
		expect(updated.state).toBe("delivered");
		expect(updated.dispatchedAt).toBe(1_700_000_001_000);

		const onDisk = JSON.parse(await readFile(join(dir, "delivery.json"), "utf8"));
		expect(onDisk.state).toBe("delivered");
	});

	it("returns null when reading a missing delivery record", async () => {
		await store.enqueue(makeManifest("4vnr", 1, "queued", 1), {});
		expect(await store.readDelivery("4vnr")).toBeNull();
	});
});
