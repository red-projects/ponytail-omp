default: test

test:
	bun build --target=node pi-extension/index.js > /dev/null
	grep -F -q 'ctx?.agent?.kind === "sub"' pi-extension/index.js
	bun -e 'import ext from "./pi-extension/index.js"; import assert from "node:assert"; const h = {}; ext({ on: (n, f) => { h[n] = f; }, registerCommand: () => {}, appendEntry: () => {} }); const fn = h["before_agent_start"]; assert(typeof fn === "function"); assert.strictEqual(await fn({}, { agent: { kind: "sub" } }), undefined); const mainRes = await fn({}, { agent: { kind: "main" } }); assert(mainRes && typeof mainRes.systemPrompt === "string");'
	@echo "ponytail omp-compat tests passed: syntax valid and subagent guard present."

sync-upstream:
	git fetch upstream main
	git checkout main
	git merge --ff-only upstream/main
	git checkout omp-compat
	git merge -m "Merge upstream/main into omp-compat" main
	just test
