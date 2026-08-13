import assert from "node:assert";
import { describe, it } from "node:test";

import { bumpVersion, type Component, Container } from "../src/tui.ts";

/** A versioned leaf: mutation calls bumpVersion and changes its output. */
class VersionedChild implements Component {
	version = 0;
	renderCount = 0;
	private lines: string[] = ["a"];

	render(_width: number): string[] {
		this.renderCount++;
		return this.lines;
	}
	invalidate(): void {}
	mutate(next: string[]): void {
		this.lines = next;
		bumpVersion(this);
	}
}

/** An unversioned leaf: the parent must never short-circuit it. */
class UnversionedChild implements Component {
	renderCount = 0;
	render(_width: number): string[] {
		this.renderCount++;
		return ["x"];
	}
	invalidate(): void {}
}

describe("Container version short-circuit", () => {
	it("reuses the same line-array reference when nothing changed", () => {
		const child = new VersionedChild();
		const container = new Container();
		container.addChild(child);

		const first = container.render(10);
		assert.strictEqual(child.renderCount, 1);

		const second = container.render(10);
		assert.strictEqual(second, first, "unchanged frame must return the cached array by reference");
		assert.strictEqual(child.renderCount, 1, "unchanged child must not re-render");
	});

	it("re-renders only the child whose version changed", () => {
		const a = new VersionedChild();
		const b = new VersionedChild();
		const container = new Container();
		container.addChild(a);
		container.addChild(b);
		container.render(10);
		assert.strictEqual(a.renderCount, 1);
		assert.strictEqual(b.renderCount, 1);

		a.mutate(["changed"]);
		const lines = container.render(10);
		assert.strictEqual(a.renderCount, 2, "mutated child re-renders");
		assert.strictEqual(b.renderCount, 1, "unmutated sibling is skipped");
		assert.deepStrictEqual(lines, ["changed", "a"]);
	});

	it("never short-circuits an unversioned child", () => {
		const child = new UnversionedChild();
		const container = new Container();
		container.addChild(child);
		container.render(10);
		container.render(10);
		container.render(10);
		assert.strictEqual(child.renderCount, 3, "unversioned child re-renders every frame");
	});

	it("re-renders on structural change (add/insert/remove/clear/truncate)", () => {
		const child = new VersionedChild();
		const container = new Container();
		container.addChild(child);
		container.render(10);
		assert.strictEqual(child.renderCount, 1);

		const extra = new VersionedChild();
		container.addChild(extra);
		container.render(10);
		assert.strictEqual(child.renderCount, 2, "addChild invalidates the container cache");

		container.removeChild(extra);
		container.render(10);
		assert.strictEqual(child.renderCount, 3, "removeChild invalidates the container cache");

		container.clear();
		container.render(10);
		assert.strictEqual(child.renderCount, 3, "cleared container renders nothing");
	});

	it("propagates a leaf bump up through nested containers", () => {
		const leaf = new VersionedChild();
		const mid = new Container();
		const top = new Container();
		mid.addChild(leaf);
		top.addChild(mid);
		top.render(10);

		const topBefore = top.version;
		const midBefore = mid.version;
		assert.notStrictEqual(topBefore, undefined);
		assert.notStrictEqual(midBefore, undefined);

		leaf.mutate(["new"]);
		assert.ok(top.version! > topBefore!, "top container version must increase");
		assert.ok(mid.version! > midBefore!, "mid container version must increase");
	});

	it("invalidate() bumps the whole chain", () => {
		const leaf = new VersionedChild();
		const container = new Container();
		container.addChild(leaf);
		container.render(10);
		const before = container.version;
		container.invalidate();
		assert.ok(container.version! > before!, "invalidate must bump the container version");
	});

	it("re-renders when the width changes", () => {
		const child = new VersionedChild();
		const container = new Container();
		container.addChild(child);
		container.render(10);
		container.render(20);
		assert.strictEqual(child.renderCount, 2, "width change must invalidate the cache");
	});
});
