import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

type Ownership = Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;

interface OwnerRecord {
	token: string;
	generation: string;
	updatedAt: string;
	[key: string]: unknown;
}

const cleanupDirs: string[] = [];

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createPaths(): {
	root: string;
	registryDir: string;
	socketPath: string;
	agentDir: string;
	descriptorDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "ownership-renewal-"));
	cleanupDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		root,
		registryDir: join(root, "registry"),
		socketPath: join(root, "daemon.sock"),
		agentDir,
		descriptorDir: join(root, "workers"),
	};
}

async function acquire(paths: ReturnType<typeof createPaths>, generation = "renewal-owner"): Promise<Ownership> {
	return acquireDaemonSupervisorOwnership({
		agentDir: paths.agentDir,
		appVersion: "test",
		descriptorDir: paths.descriptorDir,
		generation,
		registryDir: paths.registryDir,
		socketPath: paths.socketPath,
	});
}

function ownerDir(paths: ReturnType<typeof createPaths>, generation: string): string {
	return join(paths.registryDir, `${generation}.owner`);
}

function readJson(path: string): OwnerRecord {
	return JSON.parse(readFileSync(path, "utf8")) as OwnerRecord;
}

function triggerRenew(ownership: Ownership): Promise<void> {
	const renewal = Reflect.get(ownership, "renewal") as { assertOrRenew: () => Promise<void> };
	return renewal.assertOrRenew();
}

describe("daemon supervisor ownership renewal", () => {
	it("renewal rewrites owner.json and scope.json with fresh timestamps", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		const ownerPath = join(directory, "owner.json");
		const scopePath = join(directory, "scope.json");
		const staleTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
		utimesSync(ownerPath, staleTime, staleTime);
		utimesSync(scopePath, staleTime, staleTime);
		const updatedAtBefore = readJson(ownerPath).updatedAt;

		await triggerRenew(ownership);

		expect(statSync(ownerPath).mtimeMs).toBeGreaterThan(staleTime.getTime() + 1000);
		expect(statSync(scopePath).mtimeMs).toBeGreaterThan(staleTime.getTime() + 1000);
		expect(Date.parse(readJson(ownerPath).updatedAt)).toBeGreaterThanOrEqual(Date.parse(updatedAtBefore));
		expect(readJson(ownerPath).token).toBe(ownership.record.token);
		expect(readJson(scopePath).token).toBe(ownership.record.token);
		await ownership.release();
	});

	it("self-heals a reaped owner directory for the live owning process", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		rmSync(directory, { recursive: true, force: true });

		await expect(ownership.assertCurrent()).resolves.toBeUndefined();

		expect(readJson(join(directory, "owner.json")).token).toBe(ownership.record.token);
		expect(readJson(join(directory, "scope.json")).token).toBe(ownership.record.token);
		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
		await ownership.release();
	});

	it("keeps a mismatched-token record fatal and does not overwrite it", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		const ownerPath = join(directory, "owner.json");
		const foreign = { ...readJson(ownerPath), token: "successor-token" };
		writeFileSync(ownerPath, `${JSON.stringify(foreign, null, 2)}\n`);

		await expect(ownership.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
			name: "DaemonSupervisorOwnershipLostError",
		});
		expect(readJson(ownerPath).token).toBe("successor-token");
		await expect(triggerRenew(ownership)).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(readJson(ownerPath).token).toBe("successor-token");
		// Ownership is marked lost: even a healthy-looking record no longer revives it.
		await expect(ownership.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		await ownership.release();
	});

	it("does not self-heal when a live conflicting owner claimed the scope after the reap", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		rmSync(ownerDir(paths, ownership.record.generation), { recursive: true, force: true });
		const successor = await acquire(paths, "successor-owner");

		await expect(ownership.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(readJson(join(ownerDir(paths, "successor-owner"), "owner.json")).token).toBe(successor.record.token);

		await successor.release();
		await ownership.release();
	});

	it("stops renewing after release", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		await ownership.release();
		await expect(triggerRenew(ownership)).rejects.toMatchObject({ code: "supervisor_generation_stale" });
	});
});
