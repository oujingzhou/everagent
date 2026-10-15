import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { readAllConversationEntries } from "./conversation-entries.ts";
import type { EverAgentRuntime } from "./runtime.ts";

const WEB_CONTEXT = BACKGROUND_CONTEXT;
const MAX_REQUEST_BYTES = 1024 * 1024;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EverAgent Runtime</title>
<style>
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #0f1115;
  color: #e8eaed;
  --panel: #15191f;
  --panel-strong: #1b2028;
  --line: #303741;
  --muted: #929aa6;
  --coral: #e48a7a;
  --gold: #eab65d;
  --blue: #4f8eb3;
  --green: #65b887;
  --red: #dd746f;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #0f1115; }
button, input, select { font: inherit; }
button { cursor: pointer; }
.app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
header { height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 20px; border-bottom: 1px solid var(--line); background: #12151a; }
.brand { display: flex; align-items: baseline; gap: 12px; }
h1 { margin: 0; font-size: 18px; font-weight: 700; }
h1 .ever { color: var(--coral); }
h1 .agent { color: var(--gold); }
.conversation { color: var(--muted); font-size: 12px; }
.runtime-status { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 12px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
.layout { min-height: 0; }
.tasks-panel { height: calc(100vh - 58px); min-width: 0; display: grid; grid-template-rows: auto auto 1fr; }
.panel-heading { padding: 18px 18px 14px; border-bottom: 1px solid var(--line); }
.panel-title { margin: 0; font-size: 14px; }
.panel-subtitle { margin-top: 5px; color: var(--muted); font-size: 12px; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
.metric { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--line); }
.metric:last-child { border-right: 0; }
.metric-value { font-size: 18px; font-weight: 650; }
.metric-label { margin-top: 3px; color: var(--muted); font-size: 11px; }
.task-browser { min-height: 0; }
.task-list-column { height: 100%; min-width: 0; display: grid; grid-template-rows: auto 1fr auto; }
.filters { display: grid; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); }
.filter-modes { display: flex; gap: 6px; }
.filter { border: 1px solid var(--line); background: transparent; color: var(--muted); padding: 5px 9px; border-radius: 5px; font-size: 11px; }
.filter.active { color: #fff; border-color: var(--blue); background: #193044; }
.filter-fields { display: grid; grid-template-columns: minmax(120px, 1fr) repeat(3, minmax(100px, .65fr)); gap: 6px; }
.filter-input, .filter-select { width: 100%; min-width: 0; height: 30px; border: 1px solid var(--line); border-radius: 5px; background: #11151a; color: #d8dde4; padding: 0 8px; font-size: 11px; outline: none; }
.filter-input:focus, .filter-select:focus { border-color: var(--blue); }
.custom-time { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.custom-time[hidden] { display: none; }
.filter-count { color: var(--muted); font-size: 10px; }
.pagination { min-height: 42px; display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--line); background: #11151a; }
.page-button { width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 5px; background: transparent; color: #d8dde4; font-size: 18px; line-height: 1; }
.page-button:disabled { opacity: .35; cursor: default; }
.page-info { color: var(--muted); font-size: 10px; text-align: center; }
.page-size { width: 68px; height: 28px; border: 1px solid var(--line); border-radius: 5px; background: #11151a; color: #d8dde4; padding: 0 6px; font-size: 10px; }
#tasks { min-height: 0; overflow: auto; }
.task-row { width: 100%; display: block; text-align: left; border: 0; border-bottom: 1px solid #252b33; background: transparent; color: inherit; padding: 12px; }
.task-row:hover, .task-row.selected { background: #1a2027; }
.run-group { border-bottom: 1px solid var(--line); }
.run-heading { width: 100%; display: grid; grid-template-columns: auto 1fr; gap: 9px; align-items: start; padding: 12px; border: 0; text-align: left; background: #12161b; color: inherit; }
.run-heading:hover { background: #181d23; }
.run-toggle { width: 12px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.run-copy { min-width: 0; }
.run-title { font-size: 12px; font-weight: 650; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.run-meta { margin-top: 6px; color: var(--muted); font-size: 10px; }
.flow-label { padding: 10px 14px 5px 24px; color: var(--muted); font-size: 10px; text-transform: uppercase; background: #101419; }
.run-flow { position: relative; padding: 4px 10px 12px 22px; background: #101419; }
.run-flow::before { content: ""; position: absolute; left: 33px; top: 16px; bottom: 28px; width: 1px; background: #3b4550; }
.flow-step { position: relative; width: 100%; display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 9px; min-height: 52px; border: 0; background: transparent; color: inherit; text-align: left; padding: 7px 8px 7px 0; }
.flow-step:hover, .flow-step.selected { background: #1a2027; }
.flow-step.child { width: calc(100% - 20px); margin-left: 20px; }
.flow-step.child::before { content: ""; position: absolute; left: -9px; top: 26px; width: 20px; height: 1px; background: #3b4550; }
.flow-node { position: relative; z-index: 1; width: 22px; height: 22px; display: grid; place-items: center; border: 1px solid #466071; border-radius: 50%; background: #14202a; color: #9cc9e0; font-size: 9px; font-weight: 700; }
.flow-step.tool .flow-node { border-color: #6b5934; background: #261f12; color: #e7c47e; }
.flow-step.compaction .flow-node { border-color: #6e4842; background: #251816; color: #ef9a94; }
.flow-step.request .flow-node { border-color: #6e4842; background: #251816; color: #ef9a94; }
.flow-step.result .flow-node { border-color: #346447; background: #14231a; color: #8ed2a8; }
.flow-content { min-width: 0; display: block; }
.flow-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.flow-meta { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; }
.turn-gap { width: calc(100% - 24px); margin: 5px 0 5px 24px; border: 1px dashed #3b4550; border-radius: 5px; background: #12171d; color: #aab2bd; padding: 8px; font-size: 10px; text-align: center; }
.turn-gap:hover { border-color: var(--blue); color: #dce7ee; }
.task-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-kind { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.task-meta { margin-top: 7px; display: flex; gap: 8px; color: var(--muted); font-size: 10px; }
.badge { flex: none; border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.badge.live, .badge.active { color: #9cc9e0; border-color: #315a71; }
.badge.completed { color: #8ed2a8; border-color: #346447; }
.badge.failed, .badge.faulted, .badge.orphaned { color: #ef9a94; border-color: #713f3c; }
.badge.aborted { color: #e7c47e; border-color: #6b5934; }
.task-detail { min-width: 0; max-height: min(68vh, 760px); overflow: auto; margin: 5px 8px 12px 32px; padding: 15px; border: 1px solid #38424d; border-left: 3px solid var(--blue); background: #14191f; }
.task-detail[hidden] { display: none; }
.detail-empty, .list-empty { color: var(--muted); font-size: 12px; padding: 18px; }
.detail-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.detail-header h3 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.detail-summary { margin-top: 8px; color: #b7bec8; font-size: 12px; line-height: 1.5; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
.detail-label { color: var(--muted); font-size: 10px; text-transform: uppercase; }
.detail-value { margin-top: 4px; font-size: 12px; overflow-wrap: anywhere; }
.detail-section { margin-top: 16px; }
.detail-section h4 { margin: 0 0 7px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
pre { margin: 0; overflow: auto; max-height: 240px; padding: 10px; border: 1px solid var(--line); background: #101318; color: #cbd1d9; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { color: var(--muted); margin: auto; font-size: 12px; text-align: center; }
@media (max-width: 900px) {
  .task-detail { max-height: 60vh; }
}
@media (max-width: 580px) {
  header { padding: 0 12px; }
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .metric:nth-child(2) { border-right: 0; }
  .metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .task-detail { margin-left: 16px; }
  .filter-fields { grid-template-columns: 1fr 1fr; }
  .filter-input { grid-column: 1 / -1; }
}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">
      <h1><span class="ever">ever</span><span class="agent">agent</span></h1>
      <span class="conversation">durable task console</span>
    </div>
    <div class="runtime-status"><span class="status-dot"></span><span id="status">attaching...</span></div>
  </header>
  <main class="layout">
    <section class="tasks-panel">
      <div class="panel-heading">
        <h2 class="panel-title">Agent runs</h2>
        <div class="panel-subtitle">Requests grouped with their model turns, tool calls, checkpoints, and outcomes</div>
      </div>
      <div class="metrics">
        <div class="metric"><div id="metric-active" class="metric-value">0</div><div class="metric-label">Active runs</div></div>
        <div class="metric"><div id="metric-queued" class="metric-value">0</div><div class="metric-label">Queued</div></div>
        <div class="metric"><div id="metric-completed" class="metric-value">0</div><div class="metric-label">Completed runs</div></div>
        <div class="metric"><div id="metric-failed" class="metric-value">0</div><div class="metric-label">Failed runs</div></div>
      </div>
      <div class="task-browser">
        <div class="task-list-column">
          <div class="filters">
            <div class="filter-modes">
              <button class="filter active" data-filter="all">All</button>
              <button class="filter" data-filter="live">Active</button>
              <button class="filter" data-filter="completed">Completed</button>
              <button class="filter" data-filter="failed">Failed</button>
            </div>
            <div class="filter-fields">
              <input id="task-search" class="filter-input" placeholder="Search request, task, ID">
              <select id="kind-filter" class="filter-select"><option value="all">All types</option></select>
              <select id="conversation-filter" class="filter-select"><option value="all">All conversations</option></select>
              <select id="time-filter" class="filter-select">
                <option value="all">All time</option>
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="custom">Custom range</option>
              </select>
            </div>
            <div id="custom-time" class="custom-time" hidden>
              <input id="time-from" class="filter-input" type="datetime-local" aria-label="Start time">
              <input id="time-to" class="filter-input" type="datetime-local" aria-label="End time">
            </div>
            <div id="filter-count" class="filter-count"></div>
          </div>
          <div id="tasks"><div class="list-empty">No durable tasks yet.</div></div>
          <div class="pagination">
            <button id="page-previous" class="page-button" title="Previous page" aria-label="Previous page">‹</button>
            <span id="page-info" class="page-info">Page 1 of 1</span>
            <select id="page-size" class="page-size" aria-label="Runs per page">
              <option value="10">10 / page</option>
              <option value="20">20 / page</option>
              <option value="50">50 / page</option>
            </select>
            <button id="page-next" class="page-button" title="Next page" aria-label="Next page">›</button>
          </div>
          <div id="task-detail" class="task-detail" hidden></div>
        </div>
      </div>
    </section>
  </main>
</div>
<script>
const tasksNode = document.querySelector("#tasks");
const detailNode = document.querySelector("#task-detail");
const statusNode = document.querySelector("#status");
const searchNode = document.querySelector("#task-search");
const kindFilterNode = document.querySelector("#kind-filter");
const conversationFilterNode = document.querySelector("#conversation-filter");
const timeFilterNode = document.querySelector("#time-filter");
const customTimeNode = document.querySelector("#custom-time");
const timeFromNode = document.querySelector("#time-from");
const timeToNode = document.querySelector("#time-to");
const filterCountNode = document.querySelector("#filter-count");
const previousPageNode = document.querySelector("#page-previous");
const nextPageNode = document.querySelector("#page-next");
const pageInfoNode = document.querySelector("#page-info");
const pageSizeNode = document.querySelector("#page-size");
let state;
let selectedTaskId;
let taskFilter = "all";
let taskSearch = "";
let taskKind = "all";
let taskConversation = "all";
let taskTime = "all";
let timeFrom = "";
let timeTo = "";
let initialConversationApplied = false;
let runPage = 1;
let runsPerPage = 10;
let selectedRunView;
let technicalDetailsOpen = false;
let renderedDetailKey;
let focusDetailAfterRender = false;
const taskDetails = new Map();
const loadingDetails = new Set();
const expandedRuns = new Set();
const expandedTurns = new Set();
const expandedRunHistory = new Set();

function isLive(task) {
  return task.status === "pending" || task.status === "running" || task.status === "waiting" || task.status === "completing";
}
function outcome(task) {
  return task.outcomeStatus || (isLive(task) ? "live" : task.status);
}
function statusLabel(task) {
  const value = outcome(task);
  return {
    live: "Active",
    completed: "Completed",
    failed: "Failed",
    faulted: "Faulted",
    orphaned: "Orphaned",
    aborted: "Aborted"
  }[value] || value;
}
function taskLabel(task, detail) {
  if (task.kind === "pi.tool") return detail?.tool ? "Tool · " + detail.tool.name : "Tool execution";
  if (task.kind === "pi.generation") return "Model turn";
  if (task.kind === "pi.compaction") return "Context compaction";
  return task.kind.replace(/^pi\./, "").replaceAll("-", " ");
}
function taskSummary(task, detail) {
  if (detail?.tool) {
    const args = detail.tool.arguments || {};
    const target = args.command || args.path || args.filePath || args.url;
    return target ? detail.tool.name + " · " + String(target) : "Executed the " + detail.tool.name + " tool.";
  }
  if (task.kind === "pi.generation") {
    if (detail?.generation?.text) return detail.generation.text.slice(0, 160);
    if (detail?.generation?.toolCalls?.length) {
      return "Requested " + detail.generation.toolCalls.map((call) => call.name).join(", ");
    }
    return isLive(task)
      ? "Model turn is running; no output has been committed yet."
      : "Generated the next model response and committed it to the transcript.";
  }
  if (task.kind === "pi.compaction") return "Compacted conversation context for continued execution.";
  return "Durable runtime task.";
}
function dateTime(value) {
  return value ? new Date(value).toLocaleString() : "—";
}
function duration(task) {
  if (!task.startedAt) return "—";
  const end = task.endedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds % 60) + "s";
}
function json(value) {
  if (value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function readableToolResult(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.content)) return value;
  const text = value.content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("");
  if (text && value.details !== undefined) return {output: text, details: value.details};
  return text || value.details || value;
}
function renderMetrics(data) {
  const completed = data.runs.filter((run) => run.status === "completed").length;
  const failed = data.runs.filter((run) => run.status === "failed").length;
  document.querySelector("#metric-active").textContent = data.runs.filter((run) => run.status === "active").length;
  document.querySelector("#metric-queued").textContent = data.pendingSubmissionCount;
  document.querySelector("#metric-completed").textContent = completed;
  document.querySelector("#metric-failed").textContent = failed;
}
function appendJsonSection(parent, label, value) {
  if (value === undefined) return;
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h4");
  heading.textContent = label;
  const content = document.createElement("pre");
  content.dataset.section = label;
  content.textContent = typeof value === "string" ? value : json(value);
  section.append(heading, content);
  parent.append(section);
}
function captureDetailScroll(key) {
  if (renderedDetailKey !== key) return undefined;
  return {
    top: detailNode.scrollTop,
    left: detailNode.scrollLeft,
    sections: new Map(
      [...detailNode.querySelectorAll("pre[data-section]")].map((node) => [
        node.dataset.section,
        {top: node.scrollTop, left: node.scrollLeft}
      ])
    )
  };
}
function restoreDetailScroll(key, scroll) {
  renderedDetailKey = key;
  if (!scroll) {
    detailNode.scrollTop = 0;
    detailNode.scrollLeft = 0;
    return;
  }
  detailNode.scrollTop = scroll.top;
  detailNode.scrollLeft = scroll.left;
  for (const node of detailNode.querySelectorAll("pre[data-section]")) {
    const position = scroll.sections.get(node.dataset.section);
    if (!position) continue;
    node.scrollTop = position.top;
    node.scrollLeft = position.left;
  }
}
function renderTaskDetail(task) {
  const key = task ? "task:" + task.id : "empty";
  const scroll = captureDetailScroll(key);
  detailNode.replaceChildren();
  if (!task) {
    detailNode.hidden = true;
    restoreDetailScroll(key, scroll);
    return;
  }
  detailNode.hidden = false;
  const header = document.createElement("div");
  header.className = "detail-header";
  const title = document.createElement("h3");
  const detail = taskDetails.get(task.id);
  const run = state?.runs.find((candidate) => candidate.taskIds.includes(task.id));
  title.textContent = taskLabel(task, detail);
  const badge = document.createElement("span");
  badge.className = "badge " + outcome(task);
  badge.textContent = statusLabel(task);
  header.append(title, badge);
  detailNode.append(header);
  const summary = document.createElement("div");
  summary.className = "detail-summary";
  summary.textContent = taskSummary(task, detail);
  detailNode.append(summary);

  const grid = document.createElement("div");
  grid.className = "detail-grid";
  const fields = [
    ["Run", run ? run.id : "—"],
    ["Task ID", "#" + task.id],
    ["Conversation", "#" + task.conversationId],
    ["Execution", task.schedulerStatus || statusLabel(task)],
    ["Current phase", task.phase || (isLive(task) ? "Starting" : "Finished")],
    ["Started", dateTime(task.startedAt)],
    ["Duration", duration(task)],
    ["Finished", dateTime(task.endedAt)],
    ["Parent task", task.ownerId ? "#" + task.ownerId : "None"]
  ];
  for (const [label, value] of fields) {
    const cell = document.createElement("div");
    const key = document.createElement("div");
    key.className = "detail-label";
    key.textContent = label;
    const content = document.createElement("div");
    content.className = "detail-value";
    content.textContent = value;
    cell.append(key, content);
    grid.append(cell);
  }
  detailNode.append(grid);

  if (detail?.tool) {
    appendJsonSection(detailNode, "Tool arguments", detail.tool.arguments);
    if (detail.tool.result !== undefined) appendJsonSection(detailNode, "Tool result", readableToolResult(detail.tool.result));
  }
  if (detail?.generation) {
    if (detail.generation.text) appendJsonSection(detailNode, "Model response", detail.generation.text);
    if (detail.generation.thinking) appendJsonSection(detailNode, "Thinking", detail.generation.thinking);
    if (detail.generation.toolCalls.length > 0) {
      appendJsonSection(detailNode, "Requested tools", detail.generation.toolCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments
      })));
    }
  } else if (task.kind === "pi.generation" && isLive(task)) {
    appendJsonSection(detailNode, "Model response", "No output has been committed yet.");
  }
  const technical = document.createElement("details");
  technical.className = "detail-section";
  technical.open = technicalDetailsOpen;
  technical.addEventListener("toggle", () => {
    technicalDetailsOpen = technical.open;
  });
  const technicalTitle = document.createElement("summary");
  technicalTitle.textContent = "Technical details";
  technicalTitle.className = "detail-label";
  technical.append(technicalTitle);
  appendJsonSection(technical, "Durable input", task.input);
  appendJsonSection(technical, "Checkpoint", task.checkpoint);
  appendJsonSection(technical, "Durable outcome", task.outcome);
  if (detail?.tool) appendJsonSection(technical, "Runtime references", {
    callId: detail.tool.callId,
    assistantEntryId: detail.tool.assistantEntryId,
    resultEntryId: detail.tool.resultEntryId
  });
  if (detail?.generation) appendJsonSection(technical, "Generation metadata", {
    entryId: detail.generation.entryId,
    stopReason: detail.generation.stopReason,
    toolCallIds: detail.generation.toolCalls.map((call) => call.id)
  });
  detailNode.append(technical);
  restoreDetailScroll(key, scroll);
}
function renderRunDetail(run, mode) {
  const key = "run:" + run.id + ":" + mode;
  const scroll = captureDetailScroll(key);
  detailNode.replaceChildren();
  detailNode.hidden = false;
  const header = document.createElement("div");
  header.className = "detail-header";
  const title = document.createElement("h3");
  title.textContent = mode === "request" ? "Run request" : "Final response";
  const badge = document.createElement("span");
  badge.className = "badge " + run.status;
  badge.textContent = run.status;
  header.append(title, badge);
  detailNode.append(header);
  const summary = document.createElement("div");
  summary.className = "detail-summary";
  summary.textContent = "Conversation #" + run.conversationId + " · " +
    run.generationCount + " model turn" + (run.generationCount === 1 ? "" : "s") + " · " +
    run.toolCount + " tool" + (run.toolCount === 1 ? "" : "s") + " · " + duration(run);
  detailNode.append(summary);
  appendJsonSection(
    detailNode,
    mode === "request" ? "Request" : "Response",
    mode === "request" ? run.prompt : (run.answer || "No final text response was committed."),
  );
  restoreDetailScroll(key, scroll);
}
async function loadTaskDetail(taskId) {
  if (taskDetails.has(taskId) || loadingDetails.has(taskId)) return;
  loadingDetails.add(taskId);
  try {
    const response = await fetch("/api/tasks/" + taskId);
    if (!response.ok) return;
    taskDetails.set(taskId, await response.json());
    if (state) renderTasks(state);
  } finally {
    loadingDetails.delete(taskId);
  }
}
function updateSelect(select, values, allLabel, selected) {
  const signature = values.join("|");
  if (select.dataset.signature !== signature) {
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = allLabel;
    select.append(all);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.dataset.signature = signature;
  }
  select.value = values.includes(selected) ? selected : "all";
}
function matchesLifecycle(task) {
  if (taskFilter === "live") return task.status === "active";
  if (taskFilter === "completed") return task.status === "completed";
  if (taskFilter === "failed") return task.status === "failed";
  return true;
}
function matchesTime(run) {
  if (taskTime === "all") return true;
  const timestamp = run.startedAt || run.endedAt;
  if (!timestamp) return false;
  const now = Date.now();
  if (taskTime === "1h") return timestamp >= now - 60 * 60 * 1000;
  if (taskTime === "24h") return timestamp >= now - 24 * 60 * 60 * 1000;
  if (taskTime === "7d") return timestamp >= now - 7 * 24 * 60 * 60 * 1000;
  if (taskTime === "30d") return timestamp >= now - 30 * 24 * 60 * 60 * 1000;
  const from = timeFrom ? new Date(timeFrom).getTime() : undefined;
  const to = timeTo ? new Date(timeTo).getTime() : undefined;
  return (from === undefined || timestamp >= from) && (to === undefined || timestamp <= to);
}
function renderTasks(data) {
  const listScrollTop = tasksNode.scrollTop;
  const listScrollLeft = tasksNode.scrollLeft;
  const kinds = [...new Set(data.tasks.map((task) => task.kind))].sort();
  const conversations = [...new Set(data.tasks.map((task) => String(task.conversationId)))].sort((a, b) => Number(b) - Number(a));
  if (taskConversation !== "all" && !conversations.includes(taskConversation)) conversations.unshift(taskConversation);
  updateSelect(kindFilterNode, kinds, "All types", taskKind);
  updateSelect(conversationFilterNode, conversations, "All conversations", taskConversation);
  const query = taskSearch.trim().toLowerCase();
  const filtered = data.runs.filter((run) => {
    const runTasks = run.taskIds.map((id) => data.tasks.find((task) => task.id === id)).filter(Boolean);
    if (!matchesLifecycle(run)) return false;
    if (!matchesTime(run)) return false;
    if (taskKind !== "all" && !runTasks.some((task) => task.kind === taskKind)) return false;
    if (taskConversation !== "all" && String(run.conversationId) !== taskConversation) return false;
    if (!query) return true;
    return [
      run.id,
      String(run.conversationId),
      run.prompt,
      run.answer,
      ...runTasks.flatMap((task) => {
        const detail = taskDetails.get(task.id);
        return [String(task.id), task.kind, task.phase, taskLabel(task, detail), taskSummary(task, detail)];
      })
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  });
  const visibleTaskCount = filtered.reduce((total, run) => total + run.taskIds.length, 0);
  filterCountNode.textContent = filtered.length + " of " + data.runs.length + " runs · " + visibleTaskCount + " tasks";
  const totalPages = Math.max(1, Math.ceil(filtered.length / runsPerPage));
  runPage = Math.min(Math.max(1, runPage), totalPages);
  const pageRuns = filtered.slice((runPage - 1) * runsPerPage, runPage * runsPerPage);
  pageInfoNode.textContent = "Page " + runPage + " of " + totalPages;
  previousPageNode.disabled = runPage <= 1;
  nextPageNode.disabled = runPage >= totalPages;
  tasksNode.replaceChildren();
  if (!pageRuns.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = taskFilter === "all" ? "No durable runs yet." : "No runs in this view.";
    tasksNode.append(empty);
  }
  const visibleTaskIds = new Set(pageRuns.flatMap((run) => run.taskIds));
  const visibleRunIds = new Set(pageRuns.map((run) => run.id));
  if (selectedTaskId !== undefined && !visibleTaskIds.has(selectedTaskId)) selectedTaskId = undefined;
  if (selectedRunView && !visibleRunIds.has(selectedRunView.id)) selectedRunView = undefined;
  for (const run of pageRuns) {
    const group = document.createElement("section");
    group.className = "run-group";
    const heading = document.createElement("button");
    heading.className = "run-heading";
    heading.type = "button";
    heading.dataset.runId = run.id;
    const expanded = expandedRuns.has(run.id);
    heading.setAttribute("aria-expanded", String(expanded));
    const toggle = document.createElement("span");
    toggle.className = "run-toggle";
    toggle.textContent = expanded ? "▾" : "▸";
    const copy = document.createElement("span");
    copy.className = "run-copy";
    const title = document.createElement("div");
    title.className = "run-title";
    title.textContent = run.prompt;
    const meta = document.createElement("div");
    meta.className = "run-meta";
    meta.textContent = "conversation #" + run.conversationId + " · " +
      run.generationCount + " model turn" + (run.generationCount === 1 ? "" : "s") + " · " +
      run.toolCount + " tool" + (run.toolCount === 1 ? "" : "s") + " · " + duration(run);
    copy.append(title, meta);
    heading.append(toggle, copy);
    heading.addEventListener("click", () => {
      if (expanded) {
        expandedRuns.delete(run.id);
        expandedRunHistory.delete(run.id);
        for (const taskId of run.taskIds) expandedTurns.delete(taskId);
        if (run.taskIds.includes(selectedTaskId)) selectedTaskId = undefined;
        if (selectedRunView?.id === run.id) selectedRunView = undefined;
      } else {
        expandedRuns.add(run.id);
      }
      renderTasks(state);
      const renderedHeading = [...tasksNode.querySelectorAll(".run-heading")]
        .find((candidate) => candidate.dataset.runId === run.id);
      renderedHeading?.scrollIntoView({block: "nearest"});
    });
    group.append(heading);
    if (!expanded) {
      tasksNode.append(group);
      continue;
    }
    const flowLabel = document.createElement("div");
    flowLabel.className = "flow-label";
    flowLabel.textContent = "Execution workflow";
    const flow = document.createElement("div");
    flow.className = "run-flow";
    const requestStep = document.createElement("button");
    requestStep.className = "flow-step request" +
      (selectedRunView?.id === run.id && selectedRunView.mode === "request" ? " selected" : "");
    requestStep.dataset.runView = run.id + ":request";
    const requestNode = document.createElement("span");
    requestNode.className = "flow-node";
    requestNode.textContent = "Q";
    const requestContent = document.createElement("span");
    requestContent.className = "flow-content";
    const requestTitle = document.createElement("span");
    requestTitle.className = "flow-title";
    requestTitle.textContent = "Request";
    const requestMeta = document.createElement("span");
    requestMeta.className = "flow-meta";
    requestMeta.textContent = run.prompt;
    requestContent.append(requestTitle, requestMeta);
    requestStep.append(requestNode, requestContent);
    requestStep.addEventListener("click", () => {
      const selected = selectedRunView?.id === run.id && selectedRunView.mode === "request";
      selectedTaskId = undefined;
      selectedRunView = selected ? undefined : {id: run.id, mode: "request"};
      technicalDetailsOpen = false;
      focusDetailAfterRender = !selected;
      renderTasks(state);
    });
    flow.append(requestStep);
    const runTasks = run.taskIds
      .map((taskId) => data.tasks.find((candidate) => candidate.id === taskId))
      .filter(Boolean);
    const taskIds = new Set(runTasks.map((task) => task.id));
    const roots = runTasks.filter((task) => task.ownerId === undefined || !taskIds.has(task.ownerId));
    const childrenByOwner = new Map();
    for (const task of runTasks) {
      if (task.ownerId === undefined) continue;
      const children = childrenByOwner.get(task.ownerId) || [];
      children.push(task);
      childrenByOwner.set(task.ownerId, children);
    }
    let modelTurn = 0;
    const stages = roots.map((task) => ({
      task,
      modelTurn: task.kind === "pi.generation" ? ++modelTurn : undefined,
      children: childrenByOwner.get(task.id) || []
    }));
    const historyCollapsed = stages.length > 8 && !expandedRunHistory.has(run.id);
    const visibleStages = historyCollapsed
      ? [...stages.slice(0, 3), {gap: stages.length - 6}, ...stages.slice(-3)]
      : stages;
    const appendTask = (task, options = {}) => {
      const detail = taskDetails.get(task.id);
      const children = options.children || [];
      const turnExpanded = expandedTurns.has(task.id);
      const row = document.createElement("button");
      row.className = "flow-step " +
        (task.kind === "pi.tool" ? "tool " : task.kind === "pi.compaction" ? "compaction " : "generation ") +
        (options.child ? "child " : "") +
        (task.id === selectedTaskId ? "selected" : "");
      row.dataset.taskId = String(task.id);
      if (children.length > 0) row.setAttribute("aria-expanded", String(turnExpanded));
      const node = document.createElement("span");
      node.className = "flow-node";
      node.textContent = task.kind === "pi.tool" ? "T" : task.kind === "pi.compaction" ? "C" : "M";
      const content = document.createElement("span");
      content.className = "flow-content";
      const title = document.createElement("span");
      title.className = "flow-title";
      title.textContent = options.modelTurn
        ? (turnExpanded ? "▾ " : children.length ? "▸ " : "") + "Model turn " + options.modelTurn
        : taskLabel(task, detail);
      const taskMeta = document.createElement("span");
      taskMeta.className = "flow-meta";
      const childSummary = children.length
        ? children.length + " tool" + (children.length === 1 ? "" : "s") + " · "
        : "";
      taskMeta.textContent = childSummary + taskSummary(task, detail) + " · " + duration(task);
      content.append(title, taskMeta);
      const badge = document.createElement("span");
      badge.className = "badge " + outcome(task);
      badge.textContent = statusLabel(task);
      row.append(node, content, badge);
      row.addEventListener("click", () => {
        const selected = selectedTaskId === task.id;
        if (!selected) technicalDetailsOpen = false;
        selectedTaskId = selected ? undefined : task.id;
        selectedRunView = undefined;
        if (children.length > 0) {
          if (turnExpanded) {
            expandedTurns.delete(task.id);
            if (children.some((child) => child.id === selectedTaskId)) selectedTaskId = task.id;
          } else {
            expandedTurns.add(task.id);
            for (const child of children) void loadTaskDetail(child.id);
          }
        }
        focusDetailAfterRender = !selected;
        renderTasks(state);
        if (!selected) void loadTaskDetail(task.id);
      });
      flow.append(row);
      if (children.length > 0 && expandedTurns.has(task.id)) {
        for (const child of children) appendTask(child, {child: true});
      }
    };
    for (const stage of visibleStages) {
      if ("gap" in stage) {
        const gap = document.createElement("button");
        gap.className = "turn-gap";
        gap.textContent = "Show " + stage.gap + " intermediate turn" + (stage.gap === 1 ? "" : "s");
        gap.addEventListener("click", () => {
          expandedRunHistory.add(run.id);
          renderTasks(state);
        });
        flow.append(gap);
        continue;
      }
      appendTask(stage.task, {modelTurn: stage.modelTurn, children: stage.children});
    }
    if (stages.length > 8 && expandedRunHistory.has(run.id)) {
      const collapseHistory = document.createElement("button");
      collapseHistory.className = "turn-gap";
      collapseHistory.textContent = "Show fewer turns";
      collapseHistory.addEventListener("click", () => {
        expandedRunHistory.delete(run.id);
        renderTasks(state);
      });
      flow.append(collapseHistory);
    }
    const resultStep = document.createElement("button");
    resultStep.className = "flow-step result" +
      (selectedRunView?.id === run.id && selectedRunView.mode === "response" ? " selected" : "");
    resultStep.dataset.runView = run.id + ":response";
    const resultNode = document.createElement("span");
    resultNode.className = "flow-node";
    resultNode.textContent = "R";
    const resultContent = document.createElement("span");
    resultContent.className = "flow-content";
    const resultTitle = document.createElement("span");
    resultTitle.className = "flow-title";
    resultTitle.textContent = "Final response";
    const resultMeta = document.createElement("span");
    resultMeta.className = "flow-meta";
    resultMeta.textContent = run.answer || (run.status === "active" ? "Waiting for a committed response" : "No text response");
    resultContent.append(resultTitle, resultMeta);
    resultStep.append(resultNode, resultContent);
    resultStep.addEventListener("click", () => {
      const selected = selectedRunView?.id === run.id && selectedRunView.mode === "response";
      selectedTaskId = undefined;
      selectedRunView = selected ? undefined : {id: run.id, mode: "response"};
      technicalDetailsOpen = false;
      focusDetailAfterRender = !selected;
      renderTasks(state);
    });
    flow.append(resultStep);
    group.append(flowLabel, flow);
    tasksNode.append(group);
  }
  const selected = data.tasks.find((task) => task.id === selectedTaskId);
  if (selected) {
    renderTaskDetail(selected);
    void loadTaskDetail(selected.id);
  } else if (selectedRunView) {
    const run = data.runs.find((candidate) => candidate.id === selectedRunView.id);
    if (run) renderRunDetail(run, selectedRunView.mode);
    else renderTaskDetail(undefined);
  } else {
    renderTaskDetail(undefined);
  }
  let detailAnchor;
  if (selectedTaskId !== undefined) {
    detailAnchor = [...tasksNode.querySelectorAll("[data-task-id]")]
      .find((candidate) => Number(candidate.dataset.taskId) === selectedTaskId);
  } else if (selectedRunView) {
    const key = selectedRunView.id + ":" + selectedRunView.mode;
    detailAnchor = [...tasksNode.querySelectorAll("[data-run-view]")]
      .find((candidate) => candidate.dataset.runView === key);
  }
  if (detailAnchor && !detailNode.hidden) {
    detailAnchor.after(detailNode);
  }
  tasksNode.scrollTop = listScrollTop;
  tasksNode.scrollLeft = listScrollLeft;
  if (detailAnchor && !detailNode.hidden && focusDetailAfterRender) {
    detailNode.scrollIntoView({block: "nearest"});
  }
  focusDetailAfterRender = false;
}
function render(data) {
  state = data;
  if (!initialConversationApplied && data.defaultConversationId !== undefined) {
    taskConversation = String(data.defaultConversationId);
    initialConversationApplied = true;
  }
  statusNode.textContent = data.scheduling + " · " + data.activeTaskCount + " active · " + data.pendingSubmissionCount + " queued";
  renderMetrics(data);
  renderTasks(data);
}
async function refresh() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not load durable runtime state");
  render(await response.json());
}
for (const filter of document.querySelectorAll(".filter")) {
  filter.addEventListener("click", () => {
    taskFilter = filter.dataset.filter;
    runPage = 1;
    for (const item of document.querySelectorAll(".filter")) item.classList.toggle("active", item === filter);
    if (state) renderTasks(state);
  });
}
searchNode.addEventListener("input", () => {
  taskSearch = searchNode.value;
  runPage = 1;
  if (state) renderTasks(state);
});
kindFilterNode.addEventListener("change", () => {
  taskKind = kindFilterNode.value;
  runPage = 1;
  if (state) renderTasks(state);
});
conversationFilterNode.addEventListener("change", () => {
  taskConversation = conversationFilterNode.value;
  runPage = 1;
  if (state) renderTasks(state);
});
timeFilterNode.addEventListener("change", () => {
  taskTime = timeFilterNode.value;
  customTimeNode.hidden = taskTime !== "custom";
  runPage = 1;
  if (state) renderTasks(state);
});
timeFromNode.addEventListener("change", () => {
  timeFrom = timeFromNode.value;
  runPage = 1;
  if (state) renderTasks(state);
});
timeToNode.addEventListener("change", () => {
  timeTo = timeToNode.value;
  runPage = 1;
  if (state) renderTasks(state);
});
previousPageNode.addEventListener("click", () => {
  if (runPage <= 1) return;
  runPage--;
  tasksNode.scrollTop = 0;
  if (state) renderTasks(state);
});
nextPageNode.addEventListener("click", () => {
  runPage++;
  tasksNode.scrollTop = 0;
  if (state) renderTasks(state);
});
pageSizeNode.addEventListener("change", () => {
  runsPerPage = Number(pageSizeNode.value);
  runPage = 1;
  tasksNode.scrollTop = 0;
  if (state) renderTasks(state);
});
refresh().catch((error) => { statusNode.textContent = error.message; });
setInterval(() => refresh().catch(() => {}), 1000);
</script>
</body>
</html>`;

type WebMessage = { role: "user" | "assistant"; text: string };

function textFromEntry(entry: EntryRecord): WebMessage | undefined {
	const model = entry.model?.[0];
	if (!model || (model.role !== "user" && model.role !== "assistant")) return undefined;
	const text =
		typeof model.content === "string"
			? model.content
			: model.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	return text ? { role: model.role, text } : undefined;
}

async function sessionMessages(conversation: Conversation): Promise<WebMessage[]> {
	const entries = await readAllConversationEntries(conversation);
	return entries.map(textFromEntry).filter((item): item is WebMessage => item !== undefined);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > MAX_REQUEST_BYTES) {
			const error = new Error("request body is too large");
			error.name = "PayloadTooLarge";
			throw error;
		}
		chunks.push(buffer);
	}
	const body = Buffer.concat(chunks).toString("utf8");
	if (!body) return {};
	try {
		return JSON.parse(body);
	} catch {
		const error = new Error("invalid JSON request body");
		error.name = "InvalidJson";
		throw error;
	}
}

export async function startWebServer(
	runtime: EverAgentRuntime,
	port: number,
	host = "127.0.0.1",
	options: { defaultConversationId?: number } = {},
): Promise<Server> {
	const conversation = runtime.conversation;
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${host}`);
			if (request.method === "GET" && url.pathname === "/api/health") {
				sendJson(response, 200, {
					service: "everagent",
					token: process.env.EVERAGENT_DAEMON_TOKEN,
				});
				return;
			}
			if (request.method === "GET" && url.pathname === "/") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(HTML) });
				response.end(HTML);
				return;
			}
			if (request.method === "GET" && (url.pathname === "/api/state" || url.pathname === "/api/session")) {
				sendJson(response, 200, {
					messages: await sessionMessages(conversation),
					...(await runtime.state()),
					...(options.defaultConversationId === undefined
						? {}
						: { defaultConversationId: options.defaultConversationId }),
				});
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
				const taskId = Number(url.pathname.slice("/api/tasks/".length));
				if (!Number.isInteger(taskId) || taskId < 1) {
					sendJson(response, 400, { error: "invalid task id" });
					return;
				}
				const detail = await runtime.taskDetail(taskId);
				if (!detail) {
					sendJson(response, 404, { error: "task not found" });
					return;
				}
				sendJson(response, 200, detail);
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/api/submissions/")) {
				const submissionId = Number(url.pathname.slice("/api/submissions/".length));
				if (!Number.isInteger(submissionId) || submissionId < 1) {
					sendJson(response, 400, { error: "invalid submission id" });
					return;
				}
				const submission = await runtime.harness.submission(submissionId as never, WEB_CONTEXT);
				if (!submission) {
					sendJson(response, 404, { error: "submission not found" });
					return;
				}
				sendJson(response, 200, await submission.status(WEB_CONTEXT));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/messages") {
				const body = await readJson(request);
				const object = typeof body === "object" && body !== null ? body : {};
				const prompt = "prompt" in object && typeof object.prompt === "string" ? object.prompt.trim() : "";
				if (!prompt) {
					sendJson(response, 400, { error: "prompt is required" });
					return;
				}
				const requestId = "requestId" in object && typeof object.requestId === "string" ? object.requestId : undefined;
				const whenBusy = "whenBusy" in object &&
					(object.whenBusy === "steer" || object.whenBusy === "followUp" || object.whenBusy === "reject")
					? object.whenBusy
					: "followUp";
				const submission = await runtime.submit(prompt, { requestId, whenBusy });
				sendJson(response, 202, {
					submissionId: submission.id,
					status: await submission.status(WEB_CONTEXT),
				});
				return;
			}
			sendJson(response, 404, { error: "not found" });
		} catch (error) {
			const status = error instanceof Error && error.name === "PayloadTooLarge"
				? 413
				: error instanceof Error && error.name === "InvalidJson"
					? 400
					: 500;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	return server;
}
