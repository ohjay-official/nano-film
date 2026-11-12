// Drive branded Google Chrome over CDP, with Nano flags enabled the same way
// as ohjay-official/nano-probe. Do not use Playwright's default launch args
// (they disable component updates and block the model download).
//
// Usage: node on-device.mjs <chrome-binary> <profile-dir> <out-dir> [siteUrl] [extensionDir] [timeoutMinutes]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const [
  chromeBin = "google-chrome",
  profileDir = "/tmp/nano-profile",
  outDir = path.join(here, "out"),
  siteUrl = "https://did-i-order-this.vercel.app/app/",
  extensionDir = "",
  timeoutArg = "15",
] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg) * 60_000;

await mkdir(outDir, { recursive: true });
await mkdir(profileDir, { recursive: true });

const localStatePath = path.join(profileDir, "Local State");
if (!existsSync(localStatePath)) {
  await writeFile(
    localStatePath,
    JSON.stringify({
      browser: {
        enabled_labs_experiments: [
          "optimization-guide-on-device-model@2",
          "prompt-api-for-gemini-nano@1",
        ],
      },
      internal_only_uis_enabled: true,
    }),
  );
}

const fixtureHtml = await readFile(path.join(here, "gmail-fixture.html"));
const warmupHtml = await readFile(path.join(here, "warmup.html"));
const server = createServer((req, res) => {
  const url = req.url || "/";
  const body = url.startsWith("/warmup") ? warmupHtml : fixtureHtml;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise((resolve) => server.listen(8123, "127.0.0.1", resolve));

const wantExtension = Boolean(extensionDir && existsSync(path.join(extensionDir, "manifest.json")));

let chromeLog = "";
let chrome = null;

function redact(s) {
  return String(s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted]")
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[redacted]")
    .replace(/6L[0-9A-Za-z\-_]{20,}/g, "[redacted]");
}

function launchChrome({ withExtension }) {
  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "--window-position=0,0",
  ];
  if (withExtension) {
    chromeArgs.unshift("--remote-debugging-pipe", "--enable-unsafe-extension-debugging");
  }
  chromeArgs.push("about:blank");
  const child = spawn(chromeBin, chromeArgs, {
    stdio: withExtension ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => {
    chromeLog += d;
  });
  child.stderr?.on("data", (d) => {
    chromeLog += d;
  });
  child.on("exit", (code, signal) => {
    chromeLog += `\n[chrome exit code=${code} signal=${signal}]\n`;
  });
  return child;
}

async function stopChrome(child, browser) {
  if (browser) await browser.close().catch(() => {});
  if (!child) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version");
      if (!res.ok) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function loadUnpacked(child, absPath) {
  const cdpIn = child.stdio[3];
  const cdpOut = child.stdio[4];
  if (!cdpIn || !cdpOut) {
    throw new Error("Chrome did not receive pipe fds 3 and 4 for Extensions.loadUnpacked.");
  }
  const id = 1337;
  const request = { id, method: "Extensions.loadUnpacked", params: { path: path.resolve(absPath) } };
  let pending = "";
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extensions.loadUnpacked timed out after 20s")), 20_000);
    const onData = (chunk) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\x00");
      while (end !== -1) {
        const whole = pending.slice(0, end);
        pending = pending.slice(end + 1);
        end = pending.indexOf("\x00");
        try {
          const msg = JSON.parse(whole);
          if (msg.id === id) {
            clearTimeout(timer);
            cdpOut.off("data", onData);
            resolve(msg);
          }
        } catch {
          // ignore incomplete frames
        }
      }
    };
    cdpOut.on("data", onData);
    cdpOut.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    cdpIn.write(JSON.stringify(request) + "\x00");
  });
  if (response.error) {
    throw new Error("Extensions.loadUnpacked failed: " + JSON.stringify(response.error));
  }
  if (!response.result?.id) {
    throw new Error("Extensions.loadUnpacked returned no extension id: " + JSON.stringify(response));
  }
  return response.result.id;
}

async function waitForCdpPort() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version");
      if (res.ok) return res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Chrome DevTools port 9222 never came up");
}

async function snap(page, name) {
  const dest = path.join(outDir, name);
  try {
    await page.screenshot({ path: dest, fullPage: true, timeout: 8_000 });
  } catch {
    try {
      await page.screenshot({ path: dest, fullPage: false, timeout: 5_000 });
    } catch (error) {
      result.screenshotErrors = result.screenshotErrors || [];
      result.screenshotErrors.push({ name, error: String(error && (error.message || error)) });
    }
  }
}

async function readAvailability(page) {
  return page.evaluate(async () => {
    if (!("LanguageModel" in self)) return { present: false };
    const textOnly = {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    };
    const withImage = {
      expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    };
    try {
      return {
        present: true,
        textOnly: await LanguageModel.availability(textOnly),
        withImage: await LanguageModel.availability(withImage),
      };
    } catch (error) {
      return { present: true, error: String(error && (error.message || error)) };
    }
  });
}

function attachLogs(page, bucket) {
  const cap = 40;
  const push = (line) => {
    result[bucket] = result[bucket] || [];
    if (result[bucket].length < cap) result[bucket].push(redact(line).slice(0, 400));
  };
  page.on("console", (msg) => {
    push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    push(`pageerror: ${String(err && (err.message || err))}`);
  });
}

async function readCheck(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return {
      label: document.querySelector(".source-label")?.textContent?.trim() || null,
      outcome: document.querySelector(".outcome")?.textContent?.trim() || null,
      headline: document.querySelector(".headline, .result h2")?.textContent?.trim() || null,
      consentShown: Boolean(document.querySelector("[data-action=consent-yes]")),
      usedSample: text.includes("prepared for this sample thread"),
      bodySnippet: text.slice(0, 1500),
    };
  });
}

function isTerminalCheck(state) {
  if (!state) return false;
  if (state.label || state.consentShown || state.usedSample) return true;
  const text = state.bodySnippet || "";
  return (
    text.includes("could not run") ||
    text.includes("not available in this environment") ||
    text.includes("On-device AI is not configured")
  );
}

async function waitForCheck(page, deadline, snapPrefix) {
  let lastSnap = 0;
  while (Date.now() < deadline) {
    const state = await readCheck(page);
    if (isTerminalCheck(state)) return state;
    if (Date.now() - lastSnap > 120_000) {
      await snap(page, `${snapPrefix}-progress-${Date.now()}.png`);
      lastSnap = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return readCheck(page);
}

async function screenshotInternals(context, name = "on-device-internals.png") {
  try {
    const internals = await context.newPage();
    await internals.goto("chrome://on-device-internals");
    await new Promise((r) => setTimeout(r, 2000));
    await snap(internals, name);
    await internals.close().catch(() => {});
  } catch (error) {
    result.internalsError = String(error && (error.message || error));
  }
}

const result = {
  startedAt: new Date().toISOString(),
  siteUrl,
  chromeBin,
};
let browser;
try {
  // Session 1: same Chrome flags and launch as nano-probe. Do not load the
  // extension yet. Download the text model into this profile first.
  chrome = launchChrome({ withExtension: false });
  result.version = await waitForCdpPort();
  if (result.version?.Browser) console.log("CHROME:", result.version.Browser);
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let context = browser.contexts()[0];
  let page = context.pages()[0] || (await context.newPage());

  // nano-probe's first availability() call was ~25s after Chrome start.
  // Calling the Prompt API too early can crash the on-device backend
  // ("Error loading backend") and leave availability() stuck on unavailable.
  console.log("Waiting for the on-device backend to start");
  await new Promise((r) => setTimeout(r, 25_000));
  await page.goto("http://127.0.0.1:8123/warmup", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.click("#go");
  const warmupDeadline = Date.now() + timeoutMs;
  let lastWarmupSnap = 0;
  while (Date.now() < warmupDeadline) {
    const state = await page.evaluate(() => window.__probe);
    if (state?.done) break;
    if (Date.now() - lastWarmupSnap > 120_000) {
      await snap(page, `warmup-progress-${Date.now()}.png`);
      lastWarmupSnap = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  result.warmup = await page.evaluate(() => {
    const probe = window.__probe || {};
    return {
      result: probe.result || null,
      availabilityBefore: probe.availabilityBefore || null,
      availabilityTextOnly: probe.availabilityTextOnly || null,
      availabilityWithImage: probe.availabilityWithImage || null,
      availabilityAfter: probe.availabilityAfter || null,
      createMs: probe.createMs || null,
      promptMs: probe.promptMs || null,
      answer: probe.answer || null,
      error: probe.error || null,
    };
  });
  await snap(page, "nano-warmup.png");
  console.log(
    "WARMUP:",
    result.warmup.result,
    "default=",
    result.warmup.availabilityBefore,
    "text=",
    result.warmup.availabilityTextOnly,
    "image=",
    result.warmup.availabilityWithImage,
    "after=",
    result.warmup.availabilityAfter,
  );
  await screenshotInternals(context, "on-device-internals-warmup.png");
  if (result.warmup.result !== "on-device-ok") {
    throw new Error("Nano warmup failed: " + (result.warmup.result || "timeout") + (result.warmup.error ? " " + result.warmup.error : ""));
  }

  await stopChrome(chrome, browser);
  chrome = null;
  browser = null;

  // Session 2: same profile, now with the unpacked extension if requested.
  chrome = launchChrome({ withExtension: wantExtension });
  if (wantExtension) {
    result.extensionId = await loadUnpacked(chrome, extensionDir);
    result.loadUnpacked = "ok";
    console.log("Loaded unpacked extension");
  }
  result.version = await waitForCdpPort();
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  context = browser.contexts()[0];
  page = context.pages()[0] || (await context.newPage());

  await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  attachLogs(page, "hostedConsole");
  await page.waitForSelector("[data-action=check]", { timeout: 30_000 });
  result.hostedAvailability = await readAvailability(page);
  console.log("HOSTED AVAILABILITY:", JSON.stringify(result.hostedAvailability));
  const dhl = page.locator('[data-thread="thread-1-carrier-lure"]');
  if (await dhl.count()) await dhl.click();
  await page.click("[data-action=check]");
  const hostedDeadline = Date.now() + Math.min(timeoutMs, 6 * 60_000);
  result.hosted = await waitForCheck(page, hostedDeadline, "hosted");
  await snap(page, "hosted-inbox.png");
  console.log("HOSTED LABEL:", result.hosted.label || "(none)");
  if (result.hosted.headline) console.log("HOSTED HEADLINE:", result.hosted.headline);
  if (result.hosted.outcome) console.log("HOSTED OUTCOME:", result.hosted.outcome);

  if (wantExtension && result.extensionId) {
    const fixture = await context.newPage();
    await fixture.goto("http://127.0.0.1:8123/", { waitUntil: "domcontentloaded" });
    await fixture.waitForSelector("h2.hP");
    await new Promise((r) => setTimeout(r, 1500));
    const panel = await context.newPage();
    attachLogs(panel, "extensionConsole");
    await panel.goto(`chrome-extension://${result.extensionId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
    });
    await panel.waitForSelector("[data-action=check]", { timeout: 30_000 });
    const ready = await panel
      .waitForFunction(
        () => {
          const btn = document.querySelector("[data-action=check]");
          return btn && !btn.hasAttribute("disabled") && (document.body.innerText || "").includes("GM123456789012345");
        },
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    result.extensionReady = ready;
    result.extensionAvailability = await readAvailability(panel);
    console.log("EXTENSION AVAILABILITY:", JSON.stringify(result.extensionAvailability));
    if (ready) {
      await panel.click("[data-action=check]");
      const extDeadline = Date.now() + Math.min(timeoutMs, 4 * 60_000);
      result.extension = await waitForCheck(panel, extDeadline, "extension");
    } else {
      result.extension = await readCheck(panel);
      result.extensionError = "Side panel did not receive the fixture email text.";
    }
    await snap(panel, "extension-sidepanel.png");
    await snap(fixture, "gmail-fixture.png");
    console.log("EXTENSION LABEL:", result.extension?.label || "(none)");
    if (result.extension?.headline) console.log("EXTENSION HEADLINE:", result.extension.headline);
  }

  await screenshotInternals(context, "on-device-internals.png");
} catch (error) {
  result.fatal = String(error && (error.stack || error));
  console.log(result.fatal);
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(outDir, "chrome.log"), redact(chromeLog).slice(-20000));
  await stopChrome(chrome, browser).catch(() => {});
  server.close();
}

const hostedOk =
  result.hosted?.label === "Checked on this device" &&
  result.hosted?.consentShown !== true &&
  result.hosted?.usedSample !== true;
const extensionOk =
  !wantExtension || result.extension?.label === "Checked on this device";
if (!hostedOk) {
  console.log("HOSTED CHECK FAILED: expected Checked on this device");
}
if (wantExtension && !extensionOk) {
  console.log("EXTENSION CHECK FAILED: expected Checked on this device");
}
process.exit(hostedOk && extensionOk ? 0 : 1);
