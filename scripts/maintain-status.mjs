#!/usr/bin/env node
/**
 * 维护自检：列出每个补丁的状态，并对未生效的补丁指出「哪一条 pattern 对不上」。
 *
 * 用法（Electron 当 Node 跑，和 dsh 自己一致）：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "E:\ai agent\dsh\DeepSeek Harness.exe" --expose-internals scripts/maintain-status.mjs
 *
 * 只读：不写任何宿主文件。
 *
 * 注意：宿主文件必须用 hostFs（original-fs）读。node:fs 在 Electron 里会把
 * resources/app 映进仍在的 app.asar，读到 size=0 / ERR_INVALID_ARG_TYPE。
 */
import path from "node:path";
import { hostFs } from "../lib/extract-asar.js";
import * as core from "../lib/core.js";

const state = await core.gatherState();
const out = [];
const push = (s = "") => out.push(s);

push("== dsh-purge 维护自检 ==");
push(`宿主 / surface : ${state.surface || "web"}`);
push(`DSH_HOME       : ${state.dsh_home}`);
push(`宿主根 / root : ${state.ai_base || core.missingAiBaseMessage()}`);
if (state.desktop_install) push(`桌面安装       : ${state.desktop_install}`);

try {
  const handoff = core.sealedAsarHandoff();
  if (handoff?.asar) {
    const stat = hostFs.statSync(handoff.asar);
    const rec = core.readUnpackedAsarStamp();
    const same = Boolean(rec) && rec.size === stat.size && Math.abs(rec.mtimeMs - stat.mtimeMs) < 1000;
    push(`app.asar       : ${handoff.asar}`);
    push(`  当前 size/mtime : ${stat.size} / ${Math.round(stat.mtimeMs)}`);
    push(`  已解包记录      : ${rec ? `${rec.size} / ${Math.round(rec.mtimeMs)}` : "(无)"}`);
    push(`  判定            : ${same ? "一致，宿主没换包" : "不一致 —— 宿主升级过，点「应用」会重新解包再清洗"}`);
  } else {
    push("app.asar       : (未密封 / 已经解开并挪走)");
  }
} catch (e) {
  push(`app.asar       : 读取失败 ${e && e.message ? e.message : e}`);
}

if (!state.ai_base) {
  push("");
  push("找不到宿主根，后面的补丁检查跳过。");
  console.log(out.join("\n"));
  process.exit(0);
}

const status = await core.patchStatus(state.ai_base);
const files = state.files || {};

function keysOf(patch) {
  const f = patch.file;
  if (Array.isArray(f)) return f;
  return f ? [f] : [];
}

/** state.files[key] 可能是单个路径，也可能是路径数组（一个补丁打多个文件）。 */
function targetsOf(key) {
  const raw = files[key];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [raw];
}

function readTarget(fp) {
  try {
    return { text: hostFs.readFileSync(fp, "utf8"), note: "" };
  } catch (e) {
    return { text: null, note: `读取失败: ${e && e.code ? e.code : e}` };
  }
}

/** 和 core 一样先把正文压成 LF：宿主文件多是 CRLF，直接 includes 会全判未命中。 */
function asLf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function patternHits(lfText, pattern) {
  if (!pattern) return false;
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(lfText);
  return lfText.includes(asLf(pattern));
}

function head(pattern) {
  const raw = pattern instanceof RegExp ? String(pattern) : String(pattern);
  return JSON.stringify(raw.split("\n")[0].slice(0, 88));
}

const rows = [];
for (const patch of core.ALL_PATCHES) {
  const st = status[patch.id];
  const keys = keysOf(patch);
  const reps = patch.replacements || [];
  const detail = [];
  let missing = 0;
  let total = 0;
  let hits = 0;
  for (const key of keys) {
    const paths = targetsOf(key);
    if (!paths.length) {
      detail.push(`  ${key}: 宿主没有这个文件键`);
      continue;
    }
    for (const fp of paths) {
      const { text, note } = readTarget(fp);
      if (!text) {
        detail.push(`  ${key}: ${note} ${fp}`);
        continue;
      }
      const lf = asLf(text);
      const misses = [];
      for (const [i, rep] of reps.entries()) {
        total += 1;
        if (patternHits(lf, rep.pattern)) hits += 1;
        else {
          missing += 1;
          misses.push(`    - 第 ${i} 条未命中: ${head(rep.pattern)}`);
        }
      }
      if (misses.length) detail.push(`  ${key} (${fp}): ${misses.length}/${reps.length} 条 pattern 未命中`, ...misses);
    }
  }
  rows.push({ id: patch.id, name: patch.name, status: st, optional: patch.optional === true, keys, missing, total, hits, detail });
}

const by = (s) => rows.filter((r) => r.status === s);
const okCount = rows.filter((r) => r.status === "applied" || r.status === "already").length;
const pending = by("pending");
const notFound = by("pattern_not_found");

push("");
push(`补丁 ${rows.length} 条：applied/already ${okCount}，pending ${pending.length}，pattern_not_found ${notFound.length}`);

if (pending.length) {
  push("");
  push("-- pending：宿主文件在，补丁还没打上 --");
  for (const r of pending) {
    push(`#${r.id} ${r.name} [${r.optional ? "optional" : "required"}]`);
    for (const line of r.detail) push(line);
  }
}

if (notFound.length) {
  push("");
  push("-- pattern_not_found：宿主源码改了，pattern 要跟着改 --");
  for (const r of notFound) {
    push(`#${r.id} ${r.name} [${r.optional ? "optional" : "required"}] 未命中 ${r.missing}/${r.total}`);
    for (const line of r.detail) push(line);
  }
}

const other = rows.filter((r) => !["applied", "already", "pending", "pattern_not_found"].includes(r.status));
if (other.length) {
  push("");
  push("-- 其它状态（按设计跳过 / 本机没有这个文件）--");
  for (const r of other) push(`#${r.id} ${r.name}: ${r.status}`);
}

// pending = 「原文里还有 pattern」= 还有活要干，可能只是没点过「应用」。
// 真正要看的是命中率：全部命中 = 直接应用即可；部分未命中 = 宿主改版，要按 §6 对齐。
const ready = rows.filter((r) => r.status === "pending" && r.total > 0 && r.missing === 0);
const partial = rows.filter((r) => r.status === "pending" && r.total > 0 && r.missing > 0);

// 「应用」的真正闸门：allPatchHostsWritten → hostCleanMarkersPresent。
// 它跟补丁状态是两套判定 —— #40 落空会变 skipped（不报错），但标记写不进去，
// 结果就是 pending 0 却依然「清洗没有写进全部宿主」。所以这里单独检查。
const gate = { identity: false, inject: false, hostWritten: false, note: "" };
try {
  gate.hostWritten = core.hostCleanMarkersPresent(state.ai_base);
  const fp = path.join(state.ai_base, "dsh-system-prompt", "lib", "index.js");
  const body = hostFs.readFileSync(fp, "utf8");
  gate.identity = body.includes("[dsh-purge] identity stripped");
  gate.inject = body.includes("[dsh-purge] complete prompt keeps waterfall inject")
    || body.includes("[dsh-purge] complete prompt keeps inject");
} catch (e) {
  gate.note = String(e && e.message ? e.message : e);
}

push("");
push("-- 应用闸门（hostPromptKeepsInject，硬性）--");
push(`  #25 identity stripped          : ${gate.identity ? "有" : "缺"}`);
push(`  #40 complete prompt keeps inject: ${gate.inject ? "有" : "缺"}`);
push(`  hostCleanMarkersPresent        : ${gate.hostWritten ? "true（能过）" : "false（「应用」会报「清洗没有写进全部宿主」）"}`);
if (!gate.identity || !gate.inject) {
  push("  → 对应补丁没打上。补丁状态可能是 skipped，见 MAINTENANCE §8.1。");
}
if (gate.note) push(`  读取失败: ${gate.note}`);

push("");
push("结论：");
push(`  required 且 pattern_not_found = ${notFound.filter((r) => !r.optional).length} 条（>0 时「应用」会判失败，必须先改 pattern）`);
push(`  optional 且 pattern_not_found = ${notFound.filter((r) => r.optional).length} 条（不挡应用，但那条语义已经失效，要人工判断还要不要）`);
push(`  pending = ${pending.length} 条（点「应用」或 dsh-purge --apply 就会打上）`);
if (ready.length) {
  push(`  其中 ${ready.length} 条 pattern 全部命中（${ready.map((r) => "#" + r.id).join(", ")}）：只是还没应用，点一次「应用」就成。`);
}
if (partial.length) {
  push(`  其中 ${partial.length} 条只有部分 pattern 命中（${partial.map((r) => "#" + r.id).join(", ")}）：宿主改版了，`);
  push("  按 §6 把未命中的那几条 pattern 对齐到当前宿主原文。");
}

console.log(out.join("\n"));
