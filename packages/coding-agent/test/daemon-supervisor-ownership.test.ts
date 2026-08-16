import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
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

	it("treats a transient scope read failure as retryable, not lost", async () => {
		if (process.getuid?.() === 0) return;
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		rmSync(join(directory, "owner.json"), { force: true });
		chmodSync(join(directory, "scope.json"), 0o000);

		const transient = await ownership
			.assertCurrent()
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!transient) throw new Error("assertCurrent did not fail while scope.json was unreadable");
		expect(transient.code).not.toBe("supervisor_generation_stale");

		chmodSync(join(directory, "scope.json"), 0o600);
		rmSync(join(directory, "scope.json"), { force: true });
		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
		expect(readJson(join(directory, "owner.json")).token).toBe(ownership.record.token);
		await ownership.release();
	});

	it("reclaims a dead conflicting peer directory during self-heal", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		const ownRecord = readJson(join(directory, "owner.json"));
		const ownScope = readJson(join(directory, "scope.json"));
		const exited = spawnSync("true");
		const deadPid = exited.pid ?? 999_999;
		const peerDir = ownerDir(paths, "dead-peer");
		mkdirSync(peerDir, { recursive: true });
		writeFileSync(
			join(peerDir, "owner.json"),
			`${JSON.stringify({ ...ownRecord, generation: "dead-peer", token: "dead-peer-token", pid: deadPid }, null, 2)}\n`,
		);
		writeFileSync(
			join(peerDir, "scope.json"),
			`${JSON.stringify({ ...ownScope, generation: "dead-peer", token: "dead-peer-token" }, null, 2)}\n`,
		);
		rmSync(directory, { recursive: true, force: true });

		await expect(ownership.assertCurrent()).resolves.toBeUndefined();

		expect(existsSync(peerDir)).toBe(false);
		expect(readJson(join(directory, "owner.json")).token).toBe(ownership.record.token);
		await ownership.release();
	});

	it("heals over corrupt residual scope bytes in its own directory", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const directory = ownerDir(paths, ownership.record.generation);
		rmSync(join(directory, "owner.json"), { force: true });
		writeFileSync(join(directory, "scope.json"), "{ garbage\n");

		await expect(ownership.assertCurrent()).resolves.toBeUndefined();

		expect(readJson(join(directory, "owner.json")).token).toBe(ownership.record.token);
		expect(readJson(join(directory, "scope.json")).token).toBe(ownership.record.token);
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

	it("does not mark ownership lost after a transient renew failure", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const movedRegistry = `${paths.registryDir}.moved`;
		renameSync(paths.registryDir, movedRegistry);
		writeFileSync(paths.registryDir, "blocked");

		const transient = await triggerRenew(ownership)
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!transient) throw new Error("renew did not fail while the registry was blocked");
		expect(transient.code).not.toBe("supervisor_generation_stale");

		rmSync(paths.registryDir, { force: true });
		renameSync(movedRegistry, paths.registryDir);
		rmSync(ownerDir(paths, ownership.record.generation), { recursive: true, force: true });
		// The real isFatalError wiring must have left the renewal alive: it still self-heals.
		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
		expect(readJson(join(ownerDir(paths, ownership.record.generation), "owner.json")).token).toBe(
			ownership.record.token,
		);
		await ownership.release();
	});

	it("preserves the owner phase across renewal", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		await ownership.updatePhase("owner");
		const ownerPath = join(ownerDir(paths, ownership.record.generation), "owner.json");

		await triggerRenew(ownership);

		expect((readJson(ownerPath) as OwnerRecord & { phase?: string }).phase).toBe("owner");
		expect(ownership.record.phase).toBe("owner");
		await ownership.release();
	});

	it("stops renewing after release", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		await ownership.release();
		await expect(triggerRenew(ownership)).rejects.toMatchObject({ code: "supervisor_generation_stale" });
	});

	it("disambiguates never-acquired from lost-on-disk ownership errors", async () => {
		const paths = createPaths();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			ownership: undefined,
			generation: "unowned-generation",
			socketPath: paths.socketPath,
		});
		const assertCurrentOwnership = Reflect.get(supervisor, "assertCurrentOwnership") as () => Promise<void>;
		const neverAcquired = await assertCurrentOwnership
			.call(supervisor)
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!neverAcquired) throw new Error("assertCurrentOwnership did not throw");
		expect(neverAcquired.code).toBe("supervisor_generation_stale");
		expect(neverAcquired.message).toContain("holds no registry ownership");
		expect(neverAcquired.message).toContain(paths.socketPath);
		expect(neverAcquired.message).toContain("sessions are preserved");

		const ownership = await acquire(paths);
		const ownerPath = join(ownerDir(paths, ownership.record.generation), "owner.json");
		const foreign = { ...readJson(ownerPath), token: "successor-token" };
		writeFileSync(ownerPath, `${JSON.stringify(foreign, null, 2)}\n`);
		const lostOnDisk = await ownership
			.assertCurrent()
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!lostOnDisk) throw new Error("assertCurrent did not throw");
		expect(lostOnDisk.code).toBe("supervisor_generation_stale");
		expect(lostOnDisk.message).toContain("no longer owns its registry entry");
		expect(lostOnDisk.message).toContain(paths.socketPath);
		expect(lostOnDisk.message).toContain(paths.registryDir);
		expect(lostOnDisk.message).toContain("sessions are preserved");
		expect(lostOnDisk.message).not.toBe(neverAcquired.message);
		await ownership.release();
	});
});
