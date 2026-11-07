default: test

test:
	bun build --target=node pi-extension/index.js > /dev/null
	grep -F -q 'ctx?.agent?.kind === "sub"' pi-extension/index.js
	@echo "ponytail omp-compat tests passed: syntax valid and subagent guard present."

sync-upstream:
	git fetch upstream main
	git checkout main
	git merge --ff-only upstream/main
	git checkout omp-compat
	git merge -m "Merge upstream/main into omp-compat" main
	just test
