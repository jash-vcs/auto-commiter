import * as vscode from "vscode";
import { SimpleGit, simpleGit } from "simple-git";
import moment from "moment";
import * as fs from "fs";
import * as path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";

dotenv.config();

let COMMIT_INTERVAL = 60 * 1000; // 1 minute
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

function getCommitIntervalFromSettings(): number {
  const config = vscode.workspace.getConfiguration("gitAutoCommit");
  const interval = config.get<number>("interval") || 60 * 1000; // Default to 1 minute if not set
  return interval;
}

/**
 * Initializes Git in the workspace if not already initialized.
 */
async function initializeGit(workspacePath: string): Promise<SimpleGit> {
  const gitPath = path.join(workspacePath, ".git");
  const git = simpleGit(workspacePath);

  if (!fs.existsSync(gitPath)) {
    await git.init();
    vscode.window.showInformationMessage(`Git initialized in ${workspacePath}`);
  }
  return git;
}

/**
 * Gets the list of changed files and their diffs tracked by Git.
 */
async function getChangedFilesWithDiffs(
  git: SimpleGit
): Promise<Map<string, string>> {
  const status = await git.status();
  console.log(status);
  const changedFilesWithDiffs = new Map<string, string>();

  const files = [
    ...status.staged,
    ...status.not_added,
    ...status.modified,
    ...status.created,
    ...status.deleted.map((file) => file),
    ...status.renamed.map((file) => file.to),
  ];

  for (const file of files) {
    try {
      // Get the diff for each file
      await git.diff(["--", file], (err, diff) => {
        console.log("err", err);
        console.log("diff", diff);
        changedFilesWithDiffs.set(file, diff);
      });
    } catch (error) {
      console.error(`Failed to get diff for file ${file}:`, error);
    }
  }

  return changedFilesWithDiffs;
}

/**
 * Gets the last commit message from the Git repository.
 */
async function getLastCommitMessage(git: SimpleGit): Promise<string> {
  try {
    const log = await git.log({ maxCount: 1 });
    return log.latest?.message || "No previous commit message found.";
  } catch (error) {
    console.error("Error fetching the last commit message:", error);
    return "No previous commit message found.";
  }
}

/**
 * Generates a commit message using AI based on file diffs and the last commit message.
 */
async function generateCommitMessage(
  fileDiffs: Map<string, string>,
  lastCommitMessage: string
): Promise<string> {
  console.log(fileDiffs);
  const changesSummary = Array.from(fileDiffs.entries())
    .map(([file, diff]) => `File: ${file}\nChanges:\n${diff}`)
    .join("\n\n");

  const prompt = `
Last Commit Message (just for refrence of what we did last time the new message should describe the changes done in this commit):
"${lastCommitMessage}"

Current Changes (git diff of the changes):
${changesSummary}

summarize the work done in the last 30 minutes and give me best suitable commit message for it describing the work done in the best and shortest way possible, no jargon, no other shit, just commit message in below format".
example commit message :
 feat: add a new feature

 description:
 in short 1 liner bullet points here not much details

 why's this feature/fix needed?

 if(feat){
  predict the status of the work being done here and rate its progress in the below format (out of 10 like)
  eg:-[#####-----] 5/10
 }

 if(fix){
 before vs after effects.
 }
  `;

  try {
    const aiResponse = await model.generateContent(prompt); // Replace with actual Gemini AI call
    const message = await aiResponse.response.text();
    return message.trim();
  } catch (error) {
    console.error("Error generating commit message with AI:", error);
    return "Manual commit (AI unavailable).";
  }
}

/**
 * Commits tracked changes in the workspace using Git.
 */
async function commitChanges(workspacePath: string, git: SimpleGit) {
  const fileDiffs = await getChangedFilesWithDiffs(git);

  if (fileDiffs.size === 0) {
    vscode.window.showInformationMessage(
      `No changes to commit in ${workspacePath}.`
    );
    return;
  }

  const lastCommitMessage = await getLastCommitMessage(git);
  const commitMessage = await generateCommitMessage(
    fileDiffs,
    lastCommitMessage
  );

  try {
    await git.add(Array.from(fileDiffs.keys())); // Stage only the changed files
    const now = new Date();

    await git.commit(
      `${moment(now).format("ll LT")} - ${
        commitMessage.split("\n")[0]
      }\n\n${commitMessage}`
    );

    vscode.window.showInformationMessage(
      `Changes committed in ${workspacePath}`
    );
  } catch (error) {
    console.error("Error committing changes:", error);
  }
}

/**
 * Tracks changes and commits them automatically at regular intervals.
 */
async function autoCommit(
  workspacePath: string,
  git: SimpleGit,
  interval: number = COMMIT_INTERVAL
) {
  const intervalId = setInterval(async () => {
    await commitChanges(workspacePath, git);
  }, interval);

  return intervalId;
}

/**
 * Activates the VS Code extension by setting up Git initialization and auto-committing.
 */
export async function activate(context: vscode.ExtensionContext) {
  const commitInterval = getCommitIntervalFromSettings();

  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      "Please open a workspace to enable Git tracking."
    );
    return;
  }

  const gitInstances = new Map<string, SimpleGit>();

  //Create command to commit

  for (const folder of workspaceFolders) {
    const workspacePath = folder.uri.fsPath;
    const git = await initializeGit(workspacePath);
    gitInstances.set(workspacePath, git);

    // Set up auto-commit interval
    const intervalId = await autoCommit(workspacePath, git, commitInterval);

    context.subscriptions.push({
      dispose: () => {
        clearInterval(intervalId);
      },
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.aiCommit", async () => {
      for (const [workspacePath, git] of gitInstances) {
        await commitChanges(workspacePath, git);
      }
    })
  );

  vscode.window.showInformationMessage("Git Extension Activated!");
}

/**
 * Deactivates the VS Code extension.
 */
export function deactivate() {}
