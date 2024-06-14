#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const options = {
  run: {
    type: 'string',
    short: 'r',
    multiple: true,
  },
  list: {
    type: 'boolean',
    short: 'l',
  },
  // This is an awkward flag that doesn't really belong in a tool named "affected"
  // however I'd rather have this hack over implementing another tool for this
  'list-dependencies': {
    type: 'boolean',
  },
  // This is yet another hack to be used with --list-dependencies to list prod dependencies
  'dep-types': {
    type: 'string',
    default: 'all',
  },
  base: {
    type: 'string',
    short: 'b',
    default: 'master',
  },
  head: {
    type: 'string',
    short: 'h',
    default: 'HEAD',
  },
  concurrency: {
    type: 'string',
    short: 'c',
    default: '0',
  },
  'print-success': {
    type: 'boolean',
    short: 'u',
    description: 'Show output for successful scripts',
    default: false,
  },
  'all-workspaces': {
    type: 'boolean',
    short: 'a',
    description: 'Run scripts on all workspaces',
    default: false,
  },
  workspace: {
    type: 'string',
    short: 'w',
    description: 'Run scripts on specific workspaces',
    multiple: true,
  },
  help: {
    type: 'boolean',
    short: 'h',
    description: 'Show the help text',
    default: false,
  },
};

const helpText = `
Usage: npx ws-affected [options]

Options:
  -r, --run <script>      Run the specified commands on affected workspaces (repeatable flag)
  -l, --list              List recursively the dependents (inclusive) of affected workspaces or workspaces selected by --workspace flag
  -b, --base <branch>     The base branch to compare against (default: master)
  -h, --head <branch>     The head branch to compare for (default: HEAD)
  -c, --concurrency <n>   The number of concurrent tasks to run (default: 0 = number of CPUs)
  -u, --print-success     Print output for successful scripts as well
  -a, --all-workspaces    --run scripts on all workspaces
  -w, --workspace         --run scripts or --list dependencies of specific workspaces (repeatable flag)
  --list-dependencies     List recursively the dependencies (inclusive) of workspaces selected by --workspace flag
  --dep-types             What dependencies to look at. Options: 'all' (default) or 'prod'. 'prod' means "dependencies" and "peerDependencies" in package.json
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

  "Affected workspaces" means the workspaces that was directly edited by changes on \`--head\` branch and the
  dependents of those workspaces.

A note about --workspace flag

  When --list or --list-dependencies is used, dependents/dependencies of \`--workspace\`s are included.
  When --run is used, only those \`--workspace\`s are used without including dependents/dependencies.
`;

let values;

try {
  values = parseArgs({ options }).values;
} catch (error) {
  console.error(error.message);
  console.log(helpText);
  process.exit(1);
}

if (values.help) {
  console.log(helpText);
  process.exit(0);
}

// Read the root package.json file
let rootPackageJson;
try {
  rootPackageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
} catch (e) {
  console.error(
    '\x1b[31mFailed to read package.json file. Either it is missing or the file is not a valid JSON file.\x1b[0m',
  );
  process.exit(1);
}

if (!rootPackageJson.workspaces) {
  console.error('\x1b[31mThis project does not have a "workspaces" field in package.json\x1b[0m');
  process.exit(1);
}

if (values.list === undefined && values['list-dependencies'] === undefined && !values.run?.length) {
  console.error('\x1b[31mPlease specify --run or --list or --list-dependencies flag.\x1b[0m');
  console.log(helpText);
  process.exit(1);
}

if (values['list-dependencies'] && !values.workspace) {
  console.error('\x1b[31m--list-dependencies option also need --workspace flag specified.\x1b[0m');
  process.exit(1);
}

// Get the workspaces directory from the root package.json
const workspacesDir = rootPackageJson.workspaces.map((dir) => dir.replace('/*', ''));

// Function to read package.json of a workspace
function readPackageJson(workspaceDir) {
  const packageJsonPath = path.join(workspaceDir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * @typedef {'dependencies' |'devDependencies' |'peerDependencies' |'optionalDependencies'} DepTypes
 */
const depTypes = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/**
 * Function to get dependencies of a workspace from the package.json file
 * @param {string} workspacePackageJson - The package.json file of the workspace
 * @returns {Record<DepTypes, string[]>} - The dependencies of the workspace
 */
function getWorkspaceDependencies(workspacePackageJson) {
  const dependencies = {};
  depTypes.forEach((depType) => {
    if (workspacePackageJson[depType]) {
      dependencies[depType] = Object.keys(workspacePackageJson[depType]);
    } else {
      dependencies[depType] = [];
    }
  });
  return dependencies;
}

/**
 * Create a map of workspace dependencies
 * @type {{
 *   [workspaceName: string]: {
 *     name: string,
 *     dir: string,
 *     scripts: Record<string, string>,
 *     dependencies: Record<DepTypes, string[]>,
 *   }
 * }}
 */
let workspaceInfoByName = {};
workspacesDir.forEach((wsDir) => {
  fs.readdirSync(wsDir).forEach((subDirName) => {
    const subDirPath = path.join(wsDir, subDirName);
    if (!fs.statSync(subDirPath).isDirectory()) return;
    // console.log({subDirPath})
    const workspacePackageJson = readPackageJson(subDirPath);
    if (workspacePackageJson === null) return;

    const workspaceName = workspacePackageJson.name;
    const dependencies = getWorkspaceDependencies(workspacePackageJson);
    workspaceInfoByName[workspaceName] = {
      name: workspaceName,
      dir: subDirPath,
      scripts: workspacePackageJson.scripts,
      dependencies,
    };
  });
});

// Filter out other npm package names from dependencies
workspaceInfoByName = Object.entries(workspaceInfoByName).reduce(
  (acc, [name, { dependencies, ...rest }]) => {
    acc[name] = {
      dependencies: Object.entries(dependencies).reduce((acc2, [depType, depNames]) => {
        acc2[depType] = depNames.filter((name) => Boolean(workspaceInfoByName[name]));
        return acc2;
      }, {}),
      ...rest,
    };
    return acc;
  },
  {},
);

/**
 * Function to get all workspaces dependent on a workspace
 * @param {string} workspaceName - The name of the workspace
 * @param {object} [options]
 * @param {'all' | 'prod'} [options.depTypes='all'] 'prod' dependencies is "dependencies" and "peerDependencies" in package.json
 * @param {boolean} [options.inclusive=false] If true, includes `workspaceName` in the list of dependents
 * @returns {Set<string>} - The set of dependent workspaces
 */
function findDependents(workspaceName, { depTypes = 'all', inclusive = false } = {}) {
  const deps = new Set([]);
  if (workspaceInfoByName[workspaceName] && inclusive) {
    deps.add(workspaceName);
  }
  Object.entries(workspaceInfoByName).forEach(([name, { dependencies }]) => {
    let selectedDependencies;
    if (depTypes === 'all') {
      selectedDependencies = Object.values(dependencies).flat();
    } else if (depTypes === 'prod') {
      selectedDependencies = dependencies.dependencies.concat(dependencies.peerDependencies);
    }
    if (selectedDependencies.includes(workspaceName)) {
      deps.add(name);
    }
  });
  return deps;
}

/**
 * Function to get recursive dependencies of a workspace
 * @param {string} workspaceName - The name of the workspace
 * @param {object} [options]
 * @param {'all' | 'prod'} [options.depTypes='all'] 'prod' dependencies is "dependencies" and "peerDependencies" in package.json
 * @param {boolean} [options.inclusive=false] If true, includes `workspaceName` in the list of dependencies
 * @returns {Set<string>} - The set of dependent workspaces
 */
function findDependencies(workspaceName, { depTypes = 'all', inclusive = false } = {}) {
  const deps = new Set([]);
  if (workspaceInfoByName[workspaceName] && inclusive) {
    deps.add(workspaceName);
  }
  const { dependencies } = workspaceInfoByName[workspaceName];
  let selectedDependencies;
  if (depTypes === 'all') {
    selectedDependencies = Object.values(dependencies).flat();
  } else if (depTypes === 'prod') {
    selectedDependencies = dependencies.dependencies.concat(dependencies.peerDependencies);
  }
  selectedDependencies.forEach((name) => deps.add(name));
  return deps;
}

// --- Filtering workspaces ---

let filteredWorkspaces;
if (values['all-workspaces']) {
  filteredWorkspaces = Object.keys(workspaceInfoByName);
} else if (values.workspace) {
  filteredWorkspaces = values.workspace;
} else {
  // Find the point from where this current branch diverged from base branch (master)
  // Note: The head branch may not have been rebased to base branch. And so we need to
  // find the exact commit from which head branch diverged from.
  const baseBranchCommitHashes = execSync(`git rev-list --first-parent "${values.base}"`)
    .toString()
    .trim()
    .split('\n');
  const headCommitHashes = execSync(`git rev-list --first-parent "\${2:-${values.head}}"`)
    .toString()
    .trim()
    .split('\n');
  // Find the first differing commit hash between the two branches
  let commitHash = '';
  for (let i = 0; i < Math.min(baseBranchCommitHashes.length, headCommitHashes.length); i++) {
    if (baseBranchCommitHashes[i] !== headCommitHashes[i]) {
      commitHash = baseBranchCommitHashes[i];
      break;
    }
  }
  // console.log({commitHash})
  if (!commitHash) {
    console.warn('\x1b[33mNo common commit hash found. Exiting...\x1b[0m');
    process.exit(0);
  }

  // Run the git diff-tree command with the obtained commit hash
  const gitCommand = `git diff-tree --no-commit-id --name-only -r ${commitHash} ${values.head}`;
  const affectedFiles = execSync(gitCommand).toString().trim().split('\n');
  // Find affected workspaces
  const affectedWorkspaces = new Set();
  const workspaceConfigs = Object.values(workspaceInfoByName);
  affectedFiles.forEach((file) => {
    const workspace = workspaceConfigs.find(({ dir }) => file.startsWith(dir + path.sep));
    if (workspace) {
      affectedWorkspaces.add(workspace.name);
    }
  });

  // Find affected workspaces and their dependent workspaces
  const affectedSet = new Set();
  affectedWorkspaces.forEach((workspaceName) => {
    findDependents(workspaceName, { depTypes: 'all', inclusive: true }).forEach((value) =>
      affectedSet.add(value),
    );
  });
  filteredWorkspaces = [...affectedSet];
}

// --- Operations ---

if (values.list || values['list-dependencies']) {
  // Remember a difference in behavior exists between --list, --list-dependencies and --run for --workspace.
  // When --list or --list-dependencies is used, dependents/dependencies of `--workspace`s are included.
  // When --run is used, only those `--workspace`s are run without including dependents/dependencies
  if (values.workspace) {
    const deps = new Set([]);
    values.workspace.forEach((workspaceName) => {
      if (values.list) {
        findDependents(workspaceName, {
          depTypes: values['dep-types'],
          inclusive: true,
        }).forEach((name) => deps.add(name));
      } else if (values['list-dependencies']) {
        findDependencies(workspaceName, {
          depTypes: values['dep-types'],
          inclusive: true,
        }).forEach((name) => deps.add(name));
      }
    });
    filteredWorkspaces = [...deps];
  }
  if (filteredWorkspaces.length) {
    console.log(filteredWorkspaces.join('\n'));
  }
} else if (values.run) {
  const spawnAsync = (command, options) =>
    new Promise((resolve) => {
      const child = spawn(command, {
        ...options,
        shell: true,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
        },
      });
      // Create a buffer to store the combined output
      let outputBuffer = '';
      // Stream stdout and stderr to the combined output buffer
      child.stdout.on('data', (data) => {
        outputBuffer += data.toString();
      });
      child.stderr.on('data', (data) => {
        outputBuffer += data.toString();
      });
      // Handle the command completion
      child.on('close', (code) => {
        resolve({ code, output: outputBuffer.trim() });
      });
    });

  const scriptsToRun = values.run;
  let concurrency = Number.parseInt(values.concurrency, 10) || 0;
  if (concurrency === 0) {
    concurrency = os.cpus().length;
  } else if (concurrency < 0) {
    concurrency = Math.max(1, os.cpus().length + concurrency);
  }
  const promises = [];
  const promiseIdPosition = [];
  let idGen = 1;

  // Run the commands in parallel
  const initialStartTime = Date.now();
  let commandCount = 0;
  const failedScripts = [];
  for (const workspace of filteredWorkspaces) {
    for (const script of scriptsToRun) {
      const id = idGen++;
      const promise = (async () => {
        const scriptName = script.split(' ')[0];
        const command = workspaceInfoByName[workspace].scripts[scriptName] || '';
        const startTime = Date.now();
        let elapsedTime;
        let error;

        if (!command) return id;
        commandCount++;

        const { code, output } = await spawnAsync(
          `npm run -w ${workspace} --if-present ${script}`,
          {
            encoding: 'utf8',
            cwd: workspaceInfoByName[workspace].dir,
          },
        );
        elapsedTime = Date.now() - startTime;

        if (code !== 0) {
          process.exitCode = 1;
          console.log(
            `\x1b[1m\x1b[31m✖ ${scriptName}:${workspace} \x1b[33m$\x1b[0m npm run -w ${workspace} --if-present ${script}`,
          );
          if (output.length > 0) {
            console.log(
              `${output
                .split('\n')
                .map((line) => `\x1b[31m│\x1b[0m ${line}`)
                .join('\n')}`,
            );
          }
          console.log(
            `\x1b[31m└─ \x1b[1m\x1b[31mFailed\x1b[0m \x1B[2m(${elapsedTime}ms)\x1b[0m${values['print-success'] ? '\n' : ''}`,
          );
          failedScripts.push(`\x1b[1m\x1b[31m✖ ${scriptName}:${workspace} failed\x1b[0m`);
        } else if (values['print-success']) {
          console.log(
            `\x1b[1m\x1b[32m✓\x1b[0m ${scriptName}:${workspace} \x1b[33m$\x1b[0m npm run -w ${workspace} --if-present ${script}`,
          );
          if (output.length > 0) {
            console.log(
              `${output
                .split('\n')
                .map((line) => `\x1b[32m│\x1b[0m ${line}`)
                .join('\n')}`,
            );
          }
          console.log(
            `\x1b[32m└─ \x1b[1m\x1b[32mSuccess\x1b[0m \x1B[2m(${elapsedTime}ms)\x1b[0m\n`,
          );
        } else {
          console.log(
            `\x1b[1m\x1b[32m✔\x1b[0m ${scriptName}:${workspace} \x1B[2m(${elapsedTime}ms)\x1b[0m`,
          );
        }
        return id;
      })();
      promises.push(promise);
      promiseIdPosition.push(id);

      if (promises.length >= concurrency) {
        const id = await Promise.race(promises);
        const index = promiseIdPosition.indexOf(id);
        promises.splice(index, 1);
        promiseIdPosition.splice(index, 1);
      }
    }
  }
  await Promise.all(promises);

  // Show total time taken
  const totalTimeTaken = Date.now() - initialStartTime;
  let message = '\n⏱️  Took ';

  if (totalTimeTaken < 60000) {
    const elapsedSeconds = totalTimeTaken / 1000;
    message += `${elapsedSeconds.toFixed(2)}s`;
  } else if (totalTimeTaken < 3600000) {
    const elapsedMinutes = Math.floor(totalTimeTaken / 60000);
    const remainingSeconds = Math.floor((totalTimeTaken % 60000) / 1000);
    message += `${elapsedMinutes}m ${remainingSeconds}s`;
  } else {
    const elapsedHours = Math.floor(totalTimeTaken / 3600000);
    const remainingMinutes = Math.floor((totalTimeTaken % 3600000) / 60000);
    message += `${elapsedHours}h ${remainingMinutes}m`;
  }

  message += ` (${commandCount} tasks)`;
  console.log(message, '\x1b[32m');

  if (failedScripts.length > 0) {
    console.log(`\n${failedScripts.join('\n')}`);
  }
}
