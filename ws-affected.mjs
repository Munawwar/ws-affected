import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';

const options = {
  'show': {
    type: 'boolean',
    short: 's',
  },
  'run': {
    type: 'string',
    short: 'r',
    multiple: true,
  },
  'base': {
    type: 'string',
    short: 'b',
    default: 'master',
  },
  'head': {
    type: 'string',
    short: 'h',
    default: 'HEAD',
  },
  'concurrency': {
    type: 'string',
    short: 'c',
    default: '0'
  },
  'print-success': {
    type: 'boolean',
    short: 'u',
    description: 'Show output for successful scripts',
    default: false,
  },
  'help': {
    type: 'boolean',
    short: 'h',
    description: 'Show the help text',
    default: false,
  },
};

const helpText = `
Usage: npx ws-affected [options]

Options:
  -s, --show              Show the affected workspaces
  -r, --run <script>      Run the specified commands on affected workspaces (repeatable flag)
  -b, --base <branch>     The base branch to compare against (default: master)
  -h, --head <branch>     The head branch to compare from (default: HEAD)
  -c, --concurrency <n>   The number of concurrent tasks to run (default: 0 = number of CPUs)
  -u, --print-success     Show output for successful scripts as well
  -h, --help              Show the help text

Examples:
  ws-affected --show
  ws-affected --run lint --run test --concurrency 4
  ws-affected --base main --run build
  ws-affected --run lint --run test --print-success
`;

let values;

try {
  values = parseArgs({ options }).values;
} catch (error) {
  console.log(helpText);
  process.exit(0);
}

if (values.help) {
  console.log(helpText);
  process.exit(0);
}

if (values.show === undefined && !values.run?.length) {
  console.log('Please specify at least one script to run with --run flag or use the --show option to see affected workspaces.');
  console.log(helpText);
  process.exit(1);
}

// Read the root package.json file
const rootPackageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// Get the workspaces directory from the root package.json
const workspacesDir = rootPackageJson.workspaces.map(dir => dir.replace('/*', ''));

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
  depTypes.forEach(depType => {
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
workspacesDir.forEach(wsDir => {
  fs.readdirSync(wsDir).forEach(subDirName => {
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
      dependencies
    };
  });
});

// Filter out other npm package names from dependencies
workspaceInfoByName = Object.entries(workspaceInfoByName).reduce((acc, [name, { dependencies, ...rest }]) => {
  acc[name] = {
    dependencies: Object.entries(dependencies).reduce((acc2, [depType, depNames]) => {
      acc2[depType] = depNames.filter(name => Boolean(workspaceInfoByName[name]));
      return acc2;
    }, {}),
    ...rest
  };
  return acc;
}, {});

// Find the point from where this current branch diverged from base branch (master)
// Note: The head branch may not have been rebased to base branch. And so we need to
// find the exact commit from which head branch diverged from.
const baseBranchCommitHashes = execSync(`git rev-list --first-parent "${values.base}"`).toString().trim().split('\n');
const headCommitHashes = execSync(`git rev-list --first-parent "\${2:-${values.head}}"`).toString().trim().split('\n');
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
  // console.log('No common commit hash found. Exiting...');
  process.exit(0);
}

// Run the git diff-tree command with the obtained commit hash
const gitCommand = `git diff-tree --no-commit-id --name-only -r ${commitHash} ${values.head}`;
const affectedFiles = execSync(gitCommand).toString().trim().split('\n');
// Find affected workspaces
const affectedWorkspaces = new Set();
const workspaceConfigs = Object.values(workspaceInfoByName);
affectedFiles.forEach(file => {
  const workspace = workspaceConfigs.find(({ dir }) => file.startsWith(dir + path.sep));
  if (workspace) {
    affectedWorkspaces.add(workspace.name);
  }
});

/**
 * Function to get all workspaces dependent on a workspace (including itself)
 * @param {string} workspaceName - The name of the workspace
 * @returns {Set<string>} - The set of dependent workspaces
 */
function getDependentWorkspaces(workspaceName) {
  const dependentWorkspaces = new Set([workspaceName]);
  Object.entries(workspaceInfoByName).forEach(([name, { dependencies }]) => {
    const allDependencies = Object.values(dependencies).flat();
    if (allDependencies.includes(workspaceName)) {
      dependentWorkspaces.add(name);
    }
  });
  return dependentWorkspaces;
}

// Print affected workspaces and their dependent workspaces
const affectedSet = new Set();
affectedWorkspaces.forEach(workspaceName => {
  const dependentWorkspaces = getDependentWorkspaces(workspaceName);
  dependentWorkspaces.forEach((value) => {
    affectedSet.add(value);
  })
});
const uniqueAffected = [...affectedSet];

if (values.show) {
  console.log(uniqueAffected.join('\n'));
} else if (values.run) {
  const spawnAsync = (command, options) => new Promise((resolve) => {
    const child = spawn(command, {
      ...options,
      shell: true,
      env: {
        ...process.env,
        'FORCE_COLOR': '1',
      }
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
  let concurrency = parseInt(values.concurrency, 10) || 0;
  if (concurrency === 0) {
    concurrency = os.cpus().length;
  } else if (concurrency < 0) {
    concurrency = Math.max(1, os.cpus().length + concurrency);
  }
  const promises = [];

  // Run the commands in parallel
  let activeCount = 0;
  const initialStartTime = Date.now();
  let commandCount = 0;
  const failedScripts = [];
  for (const workspace of uniqueAffected) {
    for (const script of scriptsToRun) {
      const promise = (async () => {
        const scriptName = script.split(' ')[0];
        const command = workspaceInfoByName[workspace].scripts[scriptName] || '';
        const startTime = Date.now();
        let elapsedTime;
        let error;

        if (!command) return;
        commandCount++;

        const { code, output } = await spawnAsync(`npm run -w ${workspace} --if-present ${script}`, {
          encoding: 'utf8',
          cwd: workspaceInfoByName[workspace].dir,
        });
        elapsedTime = Date.now() - startTime;

        if (code !== 0) {
          process.exitCode = 1;
          console.log(`\x1b[1m\x1b[31m✖ ${scriptName}:${workspace} \x1b[33m$\x1b[0m npm run -w ${workspace} --if-present ${script}`);
          if (output.length > 0) {
            console.log(`${output.split('\n').map(line => `\x1b[31m│\x1b[0m ${line}`).join('\n')}`);
          }
          console.log(`\x1b[31m└─ \x1b[1m\x1b[31mFailed\x1b[0m \x1B[2m(${elapsedTime}ms)\x1b[0m${values['print-success'] ? '\n' : ''}`);
          failedScripts.push(`\x1b[1m\x1b[31m✖ ${scriptName}:${workspace} failed\x1b[0m`);
        } else if (values['print-success']) {
          console.log(`\x1b[1m\x1b[32m✓\x1b[0m ${scriptName}:${workspace} \x1b[33m$\x1b[0m npm run -w ${workspace} --if-present ${script}`);
          if (output.length > 0) {
            console.log(`${output.split('\n').map(line => `\x1b[32m│\x1b[0m ${line}`).join('\n')}`);
          }
          console.log(`\x1b[32m└─ \x1b[1m\x1b[32mSuccess\x1b[0m \x1B[2m(${elapsedTime}ms)\x1b[0m\n`);
        } else {
          console.log(`\x1b[1m\x1b[32m✓\x1b[0m ${scriptName}:${workspace} \x1B[2m(${elapsedTime}ms)\x1b[0m`);
        }
      })();
      promises.push(promise);
      activeCount++;

      if (activeCount >= concurrency) {
        await Promise.race(promises);
        activeCount--;
      }
    }
  }
  await Promise.all(promises);

  // Show total time taken
  const totalTimeTaken = Date.now() - initialStartTime;
  let message = "\n⏱️  Took ";

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
    console.log('\n' + failedScripts.join('\n'));
  }
}