#!/usr/bin/env node
// spatial-git CLI — Extract git history and launch 3D visualization
// Usage: spatial-git [repo-path] [--commits N] [--port N] [--no-open]

const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--commits' && args[i + 1]) {
    flags.commits = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--port' && args[i + 1]) {
    flags.port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--no-open') {
    flags.noOpen = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
spatial-git - Navigate code history through 3D space

Usage:
  spatial-git [repo-path] [options]

Options:
  --commits N    Max commits to extract (default: 200)
  --port N       Server port (default: 7742)
  --no-open      Don't auto-open browser
  -h, --help     Show this help

Examples:
  spatial-git                    # Current directory
  spatial-git ~/projects/myapp   # Specific repo
  spatial-git . --commits 500    # More history
`);
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    positional.push(args[i]);
  }
}

const repoPath = path.resolve(positional[0] || '.');
const maxCommits = flags.commits || 200;
const port = flags.port || 7742;
const noOpen = flags.noOpen || false;

// Verify git repo
if (!fs.existsSync(path.join(repoPath, '.git'))) {
  console.error(`Not a git repository: ${repoPath}`);
  process.exit(1);
}

console.log(`Extracting git history from ${repoPath}...`);

// Extract git data directly in Node (no shell script dependency)
function extractGitData(repoPath, maxCommits) {
  const opts = { cwd: repoPath, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 };

  // Get branches
  let branchOutput;
  try {
    branchOutput = execSync(
      "git branch -a --format='%(refname:short)' | grep -v HEAD | head -20",
      opts
    ).trim();
  } catch {
    branchOutput = 'main';
  }
  const branches = branchOutput.split('\n').filter(Boolean).map(b => b.replace(/^origin\//, ''));
  const uniqueBranches = [...new Set(branches)];

  // Get commits
  const logFormat = '%H|%an|%aI|%s|%P';
  let logOutput;
  try {
    logOutput = execSync(
      `git log --all --pretty=format:"${logFormat}" -n ${maxCommits}`,
      opts
    ).trim();
  } catch {
    console.error('Failed to read git log');
    process.exit(1);
  }

  const commits = [];
  const lines = logOutput.split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;

    const [fullHash, author, date, message, parentsRaw] = parts;
    const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];

    // Determine branch
    let branch = 'main';
    try {
      const branchResult = execSync(
        `git branch -a --contains ${fullHash} 2>/dev/null | head -1`,
        { ...opts, timeout: 5000 }
      ).trim().replace(/^[* ]+/, '').replace(/^remotes\/origin\//, '');
      if (branchResult) branch = branchResult;
    } catch {
      // Use default
    }

    // Get changed files
    let files = [];
    try {
      const fileOutput = execSync(
        `git show --name-status --format="" ${fullHash} 2>/dev/null | head -20`,
        { ...opts, timeout: 5000 }
      ).trim();
      if (fileOutput) {
        files = fileOutput.split('\n').filter(Boolean).map(line => {
          const [status, ...pathParts] = line.split('\t');
          const filePath = pathParts[pathParts.length - 1] || pathParts[0] || '';
          let type = 'modified';
          if (status === 'A') type = 'added';
          else if (status === 'D') type = 'deleted';
          else if (status && status.startsWith('R')) type = 'renamed';
          return { path: filePath, type };
        });
      }
    } catch {
      // Skip file details for this commit
    }

    // Get diff stats for richer data
    let additions = 0, deletions = 0;
    try {
      const statOutput = execSync(
        `git show --stat --format="" ${fullHash} 2>/dev/null | tail -1`,
        { ...opts, timeout: 5000 }
      ).trim();
      const addMatch = statOutput.match(/(\d+) insertion/);
      const delMatch = statOutput.match(/(\d+) deletion/);
      if (addMatch) additions = parseInt(addMatch[1], 10);
      if (delMatch) deletions = parseInt(delMatch[1], 10);
    } catch {
      // Skip
    }

    commits.push({
      hash: fullHash.substring(0, 7),
      fullHash,
      author,
      date,
      message: message || '(no message)',
      branch,
      parents: parents.map(p => p.substring(0, 7)),
      files,
      additions,
      deletions
    });
  }

  return { branches: uniqueBranches, commits };
}

const data = extractGitData(repoPath, maxCommits);
console.log(`Extracted ${data.commits.length} commits across ${data.branches.length} branches`);

// Find the spatial-git assets
const assetDir = __dirname;
const indexPath = path.join(assetDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('index.html not found. Ensure spatial-git is properly installed.');
  process.exit(1);
}

// Serve
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${port}`);
  let filePath = parsed.pathname;

  // Serve extracted git data
  if (filePath === '/git-history.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
    return;
  }

  // Serve diff data for a specific commit
  if (filePath.startsWith('/api/diff/')) {
    const hash = filePath.replace('/api/diff/', '');
    try {
      const diff = execSync(
        `git show --format="" ${hash}`,
        { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024, timeout: 10000 }
      );
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(diff.substring(0, 100000)); // Cap at 100KB
    } catch {
      res.writeHead(404);
      res.end('Commit not found');
    }
    return;
  }

  // Static files
  if (filePath === '/' || filePath === '/index.html') {
    filePath = '/index.html';
  }

  const fullPath = path.join(assetDir, filePath);
  const ext = path.extname(fullPath);

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  const url = `http://localhost:${port}`;
  const repoName = path.basename(repoPath);
  console.log(`
  Spatial Git is running at ${url}
  Repository: ${repoName} (${data.commits.length} commits)

  Controls:
    WASD      Move around
    Mouse     Look around
    Click     Select commit
    /         Search commits (Cmd+K)
    Space     Play/pause time travel
    V         Enter VR mode
    M         Toggle sound

  Press Ctrl+C to stop
`);

  if (!noOpen) {
    // Auto-open browser
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    try {
      execSync(`${openCmd} ${url}`, { stdio: 'ignore' });
    } catch {
      // Silently fail if can't open browser
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is in use. Try: spatial-git --port ${port + 1}`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
