# ws-affected

`ws-affected` is a command-line tool that helps you identify and/or run scripts only on npm workspaces affected by the changes on a git branch (default: current branch/commit). This script does not have any dependencies but node.js and git.

## Features

- Run scripts on workspaces and their dependents affected by changes on a branch
  
    This is useful on local development to run tests and lint only on workspaces that have changed

- List workspaces affected by changes on a branch

    This is useful for CI/CD scripts to determine affected workspaces to deploy

- List a single workspace's prod dependencies
  
    This is useful for CI/CD scripts for packaging only the prod dependencies of a single workspace / service


## Installation

You can run `ws-affected` directly using `npx`:

```sh
npx ws-affected [options]
```

## Usage

```
Usage: npx ws-affected [options]

Options:
  -r, --run <script>      Run the specified commands on affected workspaces (repeatable flag)
  -l, --list              List recursively the dependents (inclusive) of affected workspaces or workspaces selected by --workspace flag.
  -b, --base <branch>     The base branch to compare against (default: master)
  -h, --head <branch>     The head branch to compare for (default: HEAD)
  -c, --concurrency <n>   The number of concurrent tasks to run (default: 0 = number of CPUs)
  -u, --print-success     Print output for successful scripts as well
  -a, --all-workspaces    --run scripts on all workspaces
  -w, --workspace         --run scripts or --list dependencies of specific workspaces (repeatable flag)
  --list-dependencies     List recursively the dependencies (inclusive) of workspaces selected by --workspace flag.
  --dep-types         What dependencies to look at. Options: 'all' (default) or 'prod' or 'all' (default). 'prod' means "dependencies" and "peerDependencies" in package.json -d
  -h, --help              Show the help text

Examples:
  ws-affected --list
  ws-affected --run lint --run test --concurrency 4
  ws-affected --base main --run build
  ws-affected --run lint --run test --print-success

Workspace vs package

  They are synonyms as far as this tool is concerned.

Dependents vs Dependencies

  Dependents are the packages the depend on a given package. Dependencies are packages that a given package depends on.

  Let's say A depends on B, which depends on C, which depends on D, which depends on E. The tree looks like the following:

  A
  - B
    - C
      - D
        - E

  Focus on C for a moment (you can use --workspace C flag), and the following are definitions for some terms:

  - "Dependents" of C are A and B
  - "Dependents inclusive" of C are A, B and C
  - "Dependencies" of C are D and E.
  - "Dependencies inclusive" of C are C, D and E.

  "Affected workspaces" means the workspaces that was directly edited by changes on `--head` branch and the
  dependents of those workspaces.

A note about --workspace flag

  When --list or --list-dependencies is used, dependents/dependencies of \`--workspace\`s are included.
  When --run is used, only those \`--workspace\`s are used without including dependents/dependencies.

```
## Examples

### List workspaces affected by changes on current branch
```sh
npx ws-affected --list
# or npx ws-affected --list --base master --head HEAD
# or npx ws-affected --list --base origin/master --head origin/HEAD
```
```
workspace1
workspace3
```

### Run scripts on affected workspaces
```sh
npx ws-affected --run lint --run test
```
```
✓ lint:service1 (748ms)
✓ lint:service3 (1289ms)
✓ test:shared-lib (2816ms)

⏱️  Took 2.89s (3 tasks)
```

### Same command but show output for all scripts including successful ones
```sh
npx ws-affected --run lint --print-success
```
```
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

### List a single workspace's prod dependencies

```sh
npx ws-affected --workspace service1 --list-dependencies --dep-types prod
```
```
service1
shared-lib
```


### How it works

How it works:
- ws-affected reads the root package.json file to determine the workspaces directory.
- It creates a map of workspace dependencies by reading the package.json files of each workspace.
- It finds the point where the current branch diverged from the base branch (default: master).
- It runs git diff-tree to identify the files that have changed between the divergence point and the current branch.
- It determines the affected workspaces based on the changed files and their dependent workspaces.
- If the --list flag is used, it prints the affected workspaces.
- If the --run flag is used, it runs the specified scripts on the affected workspaces, respecting the concurrency limit.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
