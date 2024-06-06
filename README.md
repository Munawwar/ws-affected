# ws-affected

`ws-affected` is a command-line tool that helps you identify and/or run scripts only on npm workspaces affected by the changes on a git branch (default: current branch/commit). This script does not have any dependencies but node.js and git.

## Features

- Run scripts on workspaces and their dependents affected by changes on a branch
- Print workspaces affected by changes on a branch (useful for CI/CD scripts)

## Installation

You can run `ws-affected` directly using `npx`:

```bash
npx ws-affected [options]
```

## Usage

```
Usage: npx ws-affected [options]

Options:
  -s, --show              Show the affected workspaces
  -r, --run <script>      Run the specified commands on affected workspaces (repeatable flag)
  -b, --base <branch>     The base branch to compare against (default: master)
  -h, --head <branch>     The head branch to compare for (default: HEAD)
  -c, --concurrency <n>   The number of concurrent tasks to run (default: 0 = number of CPUs)
  -u, --print-success     Show output for successful scripts as well
  -h, --help              Show the help text
```
## Examples

### Show affected workspaces
```
npx ws-affected --show

workspace1
workspace3
```

### Run scripts on affected workspaces
```
npx ws-affected --run lint --run test

✓ lint:service1 (748ms)
✓ lint:service3 (1289ms)
✓ test:shared-lib (2816ms)

⏱️  Took 2.89s (3 tasks)
```

### Same command but show output for all scripts including successful ones
```
npx ws-affected --run lint --print-success

✓ lint:service1 $ npm run -w service1 --if-present lint
│ > service1@0.1.0 lint
│ > ./scripts/lint.sh
└─ Success (748ms)

✓ lint:service3 $ npm run -w service3 --if-present lint
│ > service3@0.1.0 lint
│ > ./scripts/lint.sh
└─ Success (1289ms)

⏱️  Took 2.03s (2 tasks)
```

### How it works

How it works:
- ws-affected reads the root package.json file to determine the workspaces directory.
- It creates a map of workspace dependencies by reading the package.json files of each workspace.
- It finds the point where the current branch diverged from the base branch (default: master).
- It runs git diff-tree to identify the files that have changed between the divergence point and the current branch.
- It determines the affected workspaces based on the changed files and their dependent workspaces.
- If the --show flag is used, it prints the affected workspaces.
- If the --run flag is used, it runs the specified scripts on the affected workspaces, respecting the concurrency limit.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
