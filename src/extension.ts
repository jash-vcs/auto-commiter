import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import simpleGit from "simple-git";
import { GoogleGenerativeAI } from "@google/generative-ai";
import chokidar from "chokidar";

// const INTERVAL = 30 * 60 * 1000; // 30 minutes
const INTERVAL = 60 * 1000; // 1 minute
const genAI = new GoogleGenerativeAI("AIzaSyC_ZXJb3JgX1Bj09JNcWBfXhefoTbSBrkQ");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let changedFilesGlobal: Map<string, Set<string>> = new Map();

function getGitIgnorePatterns(workspacePath: string): string[] {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    return content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(pattern => pattern.startsWith('/') ? pattern.slice(1) : pattern);
  }
  return [];
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("Please open a workspace to enable tracking.");
    return;
  }

  const gitInstances = new Map<string, any>();
  const watchers = new Map<string, any>();

  for (const folder of workspaceFolders) {
    const workspacePath = folder.uri.fsPath;
    const codeTrackingRepoPath = path.join(workspacePath, ".code-tracking");

    // Initialize Git in the code-tracking folder if it doesn't exist
    if (!fs.existsSync(codeTrackingRepoPath)) {
      fs.mkdirSync(codeTrackingRepoPath, { recursive: true });
      const git = simpleGit(codeTrackingRepoPath);
      await git.init();
    }

    const git = simpleGit(codeTrackingRepoPath);
    gitInstances.set(workspacePath, git);

    // Get .gitignore patterns
    const gitIgnorePatterns = getGitIgnorePatterns(workspacePath);

    // Common patterns to ignore
    const defaultIgnores = [
      codeTrackingRepoPath,
      "**/node_modules/**",
      "**/.git/**",
      "**/__pycache__/**",
      "**/venv/**",
      "**/env/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/.vs/**",
      "**/.vscode/**",
      "**/.idea/**",
      "**/*.log",
      "**/.DS_Store",
      "**/coverage/**",
      "**/tmp/**",
      "**/temp/**",
      "**/.next/**",
      "**/.cache/**",
      "**/*.pyc",
      "**/*.pyo",
      "**/*.pyd",
      "**/*.so",
      "**/*.dll",
      "**/*.dylib",
      "**/bin/**",
      "**/obj/**"
    ];

    // Combine default ignores with .gitignore patterns
    const allIgnores = [...defaultIgnores, ...gitIgnorePatterns.map(p => `**/${p}`)];

    // Monitor changes in the workspace folder
    const watcher = chokidar.watch(workspacePath, {
      ignored: allIgnores,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false
    });

    const changedFiles: Set<string> = new Set();
    changedFilesGlobal.set(workspacePath, changedFiles);

    watcher.on("change", (filePath) => {
      changedFiles.add(filePath);
    });

    watcher.on("add", (filePath) => {
      changedFiles.add(filePath);
    });

    watchers.set(workspacePath, watcher);

    // Automatically commit changes every interval
    setInterval(async () => {
      await commitChanges(workspacePath, gitInstances, changedFiles);
    }, INTERVAL);
  }

  // Final commit and push on VS Code close
  context.subscriptions.push(vscode.window.onDidCloseTerminal(async () => {
    console.log("VS Code is closing, performing final commit.");
    for (const folder of workspaceFolders) {
      const workspacePath = folder.uri.fsPath;
      await commitChanges(workspacePath, gitInstances, changedFilesGlobal.get(workspacePath) || new Set());
    }
  }));

  vscode.window.showInformationMessage("GitHub Productivity Extension activated !");
}

async function commitChanges(workspacePath: string, gitInstances: Map<string, any>, changedFiles: Set<string>) {
  if (changedFiles.size === 0) {
    console.log(`No changes detected in ${workspacePath} for the past 30 minutes.`);
    return;
  }

  const git = gitInstances.get(workspacePath);
  const now = new Date();
  const codeTrackingRepoPath = path.join(workspacePath, "code-tracking");

  // Copy changed files into the code-tracking folder
  for (const filePath of changedFiles) {
    const relativePath = path.relative(workspacePath, filePath);
    const destPath = path.join(codeTrackingRepoPath, relativePath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(filePath, destPath);
  }

  // Generate a commit message using Gemini AI
  try {
    const summary = await model.generateContent(
      Array.from(changedFiles).map((file) => path.basename(file)).join(", ") +
        "\n" +
        "summarize the work done in the last 30 minutes and give me best suitable commit message for it describing the work done in the best and shortest way possible, no jargon, no other shit, just commit message"
    );
    const x = summary.response.text();

    await git.add(".");
    await git.commit(`${now.toISOString()} - ${x}`);
    vscode.window.showInformationMessage(`Code changes in ${workspacePath} committed with Gemini AI.`);
  } catch (error) {
    console.error("Gemini AI Error:", error);
    await git.add(".");
    await git.commit(`${now.toISOString()} - Changes in ${changedFiles.size} files`);
  }

  // Clear the tracked changes
  changedFiles.clear();
}

export function deactivate() {
  console.log("GitHub Productivity Extension deactivated.");
}
